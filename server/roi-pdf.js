import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Minimal no-dependency PDF writer for the ROI bill of materials: A4, core
// Helvetica fonts (WinAnsi), cached product JPEGs embedded natively via
// DCTDecode XObjects. buildBomPdf() returns the document as a Buffer.
const IMG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "roi-images");

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 50;
const IMG_BOX = 96; // pt square reserved for each product picture (~34 mm)
const BLOCK = 102; // pt per product row

// WinAnsi (CP1252) bytes for the characters outside plain Latin-1 that the
// BOM text uses (€, × is 0xD7 and ² is 0xB2 in Latin-1 already, dashes…).
const WINANSI = new Map([
  [0x20ac, 0x80], // €
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x2018, 0x91], // '
  [0x2019, 0x92], // '
  [0x201c, 0x93], // "
  [0x201d, 0x94], // "
  [0x2026, 0x85], // …
]);

// Encode a JS string as a PDF literal string in WinAnsi, escaping ( ) \.
function pdfStr(s) {
  const bytes = [];
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    let b;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) b = cp;
    else b = WINANSI.get(cp) ?? 0x3f; // "?"
    if (b === 0x28 || b === 0x29 || b === 0x5c) bytes.push(0x5c);
    bytes.push(b);
  }
  return `(${Buffer.from(bytes).toString("latin1")})`;
}

// Width/height from the JPEG SOF0/1/2 marker (needed for the XObject dict).
function jpegSize(buf) {
  let off = 2; // skip SOI
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return null;
}

function wrap(s, maxChars, maxLines = 3) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

const fmtEur = (v) =>
  `€${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function buildBomPdf({ bom, totalInvestedEur, snapshotDate, generatedAt = new Date() }) {
  // Keyed by asin (not row index) — rows now render from two separate
  // filtered sub-arrays (purchased / planned), not one flat pass over `bom`.
  const imagesByAsin = new Map();
  for (const item of bom) {
    if (imagesByAsin.has(item.asin)) continue;
    try {
      const data = fs.readFileSync(path.join(IMG_DIR, `${item.asin}.jpg`));
      const size = jpegSize(data);
      if (size) imagesByAsin.set(item.asin, { data, ...size });
    } catch {
      /* no cached image — rendered as a placeholder box */
    }
  }
  const imageAsins = [...imagesByAsin.keys()];
  const imgOpId = (asin) => imageAsins.indexOf(asin);

  const pages = [];
  let ops = [];
  let y = A4_H - MARGIN;
  const text = (x, yy, s, { font = "F1", size = 9, gray = 0 } = {}) => {
    ops.push(`BT ${gray} g /${font} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pdfStr(s)} Tj ET`);
  };
  const closePage = () => {
    const stamp = `Generated ${generatedAt.toISOString().replace("T", " ").slice(0, 19)} UTC · h0me-p0wer ROI`;
    text(MARGIN, 28, stamp, { size: 7.5, gray: 0.5 });
    pages.push(ops.join("\n"));
    ops = [];
    y = A4_H - MARGIN;
  };

  // Header.
  text(MARGIN, y, "h0me-p0wer — Bill of Materials (ROI)", { font: "F2", size: 15 });
  y -= 18;
  text(
    MARGIN,
    y,
    `Prices are purchase-price snapshots from ${snapshotDate} — what was paid, not today's price.`,
    { size: 9, gray: 0.35 },
  );
  y -= 22;

  const TX = MARGIN + IMG_BOX + 16; // text column x

  // A right-aligned "label: value" line under a horizontal rule — used for
  // both section subtotals and the closing grand total.
  const sumLine = (label, value, { size = 11 } = {}) => {
    if (y - 30 < MARGIN + 24) closePage();
    y -= 4;
    ops.push(`0.82 G 0.75 w ${MARGIN} ${y.toFixed(2)} m ${(A4_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
    y -= 16;
    const line = `${label}  ${fmtEur(value)}`;
    text(A4_W - MARGIN - line.length * (size * 0.555), y, line, { font: "F2", size });
    y -= 20;
  };

  const sectionHeader = (title) => {
    if (y - BLOCK < MARGIN + 24) closePage();
    text(MARGIN, y, title, { font: "F2", size: 12.5 });
    y -= 16;
  };

  const renderRows = (rows) => {
    for (let i = 0; i < rows.length; i++) {
      if (y - BLOCK < MARGIN + 24) closePage();
      const item = rows[i];
      const img = imagesByAsin.get(item.asin);
      const top = y;
      if (img) {
        const scale = Math.min(IMG_BOX / img.w, IMG_BOX / img.h);
        const w = img.w * scale;
        const h = img.h * scale;
        ops.push(
          `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN} ${(top - h).toFixed(2)} cm /Im${imgOpId(item.asin)} Do Q`,
        );
      } else {
        ops.push(`0.92 g ${MARGIN} ${(top - IMG_BOX).toFixed(2)} ${IMG_BOX} ${IMG_BOX} re f 0 g`);
      }
      let ty = top - 10;
      for (const line of wrap(item.name, 68, 2)) {
        text(TX, ty, line, { font: "F2", size: 10 });
        ty -= 12;
      }
      ty -= 2;
      if (item.desc) {
        for (const line of wrap(item.desc, 88, 2)) {
          text(TX, ty, line, { size: 9, gray: 0.25 });
          ty -= 11;
        }
      }
      ty -= 2;
      text(
        TX,
        ty,
        `${item.qty} × ${fmtEur(item.unitPriceEur)}  =  ${fmtEur(item.lineTotalEur)}${item.estimated ? "    (~ estimated price)" : ""}`,
        { size: 9 },
      );
      ty -= 12;
      text(TX, ty, item.url, { size: 7.5, gray: 0.45 });
      y = top - BLOCK;
    }
  };

  // Three sections: what's actually been bought (subtotal = totalInvestedEur,
  // matching the ROI tab's "Total invested"), what's planned but not bought
  // yet (its own subtotal), and a grand total across both (2026-09-19, user
  // request — mirrors the ROI tab's "Investment" / "Extended" card split).
  const mainRows = bom.filter((r) => r.category !== "extended");
  const extendedRows = bom.filter((r) => r.category === "extended");
  const extendedSubtotalEur = extendedRows.reduce((a, r) => a + r.lineTotalEur, 0);

  sectionHeader("Purchased (bill of materials)");
  renderRows(mainRows);
  sumLine("Subtotal:", totalInvestedEur);

  if (extendedRows.length) {
    y -= 6;
    sectionHeader("Planned (not yet purchased)");
    renderRows(extendedRows);
    sumLine("Subtotal:", extendedSubtotalEur);
  }

  y -= 6;
  sumLine("Grand total:", totalInvestedEur + extendedSubtotalEur, { size: 13 });
  closePage();

  // Object ids: 1 catalog, 2 pages, 3/4 fonts, then per page (page, content),
  // then one image XObject per distinct asin with a cached picture.
  const P = pages.length;
  const pageId = (p) => 5 + p;
  const contentId = (p) => 5 + P + p;
  const imageId = (i) => 5 + 2 * P + i;

  const xobjDict = imageAsins.map((_, i) => `/Im${i} ${imageId(i)} 0 R`).join(" ");
  const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${xobjDict ? ` /XObject << ${xobjDict} >>` : ""} >>`;

  const objects = [];
  objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  objects.push(
    Buffer.from(
      `<< /Type /Pages /Kids [${pages.map((_, p) => `${pageId(p)} 0 R`).join(" ")}] /Count ${P} >>`,
      "latin1",
    ),
  );
  objects.push(
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "latin1"),
  );
  objects.push(
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
      "latin1",
    ),
  );
  for (let p = 0; p < P; p++) {
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] /Resources ${resources} /Contents ${contentId(p)} 0 R >>`,
        "latin1",
      ),
    );
  }
  for (let p = 0; p < P; p++) {
    const content = Buffer.from(pages[p], "latin1");
    objects.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"),
        content,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }
  imageAsins.forEach((asin, i) => {
    const img = imagesByAsin.get(asin);
    objects[imageId(i) - 1] = Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`,
        "latin1",
      ),
      img.data,
      Buffer.from("\nendstream", "latin1"),
    ]);
  });
  for (let i = 0; i < objects.length; i++) {
    if (!objects[i]) objects[i] = Buffer.from("<<>>", "latin1");
  }

  // Assemble with a real xref table.
  const header = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1");
  const parts = [header];
  const offsets = [];
  let pos = header.length;
  objects.forEach((body, i) => {
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    offsets.push(pos);
    parts.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  parts.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(parts);
}
