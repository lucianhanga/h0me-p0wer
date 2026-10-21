export function parseSpan(req, res) {
  const to = Math.min(Number(req.query.to ?? Date.now()), Date.now());
  const from = Number(req.query.from ?? to - 24 * 3600 * 1000);
  if (!(from < to)) {
    res.status(400).json({ ok: false, error: "from must be before to" });
    return null;
  }
  return { from, to };
}
