# Dependency licensing

Interpreter Workstation's own source is Apache-2.0. Third-party packages,
submodules, downloaded runtimes, models, and optional document engines retain
their own licenses. A source license is not a substitute for reviewing the
contents of a packaged desktop binary.

Before publishing a release:

1. Generate the production dependency inventory from the frozen lockfile.
2. Include every required license and attribution in the packaged notices.
3. Review copyleft, model-weight, codec, native-runtime, and optional integration
   obligations for every target platform.
4. Archive the exact source and lockfile corresponding to the shipped binary.

The main CI workflow runs `pnpm run release:licenses` from the frozen
installation and uploads `production-license-inventory.json`. Treat that
artifact as review input, not as a substitute for the packaged-binary review:
downloaded runtimes, native libraries, submodules, models, and optional
integrations keep their own notices and may not appear in the pnpm inventory.

Known items requiring explicit release review:

- The current WhatsApp implementation uses Baileys, whose dependency graph
  includes `libsignal` under GPL-3.0. Baileys' maintainers explicitly identify
  this as a licensing issue they intend to remove. A distributor must either
  satisfy the applicable GPL obligations or decouple/replace this connector
  before treating an Apache-only binary policy as satisfied.
- HEIC support and Sharp's native image stack include LGPL components. Preserve
  their notices and verify the packaged linking/replacement obligations.
- `buffers@0.1.1` omits license metadata in its npm tarball. Upstream history and
  Debian's source record identify it as MIT; preserve that evidence and notice
  or replace the dependency during release hardening.
- The browser extension and computer-use submodules carry independent MIT
  licenses and preserved upstream histories.

Current production audit notes (2026-07-31):

- `pnpm audit --prod` reports `brace-expansion` as high severity through
  ExcelJS. The lockfile pins the maintained 1.x, 2.x, and 5.x patched releases
  (`1.1.18`, `2.1.4`, and `5.0.9`); the 1.x and 2.x packages contain the
  `maxLength` mitigation for CVE-2026-14257, but the registry advisory's
  `patched_versions` metadata only recognizes the 5.x line.
- A moderate `file-type@16.5.4` advisory remains under nut.js/Jimp. The fixed
  `file-type` release is a breaking ESM/API upgrade that cannot be forced into
  this dependency chain safely. Keep untrusted file-type detection away from
  the main process and replace or upgrade this chain before a hardened binary
  release.
- A low resource-consumption advisory remains in `@ai-sdk/provider-utils`.
  The current compatible 3.x line has no registry-recognized patched release.
  Recheck this at every lockfile update.

This file records engineering findings, not legal advice. Enterprise release
owners should make and document the final distribution decision.
