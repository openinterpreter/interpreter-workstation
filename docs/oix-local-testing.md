# Test OIX changes locally

Workstation consumes the public unified OIX runtime package. The pinned release
and archive contract live in `scripts/download-oix.mjs`; normal builds should
not depend on a neighboring source checkout or the legacy `oix` gitlink.

The checked-out OIX source is an upstream product boundary. It is safe to read
or build it, but do not patch it as part of a Workstation change. If OIX itself
needs a change, make and review that change in its own repository and then bump
Workstation's release pin after it ships.

## 1. Verify the pinned public runtime

From the Workstation app root:

```bash
pnpm run download:oix -- --current-platform
resources/oix/"$(node -p 'process.platform + "-" + process.arch')"/bin/interpreter --version
pnpm run test:interpreter:smoke
```

The smoke test exercises the same `interpreter app-server` entrypoint the
Electron app launches.

## 2. Build a local OIX checkout without modifying it

Point `OIX_CHECKOUT` at an Open Interpreter checkout. The commands below only
build and read it.

```bash
OIX_CHECKOUT=/absolute/path/to/openinterpreter
cd "$OIX_CHECKOUT/codex-rs"
env CARGO_INCREMENTAL=0 cargo test -p codex-app-server
env CARGO_INCREMENTAL=0 cargo build -p codex-cli --bin codex
```

Adjust the test package or filter for the contract being changed. Provider,
model, harness, thread, steering, approval, and history changes should be
covered at the app-server boundary.

## 3. Overlay the locally built executable

First download the pinned package so its `codex-path`, `codex-resources`, helper
binaries, and metadata are present. Then point only the unified executable at
the local build:

```bash
cd /absolute/path/to/workstation/app
pnpm run download:oix -- --current-platform

OIX_CHECKOUT=/absolute/path/to/openinterpreter
platform="$(node -p 'process.platform + "-" + process.arch')"
ln -sf "$OIX_CHECKOUT/codex-rs/target/debug/codex" \
  "resources/oix/$platform/bin/interpreter"
```

On Windows, use `codex.exe` and `interpreter.exe`. The symlink is a local test
artifact; do not commit `resources/oix`.

## 4. Test Workstation against the local build

```bash
pnpm run test:interpreter:smoke
resources/oix/"$(node -p 'process.platform + "-" + process.arch')"/bin/interpreter app-server --help
pnpm run test:unit
```

For manual desktop testing, keep the local executable overlay and run:

```bash
pnpm dev
```

To return to the pinned public runtime, remove the current platform's runtime
directory and rerun the downloader:

```bash
platform="$(node -p 'process.platform + "-" + process.arch')"
rm -rf "resources/oix/$platform"
pnpm run download:oix -- --current-platform
```

## 5. Ship an OIX release bump

After the OIX change is published:

1. Update `PINNED_VERSION` in `scripts/download-oix.mjs`.
2. Regenerate the app-server schemas with the downloaded unified runtime.
3. Run the packaging, contract, integration, and Electron smoke tests.
4. Commit the generated protocol changes and the release pin together.

Do not move the legacy `oix` gitlink as a substitute for updating the runtime
release pin. Workstation's production boundary is the downloaded, checksummed
package.
