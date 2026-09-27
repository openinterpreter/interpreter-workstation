# Schema-only Electron E2E outcomes

The `electron-e2e` CI job writes `electron-e2e-outcome.json` to a dedicated artifact and emits one `E2E_OUTCOME_V1` annotation. These are deliberately small diagnostics for locating a failing test without including test output. They do **not** replace the required E2E check, its exit status, or independent review.

The reporter emits only `schema: 1`, `completed` and `runnerSucceeded` booleans, nonnegative integer counts (`total`, `passed`, `failed`, `skipped`, `flaky`), up to 128 opaque lowercase-hex failed-test IDs, and a `truncated` boolean. It validates an exact closed schema before the annotation is emitted. A missing artifact produces only `{"schema":1,"artifactAvailable":false}`; this means the runner may have failed before Playwright reported results. `passed` follows Playwright's *expected* outcome (including any intentionally expected failure). An unexpected test outcome is counted as `failed`; failures outside a test are indicated by `runnerSucceeded: false` even when `failed` is zero.

IDs are fixed-length SHA-256 prefixes derived from Playwright's internal test ID with a fixed namespace; no title, path, error, stack, attachment, stdout, or environment value is included. This is a diagnostic correlation ID, not a security secret or proof of what went wrong. The reporter bounds test counts and recorded IDs. Do not add raw test metadata or captured output to this artifact or annotation.

Run `bun test tests/opaque-outcome-reporter.test.ts` for schema and injection checks; `INTERPRETER_E2E_OUTCOME_FILE=/tmp/e2e-outcome.json NODE_ENV=test pnpm exec playwright test tests/placeholder.spec.ts --project=smoke` exercises the actual reporter without starting an Electron conversation.
