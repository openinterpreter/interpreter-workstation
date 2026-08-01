# Playwright Electron Notes

Use this repo’s Electron QA path when validating workstation UI:

- Skill: use `$playwright-interactive`
- CWD: the root of your `interpreter-workstation` checkout
- Renderer: keep Vite on `5173`
- Owner model: one Vite server, one Playwright-owned Electron app, no extra browser fallback

## Recommended flow

1. Start or reuse the renderer server on `5173`
2. Launch `node scripts/playwright-electron-repl.cjs`
3. Confirm `await status()` shows `http://localhost:5173/`
4. Reuse that single helper session for the whole QA pass

## Repo-specific gotchas

- Inactive agent threads stay mounted. Hidden tabs can leave duplicate buttons in the DOM.
  - Scope clicks to the visible center-thread control, not just `getByText(...)`
  - For repeated controls like `Stop background processes`, inspect bounds first
- Background-linked controls must be scoped to the current thread surface.
  - Do not use document-global selectors to reveal or highlight a background source row
  - Hidden mounted threads and detached panes can satisfy the selector first
- The top `New agent` button can have pointer interception from overlapping shell chrome.
  - If Playwright click retries on interception, a DOM `HTMLElement.click()` is more reliable
- `contenteditable` targets are ambiguous on the new-agent screen.
  - Multiple visible editors can exist at once
  - Verify bounds before focusing, or you may type into history search / a detached pane instead of the live composer
- `page.reload()` returns a large Playwright `Response` object in the helper output.
  - Ignore the object noise or follow it with a simple sentinel string
- If a live thread already has the state you need, prefer switching tabs over creating more tabs

## Background-terminal QA lessons

- The stop button exists in hidden mounted threads too
- For rail QA, switch to the tab that actually shows the center-thread rail first
- A reliable visible-stop selector is:
  - button has non-zero bounds
  - `x < 1200`
  - `y` in the main center-thread band, not the right detached pane
- After clicking stop, verify both:
  - the rail disappears from the center thread
  - the detached command rows settle in the live thread
- Then reload and confirm there is no detached rail restored from history

## Do not do this

- Do not launch Electron from another repo cwd
- Do not use the operator’s real desktop session for QA
- Do not mix a Playwright-owned Electron session with separate manual Electron launches
- Do not edit `opencode` or `codex/codex-rs` for workstation UI tasks unless explicitly asked
