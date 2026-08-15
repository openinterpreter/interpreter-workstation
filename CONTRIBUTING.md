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

## Developer Certificate of Origin

Interpreter Workstation uses the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) and
does not require a contributor license agreement. Sign off every commit with:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Git can add the line for you with `git commit -s`. By signing off, you certify
that you have the right to submit the contribution under this repository's
Apache 2.0 license. The project does not ask contributors to assign copyright
or grant a separate right to relicense their work. Pull requests are checked
automatically and cannot merge while any non-merge commit lacks a valid
`Signed-off-by` trailer.

Do not submit credentials, proprietary SDKs, paid license files, customer data,
or code you do not have the right to contribute.
