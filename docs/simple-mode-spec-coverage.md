# Simple mode specification coverage

This is the acceptance map for Killian's original Simple-mode proposal. The
proposal remains the authority; this document records product behavior and
proof rather than reinterpreting it.

Source: `/Users/killianlucas/Desktop/interpreter.txt`

SHA-256: `c847bc17464f530514af8368dede72140d39a0fded6fc1e7bc226b73be5d67d0`

The separate addendum and phone applications remain outside this desktop
sprint. Private desktop-to-desktop access over Tailscale is included.

## Product contract

- Simple is the default experience. Advanced remains available in Settings.
- There is one durable primary conversation across the composer, active
  interface, desktop overlay, GPT Live, and WhatsApp.
- The visible interface is ordinary executable React in a standalone project
  folder. It is not a declarative JSON view tree and it is never nested inside
  the control workspace or another interface project.
- The primary agent receives the interface project as its working directory and
  the control workspace as an additional writable root.
- Workstation ships the compiler, maintained interface runtime, Motion
  Primitives-inspired design system, and app-owned interface-design skill.
- A source error keeps the last known-good interface visible. Meaningful state,
  ordinary controls, focus, selection, and scroll survive live source updates.
- Canonical Workstation file and folder surfaces are mounted into generated
  React rather than being copied or approximated.

## Implemented and exercised

| Area | Evidence |
| --- | --- |
| Default and mode switch | The persisted `advancedMode` setting defaults false. Simple Settings can switch to Advanced and back; the desktop E2E exercises both directions. |
| Durable conversation | The Simple thread binding is compare-and-swap persisted by control workspace. Model changes remount the runtime without clearing the thread. Conversation restart is not offered in Simple. |
| Standalone projects | First launch creates a sibling `Interpreter Interface` project. New/Open/Recent reject nesting, non-empty creation targets, control-workspace targets, symlinks, and traversal. New/Open use independent windows and open-window paths are restored. |
| One visible composer | Main-process focus ownership shows the composer only in the active Workstation window. The overlay reuses the same draft and durable submission route while the app window retains ownership state. |
| Compact surface | The one-line `Ask Interpreter` composer has an attached activity tab. Conversation, settings, and rich presentation expand from the drawer above it; interface interaction collapses the drawer. The surface snaps to edges/corners rather than remaining at arbitrary drag coordinates. |
| Composer state machine | Voice becomes send when text exists; a running agent exposes stop, and typed input can steer or queue. Cmd/Ctrl+Enter queues. Draft state is synchronized with the desktop overlay. |
| Executable React | Projects compile JSX/TSX with app-shipped esbuild. `@interpreter/interface` and `@interpreter/motion` are app-owned imports; Node and arbitrary external imports remain outside the generated interface boundary. |
| Live editing and recovery | Revisions compile separately and promote only after success. Desktop E2E proves controlled input across successful edits, a failed compile, repair, and reload. Concurrent per-key durable state updates are tested. |
| Canonical files and folders | `FileViewer` host-mounts the real `EditorArea`; `FolderViewer` host-mounts the real searchable `Explorer`. Desktop E2E edits Markdown through the canonical editor and verifies disk contents, then opens a file through the canonical tree and returns its path to React. The same `EditorArea` dispatches Workstation's existing viewers for other supported file types. |
| Selection and drops | Selected interface/host-view text enters the normal agent selection context. Native dropped paths are authorized only for the active project session and delivered to ordinary React drop handlers with their drop point; authorization is revoked on project change. |
| Interface messaging and agents | `sendMessage()` uses the same durable-thread message event and includes the active interface path. `runAgent()` uses the existing programmatic agent IPC and streams events into React; useful results return through the same message primitive, with no second polling queue. |
| Maintained design guidance | New projects receive an app-managed skill explaining minimal live-answer composition, centered single-screen layouts, exact maintained imports, Motion Primitives, canonical viewers, state, drag/drop, research, visual inspection, and channel behavior. User source and top-level project instructions remain user-owned. |
| GPT Live | Settings/onboarding accept an OpenAI key through macOS `safeStorage`; no-key first run does not invoke Keychain. Sessions use `gpt-live-1`, bounded durable-thread history, client delegation, transcript events, visible connection/error state, and FIFO result return to delegation IDs. The legacy dictation/voice-interview onboarding is excluded from Simple. |
| WhatsApp | Simple onboarding and Settings use the current bridge package, show link/account state, route self-chat ingress into `simple-primary-agent`, bind it to the durable thread, and forward the completed response to the same WhatsApp chat with outbound-echo suppression. |
| Startup and menus | Simple has its own onboarding sequence for models, optional GPT Live/WhatsApp, and the safe control folder. File menus contain New/Open/Recent Interface; Advanced tab/sidebar commands and macOS speech commands are absent in Simple. |
| Overlay and computer use | The Simple overlay is a bottom composer on a darkened desktop, sends overlay/interface attribution into the durable thread, carries selection/screenshot context, and uses the bundled current CUA Driver through the established desktop tool. |
| Private remote projects | Settings can privately expose the current Workstation through Tailscale Serve, mint a short-lived single-use pairing code/QR, or redeem a code from another Workstation. A paired project opens in its own window. The app persists only the host session policy in its mode-0600 data file; pairing tokens remain memory-only. Direct localhost windows remain usable, while tailnet traffic requires an authenticated session and cannot mint pairing codes. |

## Verification boundary

Automated coverage can prove request construction, routing, persistence, UI
states, app-shipped compilation, canonical editor behavior, and failure
recovery. A real GPT Live audio conversation additionally requires a funded
OpenAI API key and microphone permission. A real WhatsApp round trip requires
the user's phone to scan the QR code. These credential/phone-dependent checks
must be reported as such; a mocked transport is not a claim that an external
account completed a live round trip.

Private-host routing, restart persistence, unauthenticated rejection, one-time
redemption, and authenticated API access are exercised locally. A true
second-device visual acceptance still requires another enrolled tailnet device;
the user-scoped local Tailscale daemon does not install a system DNS route back
to itself.

## Deferred by product decision

- the separate addendum;
- iPhone and other mobile applications, including native QR scanning;
- managed Tailscale enrollment/provisioning beyond the private desktop pairing
  flow; and
- email/text ingress that depends on future channel APIs.
