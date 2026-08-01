# Interpreter Workstation

Interpreter is an open-source desktop agent for knowledge work. It puts the
Open Interpreter runtime behind a native desktop interface, then adds local
tools for files, browsers, voice, and computer use.

The community build works without an Interpreter account. You can connect your
own supported model provider, use a local model, and choose where the agent is
allowed to work. Organizations can build a configured distribution from the
same source without maintaining a private fork.

## Architecture

- [Open Interpreter](https://github.com/openinterpreter/openinterpreter) owns
  the agent runtime, harnesses, provider/model discovery, and app-server
  protocol.
- This repository owns the Electron shell, user experience, local policy, and
  workstation tools.
- Model-facing app tools use the `interpreter-app` command-line contract. The
  desktop app does not maintain a second provider or harness implementation.
- The browser extension and computer-use driver are pinned Git submodules so a
  desktop release is reproducible while their independent release histories are
  preserved.

## Requirements

- Node.js 22 (see `.nvmrc`)
- pnpm 9
- Bun
- Rust stable and Cargo
- Git with submodule support

## Build from source

```bash
git clone --recurse-submodules https://github.com/openinterpreter/interpreter-workstation.git
cd interpreter-workstation
pnpm install
pnpm run download:oix -- --current-platform
pnpm run download:pdfcpu -- --current-platform
pnpm run download:qwen-asr -- --current-platform
pnpm run build
pnpm start
```

The default product configuration is the account-optional community
distribution. Its hosted account, hosted API, telemetry, and external document
engine fields are empty.

## Development

```bash
pnpm dev
pnpm typecheck
pnpm run test:unit
pnpm run test:vitest
pnpm test
```

`pnpm test` also builds the app and runs Electron end-to-end coverage. Voice and
live-provider tests are opt-in because they require platform assets or external
services.

The browser extension can be bootstrapped and verified independently:

```bash
pnpm run extension:bootstrap
pnpm run extension:verify
```

## Distributions

Product-specific hosted services are configuration, not a separate application.
Use the distribution wrapper to build with a JSON overlay:

```bash
node scripts/with-distribution-config.mjs ./path/to/product.overlay.json -- pnpm run build
```

See [Distribution builds](docs/distributions.md) for the schema, security
boundary, and packaging model.

## Document workflows

Interpreter's primary document workflow is code execution plus skills. A
compatible external document engine can optionally provide rich embedded
editing and format conversion. It is not bundled with the community source.
See [Document engines](docs/document-engine.md).

## Enterprise deployment

The application is designed to be deployable as an organization's primary AI
workstation: account-optional, provider-configurable, policy-aware, and buildable
from one canonical source tree. See [Enterprise deployment](docs/enterprise-deployment.md)
for the current controls and the remaining production-hardening checklist.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not put credentials in product overlays or commit local `.env` files.

## License

Interpreter Workstation is licensed under the [Apache License 2.0](LICENSE).
Pinned dependencies and submodules retain their own licenses and notices. Read
[Dependency licensing](docs/dependency-licensing.md) before distributing a
packaged binary.
