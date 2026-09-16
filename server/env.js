// Loads .env before anything else. MUST be the first import in index.js
// (2026-09-16 fix — see AGENTS.md): ES module imports are hoisted and fully
// evaluated, dependency-first, before the importing module's own body runs.
// dotenv.config() used to be a plain statement inside index.js's body,
// which only executes AFTER every one of index.js's imports (power-plan.js,
// anker-cloud.js, etc.) has already been evaluated — so any module-top-level
// `process.env.X` read in one of THOSE files always saw an empty
// process.env, silently falling back to its default no matter what .env
// said. Putting the dotenv.config() call inside its own module and
// importing THAT first works because sibling imports evaluate in the order
// they're written — this one runs, and finishes, before the next import
// (power-plan.js, etc.) is even loaded.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});
