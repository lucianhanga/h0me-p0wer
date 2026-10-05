#!/usr/bin/env node
// Manual API token generator (2026-10-05, user request — "I will generate
// a token manually with a commandline tool... limited to 4w... renewal
// for now can be manual"). Prints a new token + its expiry; paste both
// lines into .env yourself and restart the server — this tool never
// writes to .env directly, so it can't clobber unrelated config or
// mangle comments/formatting there.
//
// Run: node server/generate-token.js   (or: npm run token:generate)

import crypto from "node:crypto";

const FOUR_WEEKS_MS = 4 * 7 * 24 * 3600 * 1000;

const token = crypto.randomBytes(24).toString("base64url");
const expiresAt = new Date(Date.now() + FOUR_WEEKS_MS).toISOString();

console.log(`New API token — valid until ${expiresAt} (4 weeks from now)\n`);
console.log(`API_TOKEN=${token}`);
console.log(`API_TOKEN_EXPIRES_AT=${expiresAt}`);
console.log(`\nPaste both lines into .env (replacing any existing API_TOKEN /`);
console.log(`API_TOKEN_EXPIRES_AT lines there), then restart the server.`);
console.log(`\nTo renew before/after expiry, just re-run this and repeat.`);
console.log(`\nWeb dashboard: open it once with ?token=${token} appended to the`);
console.log(`URL — the browser remembers it after that (localStorage); no need`);
console.log(`to keep it in the address bar.`);
console.log(`\nGarmin watch app: set this same token in source/Config.mc`);
console.log(`(API_TOKEN) in the h0me-p0wer-garmin repo and rebuild/reinstall.`);
