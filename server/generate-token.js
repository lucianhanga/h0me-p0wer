#!/usr/bin/env node
// Manual API token generator / renewer (2026-10-05, user request — "make
// me a nice script which I can call for the token (re)generation... warn
// me about the invalidation of the token if a new one is generated").
// Reads any existing API_TOKEN/API_TOKEN_EXPIRES_AT straight out of .env,
// warns before replacing a still-valid one (every client holding the old
// token — browser sessions, the Garmin watch app — stops working the
// moment the server restarts with the new value), then writes the new
// pair into .env itself (line-by-line replace/append, everything else in
// the file untouched).
//
// Run: node server/generate-token.js   (or: npm run token:generate)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const FOUR_WEEKS_MS = 4 * 7 * 24 * 3600 * 1000;

function readExistingToken() {
  if (!fs.existsSync(ENV_PATH)) return null;
  const lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  const token = lines.find((l) => l.startsWith("API_TOKEN="))?.slice("API_TOKEN=".length).trim();
  const expiresAt = lines
    .find((l) => l.startsWith("API_TOKEN_EXPIRES_AT="))
    ?.slice("API_TOKEN_EXPIRES_AT=".length)
    .trim();
  return token ? { token, expiresAt } : null;
}

// Replaces the two lines in place if they already exist (preserving
// position, every other line, comments); appends them otherwise. Never
// touches anything else in the file.
function writeToken(token, expiresAt) {
  const raw = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const lines = raw.length ? raw.split("\n") : [];
  let sawToken = false;
  let sawExpiry = false;
  const next = lines.map((line) => {
    if (line.startsWith("API_TOKEN=")) {
      sawToken = true;
      return `API_TOKEN=${token}`;
    }
    if (line.startsWith("API_TOKEN_EXPIRES_AT=")) {
      sawExpiry = true;
      return `API_TOKEN_EXPIRES_AT=${expiresAt}`;
    }
    return line;
  });
  if (!sawToken || !sawExpiry) {
    while (next.length && next[next.length - 1] === "") next.pop();
    next.push("");
    if (!sawToken) next.push(`API_TOKEN=${token}`);
    if (!sawExpiry) next.push(`API_TOKEN_EXPIRES_AT=${expiresAt}`);
  }
  fs.writeFileSync(ENV_PATH, next.join("\n") + "\n");
}

function mask(token) {
  return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : token;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  console.log(`${BOLD}h0me-p0wer — API token${RESET}\n`);

  if (!fs.existsSync(ENV_PATH)) {
    console.log(`${YELLOW}No .env found at ${ENV_PATH} — copy .env.example to .env first${RESET}`);
    console.log(`${YELLOW}if this app isn't otherwise configured yet. Continuing anyway —${RESET}`);
    console.log(`${YELLOW}this will create .env with just the token fields.${RESET}\n`);
  }

  const existing = readExistingToken();
  if (existing) {
    const expiresMs = Date.parse(existing.expiresAt ?? "");
    const stillValid = Number.isFinite(expiresMs) && expiresMs > Date.now();
    if (stillValid) {
      const daysLeft = Math.ceil((expiresMs - Date.now()) / 86400000);
      console.log(
        `${YELLOW}${BOLD}Warning:${RESET}${YELLOW} a token is already configured ` +
          `(${mask(existing.token)}, ${daysLeft} day${daysLeft === 1 ? "" : "s"} left).${RESET}`,
      );
      console.log(`${YELLOW}Generating a new one INVALIDATES it the moment the server restarts.${RESET}`);
      console.log(`${YELLOW}Every client still holding the old token breaks until it's updated:${RESET}`);
      console.log(`${YELLOW}  - any browser that stored it — shows the "access token required" prompt again${RESET}`);
      console.log(`${YELLOW}  - the Garmin watch app (Config.API_TOKEN), until rebuilt and reinstalled${RESET}\n`);
    } else {
      console.log(`${YELLOW}The configured token (${mask(existing.token)}) has already expired — replacing it.${RESET}\n`);
    }
    const proceed = await confirm("Generate a new token and overwrite .env? [y/N] ");
    console.log("");
    if (!proceed) {
      console.log(`${RED}Cancelled — .env left unchanged.${RESET}`);
      process.exit(1);
    }
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + FOUR_WEEKS_MS).toISOString();

  try {
    writeToken(token, expiresAt);
  } catch (err) {
    console.log(`${RED}${BOLD}Failed to write .env:${RESET}${RED} ${err.message}${RESET}`);
    console.log(`\nPaste these two lines in by hand instead:\n`);
    console.log(`API_TOKEN=${token}`);
    console.log(`API_TOKEN_EXPIRES_AT=${expiresAt}`);
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}New token generated and saved to .env${RESET}${GREEN} — valid until ${expiresAt} (4 weeks).${RESET}\n`);
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log(`  1. Restart the server — .env is only read at startup.`);
  console.log(`  2. Open the dashboard once with ?token=${token} appended to the URL;`);
  console.log(`     the browser remembers it after that (localStorage).`);
  console.log(`  3. Garmin watch app: set the same value as API_TOKEN in`);
  console.log(`     source/Config.mc (h0me-p0wer-garmin repo), then rebuild and reinstall.`);
}

main();
