# E2E Test Framework

End-to-end tests using Playwright for the Electron app.

## Running Tests

```bash
pnpm test                           # Run the default unit + non-voice E2E suite
pnpm run test:e2e -- --grep "pattern"   # Run default E2E tests matching pattern
pnpm run test:voice                     # Run all voice-specific unit + E2E tests
pnpm run test:e2e:voice                # Run only @voice Playwright coverage
```

`pnpm test` excludes the heavy voice suite by default. If you change voice mode, STT, TTS, qwen, Moonshine, or voice install flows, also run `pnpm run test:voice`.

## Architecture

### Key Files

- **`fixtures.ts`** - Custom Playwright fixtures that extend the base test framework
- **`helpers.ts`** - Shared helper functions for setup, screenshots, auth, etc.
- **`selectors.ts`** - Centralized DOM selectors (use `data-testid` attributes)
- **`test-recorder.ts`** - Video recording and test run directory management

### Shared Electron Instance

Tests share a single Electron instance across all tests in a worker (managed by `electron-instance.ts`). This improves performance but means tests must clean up after themselves.

## Error Handling Strategy

### The Problem

When a test calls `page.reload()`, any in-flight network requests are cancelled, causing "network error" console errors. These errors would fail the test even though they're expected during setup operations.

### The Solution: Time-Based Error Pausing

Instead of filtering specific error messages (which could hide real bugs), we use **time-based error pausing**:

1. **Pause** error checking before setup operations
2. **Execute** the operation (workspace change, reload, etc.)
3. **Wait** for stabilization
4. **Resume** error checking

### Usage

#### In Test Files

Use `withSetupPhase` for operations that may cause transient errors:

```typescript
import { test, expect, withSetupPhase } from './fixtures';
import { reloadAndWaitForPageLoadSignals } from './helpers';

test.beforeEach(async ({ page }) => {
  // Wrap workspace change + reload in setup phase
  await withSetupPhase(page, async () => {
    await page.evaluate(async () => {
      await fetch('/api/workspace', { method: 'POST', ... });
    });
    await reloadAndWaitForPageLoadSignals(page);
  }, 1000); // 1 second stabilization delay
});
```

#### In Helper Functions

Helper functions in `helpers.ts` use `withErrorPause` internally:

```typescript
// Already handled in helpers.ts - these functions pause errors during reload:
await clearUserConfig(page);    // Reloads page with cleared config
await clearLayoutState(page);   // Reloads page with cleared layout
```

### How It Works

1. **fixtures.ts** attaches `__testErrorControl` to the page object
2. `pauseErrorChecking()` sets `setupComplete = false` - errors are collected but don't fail
3. `resumeErrorChecking()` sets `setupComplete = true` - errors will fail the test
4. Errors during setup are logged with "⚠ N console errors during setup (not failing test)"

## Test Output

Each test run creates a timestamped directory in `test-runs/`:

```
test-runs/2025-12-10T23-38-24/
├── logs/          # Console logs for each test
├── videos/        # Video recordings of test execution
├── coverage/      # Code coverage reports
└── screenshots/   # Screenshots on failure
```

## Writing Tests

### Selectors

Always use `data-testid` attributes and the `sel()` helper:

```typescript
import { sel } from './selectors';

// Good
const button = page.locator(sel('explorerButton'));

// Bad - fragile selectors
const button = page.locator('.explorer-btn');
```

### Comments in Test Files

Important selectors have comments like:
```typescript
// DO NOT CHANGE THIS SELECTOR - Used by E2E tests
```

These mark selectors that tests depend on - don't change them without updating tests.

### Console Error Detection

Tests automatically fail on console errors during the test phase. To temporarily ignore errors during setup:

```typescript
import { pauseErrorChecking, resumeErrorChecking } from './fixtures';

// Manual control (prefer withSetupPhase instead)
pauseErrorChecking(page);
// ... risky operation ...
resumeErrorChecking(page);
```

## Common Patterns

### Workspace Setup

Use the `setWorkspace` helper (uses dynamic port for multi-instance support):

```typescript
import { reloadAndWaitForPageLoadSignals, setWorkspace, setWorkspaceWithRetry, getTestWorkspace, withSetupPhase } from './helpers';

const testWorkspacePath = getTestWorkspace();

await withSetupPhase(page, async () => {
  // Simple case
  await setWorkspace(page, testWorkspacePath);

  // Or with retry logic if server may not be ready
  await setWorkspaceWithRetry(page, testWorkspacePath);

  await reloadAndWaitForPageLoadSignals(page);
}, 1000);
```

**IMPORTANT**: Never hardcode `localhost:5177` - always use the helpers that get the dynamic port.

### Waiting for Agent Response

```typescript
async function waitForAgentResponse(page, timeoutMs = 90000) {
  await page.waitForFunction(
    () => document.querySelectorAll('[data-message-id]').length > 1,
    { timeout: timeoutMs }
  );
}
```

### Profile Changes

```typescript
await withSetupPhase(page, async () => {
  await setDefaultProfile(page, 'builtin:smart');
  await page.reload();
  await waitForAppReady(page);
}, 2000);
```
