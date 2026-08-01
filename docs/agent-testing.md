# Testing

**Run tests:** `pnpm run typecheck && pnpm test` for the PR-default stack, `pnpm run test:voice` for the full voice suite, `pnpm run test:transcribe` for opt-in local Whisper transcription coverage, `pnpm run test:vitest` for renderer tests, `pnpm run test:e2e:ci` for the deterministic Electron suite, `pnpm run test:e2e:hosted:ci` for hosted-provider Electron coverage, `pnpm run test:e2e:voice:ci` for deterministic fake-voice coverage, or `pnpm run test:e2e:smoke` for the thin smoke subset. NEVER use `npx playwright test` directly.

**Voice coverage is opt-in.** Default `pnpm test`, `pnpm run test:unit`, and `pnpm run test:e2e` exclude `@voice` coverage.

## CI Voice Policy

Voice live tests do not run on every push/PR CI run. The `CI` workflow keeps voice coverage manual-only because provider/model downloads make default CI too slow.

To run the voice live-test matrix again for a branch/commit:

1. Open GitHub Actions and choose the `CI` workflow.
2. Click `Run workflow`.
3. Select the branch you want to verify.
4. Enable `run_voice_tests`.
5. Start the workflow.

If you touch voice mode, STT, TTS, qwen, Moonshine, or model install/download flows, you must run:

```bash
pnpm run download:qwen-asr -- --current-platform
pnpm run test:voice
```

## Local Transcription Policy

Local transcription tests do not run in default CI or `pnpm test`. They download a local Whisper model through app-side `builtin-transcribe download_model`, generate a speech WAV locally on macOS or Windows, and run `transcribe_audio` against it.

Run them manually when changing `builtin-transcribe`, the transcribe skill, local transcription model download behavior, or app-side transcription install paths:

```bash
pnpm run test:transcribe
```

Useful direct commands:

```bash
pnpm run test:e2e -- --grep "pattern"
pnpm run test:e2e:voice
pnpm run test:unit:voice
```

## Browser Form Tests

Use the browser form harness when you touch browser control, relay startup/staging, the bundled `js_repl` Playwright path, or the app-managed extension runtime.

Run it from the repo root:

```bash
pnpm run browser-form-tests:auto
pnpm run browser-form-tests:auto -- --test contact-intake
pnpm run browser-form-tests:auto -- --skip-setup --browser-headless
```

Key points:

- This is the app-level browser-control E2E harness. It is not the same as `form-tests` and it is not a replacement for `pnpm run extension:test:integration`.
- It uses `pnpm headless`, not `pnpm dev`, so the harness owns the relay and the task runtime in one reproducible flow.
- It writes artifacts under `browser-form-tests/test-output/<timestamp>--<id>/`.
- If your own Chrome extension session is attached at the same time, the cleanest run is still to disconnect it first. The harness now reads `/extensions/status` and targets the live managed session key automatically.
- The detailed harness contract, options, and artifact guide live in `browser-form-tests/README.md`.

## Computer Use Verification

Use the CUA suite when you touch `builtin-cua-driver`, bundled
computer-use skills, TryCUA patches, Windows UIA/HWND behavior, or
web-app/browser CUA routing.

```bash
pnpm run test:cua
pnpm run winvm:workspace:run -- "pnpm run test:cua"
```

Agent E2E is the acceptance layer: it asks an agent to fill/control a
real app and grades state. Direct `interpreter-app tools
builtin-cua-driver ...` smokes are diagnostics only. The full contract
and per-platform commands live in [cua-verification.md](cua-verification.md).

**Location:**
- Renderer/UI tests: `src/**/*.ui.test.tsx`
- Bun unit tests: `src/**/*.test.ts`, `agent/**/*.test.ts`, `shared/**/*.test.ts`
- Electron smoke/integration tests: `tests/*.spec.ts`

**Auth:** Tests read tokens from `app.getPath('userData')/config.json`. If 401 errors, log into the app first.

**Layout State:** Fixtures clear `workstation.layout` before each test. After clearing, sidebar defaults to OPEN. Don't click the explorer button (it would close the sidebar). Just assert it's visible and use it.

---

## Test Port Isolation (CRITICAL)

**Tests MUST use dynamic ports. NEVER hardcode `localhost:5177`.**

Each Electron test instance gets a unique port (5177-5186). Tests must get the port from their own instance to avoid hitting a stale server from another instance.

**Correct Patterns:**

```typescript
import { getServerPort, setWorkspace, setWorkspaceWithRetry, apiCall } from './helpers';

// Setting workspace (most common)
await setWorkspace(page, '/path/to/workspace');

// With retry logic for server readiness
await setWorkspaceWithRetry(page, testWorkspacePath, 15);

// Generic API call
const result = await apiCall(page, 'POST', '/api/profiles/default', {
  profileId: 'builtin:fast'
});

// Manual port lookup (if needed)
const port = await getServerPort(page);
await page.evaluate(async (port: number) => {
  const res = await fetch(`http://localhost:${port}/api/whatever`, {...});
  return res.json();
}, port);
```

**WRONG (never do this):**

```typescript
// WRONG - hardcoded port could hit wrong server instance
await fetch('http://localhost:5177/api/workspace', {...});
```

---

## Test Pyramid

Prefer the fastest layer that can prove the behavior:

1. `pnpm run test:vitest`
   - Default for renderer behavior, stateful UI flows, settings panels, and mocked transport.
   - Use React Testing Library, `user-event`, `jest-dom`, and MSW.
2. `pnpm run test:unit`
   - Bun suite for pure TypeScript helpers and non-browser tests that have not moved to Vitest yet.
3. `pnpm run test:e2e:ci`
   - Deterministic Electron coverage for app flows that still need the full app shell.
4. `pnpm run test:e2e:hosted:ci`
   - Hosted-provider Electron coverage that exercises the managed runtime against real auth-backed CI config.
5. `pnpm run test:e2e:voice:ci`
   - Deterministic voice coverage using fake audio fixtures and no live providers.
6. `pnpm run test:e2e:smoke`
   - Thin Electron smoke for app boot, workspace/file paths, and basic settings/layout checks.
7. `pnpm run test:e2e:nightly`
   - qwen-backed voice and longer manual-style integration flows that are still outside the required PR path.

Rules:
- Start new renderer behavior coverage in Vitest, not Electron.
- Do not add required-PR tests that depend on live third-party providers.
- Do not add `page.waitForTimeout()` in new Playwright tests unless there is a documented runtime constraint.
- Prefer state-based waits, DOM assertions, and mocked network boundaries over fixed sleeps.

---

## Opening Files in Tests

Use `sel.fileEntryByName()` to find files/folders in the explorer:

```typescript
import { sel } from './selectors';

// Expand a folder (single click)
const folder = page.locator(sel.fileEntryByName('pdfs')).first();
await expect(folder).toBeVisible({ timeout: 10000 });
await folder.click();
await page.waitForTimeout(500);

// Open a file (single click via dispatchEvent — Playwright click() hangs on react-arborist)
const file = await waitForTreeItem(page, 'document.pdf');
await page.evaluate((dp: string) => {
  document.querySelector(`[data-path="${dp}"]`)?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true })
  );
}, await file.getAttribute('data-path'));
await page.waitForTimeout(500);
```

**Key patterns:**
1. Always wait for visibility before clicking: `await expect(element).toBeVisible()`
2. Use `.first()` since multiple elements may match
3. Single click opens files and toggles folders
4. **Use `dispatchEvent` for tree items** — Playwright's `click()` hangs on react-arborist nodes
5. Wait on resulting state changes, not fixed sleeps

---

## UI Error Checking for Model Messages (REQUIRED)

**Tests that send messages to an LLM MUST check for "Something went wrong" errors.**

Don't just wait for the typing indicator to disappear - the UI might show an error! Use `waitForResponseWithErrorCheck()`:

```typescript
// BAD - doesn't catch UI errors
await expect(typingIndicator).toBeVisible({ timeout: 30000 });
await expect(typingIndicator).toBeHidden({ timeout: 120000 });

// GOOD - fails test if "Something went wrong" appears
await waitForResponseWithErrorCheck(page, typingIndicator, thread);
```

The helper uses `Promise.race` to detect errors:

```typescript
async function waitForResponseWithErrorCheck(
  page: Page,
  typingIndicator: Locator,
  thread: Locator,
  timeoutMs: number = 120000
): Promise<void> {
  const startResult = await Promise.race([
    typingIndicator.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'started'),
    thread.locator('text=Something went wrong').waitFor({ state: 'visible', timeout: 30000 }).then(() => 'error'),
    page.waitForTimeout(30000).then(() => 'timeout')
  ]);

  if (startResult === 'error') {
    throw new Error('UI showed "Something went wrong" - stream validation likely failed');
  }
  if (startResult === 'timeout') {
    throw new Error('No response started within 30 seconds');
  }

  const endResult = await Promise.race([
    typingIndicator.waitFor({ state: 'hidden', timeout: timeoutMs }).then(() => 'completed'),
    thread.locator('text=Something went wrong').waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'error')
  ]);

  if (endResult === 'error') {
    throw new Error('UI showed "Something went wrong" during response - stream validation failed');
  }
}
```

---

## Logs

Two primary log artifacts per test:

| File | Purpose |
|------|---------|
| `{test-name}.log` | Full verbose log (backend, renderer, Playwright) |
| `{test-name}.agent-events.jsonl` | Structured agent transcript/debug events |

**Location:** `test-runs/{timestamp}/logs/`

### Filtered Agent Transcript

Do not treat `.agent.log` as the source of truth.

The source of truth is `{test-name}.agent-events.jsonl`. Render the clean agent transcript from that file with:

```bash
pnpm run agent:log -- test-runs/{timestamp}/logs/{test-name}.log
```

That command resolves the sibling `.agent-events.jsonl` automatically. If you want to write the rendered transcript back to disk:

```bash
pnpm run agent:log -- --write test-runs/{timestamp}/logs/{test-name}.log
```

This produces `{test-name}.agent.log` as a filtered view derived from the event log.

The rendered transcript contains the clean agent-facing view:

```xml
<system>
<tools>
<user>
<reasoning>
<assistant>
<tool_call name="...">
<tool_result name="...">
<tool_error name="...">
<subagent name="...">
  <system>
  <user>
  <reasoning>
  <assistant>
  <tool_call name="...">
  <tool_result name="...">
</subagent>
```

**Debug failures:** For tool/infrastructure issues, use the verbose `.log`. For agent behavior issues, inspect `.agent-events.jsonl` directly or render the filtered transcript with `pnpm run agent:log`.

## Flake Scan

To stress the full Electron E2E suite repeatedly, run:

```bash
./run-e2e-5x.sh
./run-e2e-5x.sh 2 5
```

The script writes per-run logs and a summary file under `/tmp/e2e-flake-scan/`.

To stress the unit suite repeatedly, run:

```bash
./run-unit-5x.sh
./run-unit-5x.sh 2 5
```

The script writes per-run logs and a summary file under `/tmp/unit-flake-scan/`.

---

## Browser Automation Testing

**Puppeteer MCP is unreliable.** Use **Claude in Chrome MCP** instead.

1. Install the Claude in Chrome extension
2. The MCP tools (`mcp__claude-in-chrome__*`) will be available
3. Use `tabs_context_mcp` first to get available tabs

**Key tools:**
- `tabs_context_mcp` - Get current tabs (call this first)
- `navigate` - Go to a URL
- `computer` - Screenshots, clicks, drags, typing
- `find` - Find elements by natural language query
- `read_page` - Get accessibility tree
- `javascript_tool` - Execute JS in page context

---

## Element IDs - Type-Safe Selectors

**Lint: `pnpm run lint:selectors`** (included in `pnpm run lint`)

### Architecture

`shared/element-ids.ts` is a **pure strings file with NO imports**. It defines ALL IDs directly. Components import FROM it.

```
shared/element-ids.ts (defines)  →  Components (import & use)  →  Tests (use sel())
────────────────────────────────────────────────────────────────────────────────────
export const MY_ID = 'my-id'        import { MY_ID } from ...     sel('myId')
export const ELEMENT_IDS = {        <div data-testid={MY_ID}/>
  myId: MY_ID
}
```

### Lint Enforces 4 Checks:
1. **Tests** must use `sel('key')` or `sel.method(arg)` - no raw strings
2. **selectors.ts** methods must reference `ELEMENT_IDS` - no hardcoded strings
3. **Components** must use constants for `data-testid` - no raw strings
4. **All IDs** in element-ids.ts must be USED in at least one component

### Adding New Selectable Elements

1. Define in `shared/element-ids.ts`:
   ```typescript
   export const MY_BUTTON_ID = 'my-button' as const;
   export const ELEMENT_IDS = { myButton: MY_BUTTON_ID, ... };
   ```

2. Import in component:
   ```typescript
   import { MY_BUTTON_ID } from '../../shared/element-ids';
   <button data-testid={MY_BUTTON_ID} />
   ```

3. Use in test: `sel('myButton')`

---

## Windows VM Debugging

Connect to the Windows VM with port forwarding for debugging:

```bash
ssh -L 38123:localhost:38123 -L 3000:localhost:3000 \
  "${INTERPRETER_WINDOWS_VM_USER}@${INTERPRETER_WINDOWS_VM_HOST}"
```

### If SSH is not available

1. **Open port 22 in Azure NSG:**
   ```bash
   az vm open-port \
     --resource-group "$INTERPRETER_AZURE_RESOURCE_GROUP" \
     --name "$INTERPRETER_AZURE_VM_NAME" \
     --port 22 \
     --priority 1010
   ```

2. **Install OpenSSH Server on Windows** (run via RDP in PowerShell as Admin):
   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service -Name sshd -StartupType Automatic
   ```

3. **Open Windows Firewall for SSH:**
   ```powershell
   New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
   ```
