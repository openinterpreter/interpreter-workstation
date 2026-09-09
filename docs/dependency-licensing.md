# Dependency licensing

Interpreter Workstation's own source is Apache-2.0. Third-party packages,
submodules, downloaded runtimes, models, and optional document engines retain
their own licenses. A source license is not a substitute for reviewing the
contents of a packaged desktop binary.

Before publishing a release:

1. Generate the production dependency inventory from the frozen lockfile.
2. Run `pnpm run release:licenses:check` against that exact inventory. This
   fails on an unreviewed unknown, GPL-containing, or LGPL package.
3. Verify the packaged app contains its `licenses/` resource directory.
4. Review model-weight, codec, downloaded native-runtime, and optional integration
   obligations for every target platform.
5. Archive the exact source and lockfile corresponding to the shipped binary.

The main CI workflow runs `pnpm run release:licenses` from the frozen
installation and uploads `production-license-inventory.json`. Treat that
artifact as review input. CI then checks it against
`licenses/release-policy.json`. This is not a substitute for reviewing every
packaged-binary input:
downloaded runtimes, native libraries, submodules, models, and optional
integrations keep their own notices and may not appear in the pnpm inventory.

Known items requiring explicit release review:

- The current WhatsApp implementation aliases the Baileys API to
  `@oxidezap/baileyrs@0.0.32` (MIT), which uses
  `whatsapp-rust-bridge@0.6.0-alpha.42` (MIT). Its Signal-protocol code comes
  from the MIT-licensed `oxidezap/whatsapp-rust` implementation; it is not the
  GPL `@whiskeysockets/libsignal-node` package used by older Baileys releases.
  Preserve the npm and upstream Rust notices and audit the shipped native/WASM
  artifacts at every bridge update, because the pnpm inventory does not inspect
  licenses embedded inside prebuilt binaries.
- Platform packages matching `@img/sharp-libvips-*` appear in two reviewed
  places: optional 1.3.3 packages in pnpm's conservative app inventory and a
  platform-specific 1.2.4 package in the generated browser-relay runtime. Both
  are LGPL-3.0-or-later. Every app packages exact-version upstream component
  notices, LGPL/GPL text, and corresponding-source links. Release checks inspect
  both dependency trees and fail if another LGPL package or version appears
  without review. Shared libraries remain dynamically loaded and replaceable
  outside ASAR.
- `buffers@0.1.1` omits license metadata in its npm tarball. The release policy
  resolves it to MIT using Debian's reviewed source record and upstream commit,
  and the complete MIT notice is packaged. Any additional `Unknown` entry fails
  CI.
- JSZip 3.10.1 is used under its MIT option. node-forge 1.4.0 is used under its
  BSD-3-Clause option. Their complete selected notices are packaged; CI fails if
  either package or license expression drifts.
- The browser extension and computer-use submodules carry independent MIT
  licenses and preserved upstream histories.

Current production audit notes (2026-08-05):

- `pnpm audit --prod` reports zero critical or high-severity findings.
- A moderate `file-type@16.5.4` advisory remains under nut.js/Jimp. The fixed
  `file-type` release is a breaking ESM/API upgrade that cannot be forced into
  this dependency chain safely. Keep untrusted file-type detection away from
  the main process and replace or upgrade this chain before a hardened binary
  release.
- The lockfile forces Hono 4.12.34 or newer within the current 4.x line to close
  the CORS preflight ReDoS advisory inherited through the MCP SDK.
- A low resource-consumption advisory remains in `@ai-sdk/provider-utils`.
  The current compatible 3.x line has no registry-recognized patched release.
  Recheck this at every lockfile update.

This file records engineering findings, not legal advice. Enterprise release
owners should make and document the final distribution decision.
