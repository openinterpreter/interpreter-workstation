import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  OIX_DIR_NAME,
  PINNED_VERSION,
  getArchiveConfig,
  getDownloadUrl,
  getPlatformKey,
  getPlatformsToDownload,
  isSameResolvedPath,
  parseArgs,
} from "../../scripts/download-oix.mjs";

describe("download-oix helpers", () => {
  test("maps supported app platforms to public OIX package assets", () => {
    assert.deepEqual(getArchiveConfig("darwin-arm64"), {
      target: "aarch64-apple-darwin",
      asset: "open-interpreter-package-aarch64-apple-darwin.tar.gz",
      checksumAsset: "codex-package_SHA256SUMS",
      interpreterPath: "bin/interpreter",
    });
    assert.deepEqual(getArchiveConfig("linux-x64"), {
      target: "x86_64-unknown-linux-musl",
      asset: "open-interpreter-package-x86_64-unknown-linux-musl.tar.gz",
      checksumAsset: "codex-package_SHA256SUMS",
      interpreterPath: "bin/interpreter",
    });
    assert.deepEqual(getArchiveConfig("win32-x64"), {
      target: "x86_64-pc-windows-msvc",
      asset: "open-interpreter-package-x86_64-pc-windows-msvc.tar.gz",
      checksumAsset: "codex-package_SHA256SUMS",
      interpreterPath: "bin/interpreter.exe",
    });
  });

  test("selects all platforms or one requested platform", () => {
    assert.deepEqual(getPlatformsToDownload({ currentPlatformOnly: false }), [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    assert.deepEqual(getPlatformsToDownload({ requestedPlatform: "win32-x64" }), ["win32-x64"]);
    assert.deepEqual(
      getPlatformsToDownload({ currentPlatformOnly: true, currentPlatformKey: "darwin-arm64" }),
      ["darwin-arm64"],
    );
  });

  test("rejects unsupported platform keys", () => {
    assert.throws(
      () => getPlatformsToDownload({ requestedPlatform: "freebsd-x64" }),
      /No OIX runtime available for platform: freebsd-x64/,
    );
  });

  test("builds direct GitHub release URLs from pinned version and asset", () => {
    const config = getArchiveConfig("win32-x64");
    assert.ok(config);
    assert.equal(
      getDownloadUrl(PINNED_VERSION, config.asset),
      `https://github.com/openinterpreter/openinterpreter/releases/download/${PINNED_VERSION}/open-interpreter-package-x86_64-pc-windows-msvc.tar.gz`,
    );
  });

  test("detects CLI entrypoint paths with Windows path semantics", () => {
    const windowsScriptPath = "C:\\actions-runner\\iworkstation\\iworkstation\\scripts\\download-oix.mjs";
    assert.equal(isSameResolvedPath(windowsScriptPath, windowsScriptPath, path.win32), true);
    assert.equal(
      isSameResolvedPath(windowsScriptPath, "C:\\actions-runner\\iworkstation\\iworkstation\\scripts\\other.mjs", path.win32),
      false,
    );
  });

  test("parses CLI arguments like download-codex", () => {
    assert.deepEqual(parseArgs(["--current-platform"]), {
      version: PINNED_VERSION,
      currentPlatformOnly: true,
      requestedPlatform: undefined,
    });
    assert.deepEqual(parseArgs(["rust-v0.0.33", "--platform", "linux-x64"]), {
      version: "rust-v0.0.33",
      currentPlatformOnly: false,
      requestedPlatform: "linux-x64",
    });
  });

  test("uses resources/oix as output root and node platform arch keys", () => {
    assert.equal(OIX_DIR_NAME, "oix");
    assert.equal(getPlatformKey("darwin", "arm64"), "darwin-arm64");
    assert.equal(getPlatformKey("win32", "x64"), "win32-x64");
  });
});
