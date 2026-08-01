#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

const idx = process.argv.indexOf("--version");
if (idx === -1 || !process.argv[idx + 1]) {
  console.error("Usage: bun scripts/ci/set-version.ts --version <semver>");
  process.exit(2);
}
const version = process.argv[idx + 1];

const pkgPath = "./package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Set package.json version -> ${version}`);

