# Simple mode roadmap

Simple and Advanced are two experiences in the same Workstation application.
The local project format, interface runtime, and conversation bridge remain
usable without a hosted account.

## Future capabilities

- Future native phone clients should use a versioned, project-scoped remote
  session contract while supplying their own native composer and pairing UI.
- Managed device enrollment and enterprise policy can later provide private
  remote access without changing the local project format.
- Further messaging channels should use the existing durable conversation and
  explicit per-channel authorization rather than creating separate agents.
- Investigate a safe, supported macOS Messages self-text integration. The
  intended behavior is that a message to yourself wakes the explicitly bound
  durable thread; no Messages bridge or entitlement is shipped yet.

## Ongoing verification

- Exercise real audio input and output when GPT Live changes, and verify a
  real phone link when the optional messaging bridge changes.
- Keep generated interfaces on the maintained host file viewers and versioned
  app-owned interface-design and Motion resources; preserve user project source.

## Agent and generated-app runtime backends

**Current protected-main source, not an installed-package claim.** Desktop Simple
mode displays a generated, filesystem-backed application beside one persistent
conversation. Its **first-class desktop target is a full-stack Next.js
project**, not a restricted esbuild-only React preview. Workstation supplies
the Node-compatible Electron runtime and pinned package manager, supervises
the project dev server on loopback, and connects the native OIX agent and
approvals. The project may own server components, route handlers, server
actions, and application/game backend logic subject to the host's permissions.
Source previously compiled a bounded React preview with esbuild; the current
main replaced that runtime with the supervised project server. Source support
does not prove every packaged platform, generated backend path, or installed
host has passed acceptance. The browser renderer can connect to an
authenticated Workstation backend, but its static files do not include that
backend. See [Simple project runtime](simple-interface-runtime.md),
[hosts and browser access](remote-workstation.md), and
[web renderer hosting](web-renderer-hosting.md).

The separate [bounded browser-local project proof](browser-local-projects.md)
has origin-private files, revision-checked approved edits, a same-origin
versioned Worker, and an isolated preview. Its suggested edit is deterministic,
not a model-backed agent. It does not execute native OIX, a shell, Node, a
Next.js server, or provider sign-in in the tab. Sharing a renderer must not
blur where the project, tools, or model credentials actually run.

**Proposed direction.** Select an *agent runtime* and a *generated-app runtime*
independently at a capability-negotiated connection boundary. These are
choices for the same Workstation experience, not new agent types or private
distribution forks:

| Client and backend | Agent execution | Generated app and project data |
| --- | --- | --- |
| Desktop + native local host (current source; installed acceptance pending) | Installed OIX app-server and configured tools/approvals | Workstation-supervised full-stack Next.js project with local routes/server actions; app-shipped Node and package manager |
| Browser + connected host (renderer supported; app integration to verify) | Authenticated desktop, peer, or operated backend owns execution and approvals | Project processes and files live on that backend, not implicitly on the visiting device |
| Browser + visitor-local host (bounded project proof only) | **Proposed** consented browser-safe agent adapter; no native OIX or browser OAuth assumed | Bounded OPFS files, approved edits, isolated preview, Worker/Wasm compute where tested; no full-stack server assumed |
| Phone client (proposed) | Explicitly selected authenticated backend, or separately proven local capability | Remote project view first; local compute/storage requires platform tests |

**Proposed common contract.** Version an app-server-like boundary for
conversation identity/events, project file reads and revisioned writes,
approval requests and decisions, preview lifecycle, and bounded observation
streams. The UI may share those concepts, but each backend must enforce
authentication, workspace scope, approval ownership, and read-only policy.
An adapter must identify who owns compute and storage before accepting a
write. Existing `src/ipc.ts` desktop IPC and browser HTTP/SSE bridge are a
transport seam, not proof that a browser-local agent already exists. Do not
expose a host filesystem through an untrusted preview or reuse a remote bearer
token as a visitor-local model token.

**Evidence gates before claiming support:**

1. Prove the **desktop full-stack Next.js promise** on an installed package,
   not merely a development checkout: create a project; use a server route or
   action and a small local game/state backend; edit React and backend files
   through the configured agent's project-scoped permissions; verify live
   refresh, explicit approval for escalations, stable preview URL, and
   persistence after a restart. Record build/compile errors and recovery to a
   usable last-known state or honest visible error: normal Fast Refresh cannot
   guarantee an arbitrary last-good render. Verify process-tree shutdown,
   loopback binding, dependency changes, and bundled runtime/package-manager
   discovery on macOS, Windows, and Linux before claiming cross-platform
   installed support. Project backend code has its own operating-system
   execution boundary; the agent's edit sandbox alone does not confine it.
2. Specify a small versioned project/approval/preview capability schema and
   exercise read, propose, approve, reject, revision-conflict, and reconnect
   cases against the desktop host and an authenticated browser-connected host.
   Server authorization must not depend on hidden UI controls.
3. Prove one visitor-local slice: edit a bounded OPFS file, approve a proposed
   change, update an isolated visual canvas, step a versioned Worker, reload,
   replay, and export. Record browser support, quota/eviction, performance,
   and a network trace proving that project files and compute did not move to
   an operated host.
4. Investigate a browser-safe agent, model authorization, user-code execution,
   package installation, WebGPU, Wasm/WASI, and mobile-local execution as
   separate compatibility and security spikes. Require supported origin,
   redirect, consent, and token-custody evidence for provider sign-in. Never
   copy desktop OAuth or assume API billing. Stop on unsupported browser APIs,
   failed isolation, or unacceptable device latency rather than promising an
   unchanged native OIX or a full Next.js server in a tab.
5. For connected cloud or peer-hosted backends, test enrollment, narrowly
   allowed origins, permission and approval continuity, reconnect/cancel,
   and file/preview isolation. For phones, first verify a selected-backend
   read/write flow under the same policy; native local execution is separate.

This is a roadmap, not a claim of shipped browser agents, mobile apps,
WebGPU simulation, or hosted entitlement. Project-specific engines and scenes
stay in their own projects; the shared Workstation contract remains generic.
