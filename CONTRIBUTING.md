# Contributing

Thank you for helping improve Interpreter Workstation.

Before opening a change, read `AGENTS.md` and the subsystem documentation it
points to. Keep changes focused, preserve the OIX/runtime boundary, and include
tests that prove the real behavior being changed.

```bash
git submodule update --init --recursive
pnpm install
pnpm typecheck
pnpm run test:unit
pnpm run test:vitest
```

For Electron, browser-extension, voice, or computer-use changes, also run the
relevant end-to-end or platform smoke tests described in `docs/agent-testing.md`.

By contributing, you agree that your contribution is licensed under Apache 2.0.
Do not submit credentials, proprietary SDKs, paid license files, customer data,
or code you do not have the right to contribute.

