#!/usr/bin/env bun
/**
 * Generates TypeScript types, JSON schemas, and compiled validators
 * from a codex binary. Used by download-oix.mjs and ensure-codex-generated-types.mjs.
 *
 * Usage: bun scripts/generate-codex-schemas.ts <path-to-codex-binary>
 */

import { $ } from "bun";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const ROOT = join(dirname(import.meta.dir), ".");
const SCHEMAS_DIR = join(ROOT, "server", "handlers", "codex-generated-types");

const binaryPath = process.argv[2];
if (!binaryPath || !existsSync(binaryPath)) {
  console.error(
    `Usage: bun scripts/generate-codex-schemas.ts <path-to-codex-binary>`,
  );
  if (binaryPath) console.error(`Binary not found: ${binaryPath}`);
  process.exit(1);
}

rmSync(SCHEMAS_DIR, { recursive: true, force: true });
mkdirSync(SCHEMAS_DIR, { recursive: true });

const jsonSchemasDir = join(SCHEMAS_DIR, "json");

await $`${binaryPath} app-server generate-ts --out ${SCHEMAS_DIR}`.quiet();
console.log(
  "TypeScript types written to server/handlers/codex-generated-types/",
);

await $`${binaryPath} app-server generate-json-schema --out ${jsonSchemasDir}`.quiet();
console.log(
  "JSON schemas written to server/handlers/codex-generated-types/json/",
);

console.log("Running validator compilation...");
await $`bun run schema:validators`.cwd(ROOT);
console.log("Validator compilation completed");

// Generated protocol files are outside git and can change without TypeScript's
// incremental graph noticing. Invalidate both caches so the next normal
// `pnpm typecheck` cannot incorrectly reuse a graph built against an older OIX
// contract.
rmSync(join(ROOT, ".tsbuildinfo"), { force: true });
rmSync(join(ROOT, ".tsbuildinfo-electron"), { force: true });
