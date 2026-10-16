# Simple project runtime

Simple mode is a live, filesystem-backed full-stack Next.js application. The
generated interface is not a JSON view tree, a restricted in-memory compiler,
or a second copy of Workstation chrome. The durable agent edits an ordinary
standalone project and the running page hot-reloads in place.

## Architectural decision: Workstation supplies the runtime

This is a portability invariant, not an implementation preference.

- Workstation ships a Node-compatible runtime through Electron and ships its
  own pinned pnpm CLI. It must not depend on Node, Bun, npm, pnpm, or another
  developer tool already being installed on the user's computer.
- Each interface is a normal Next.js project with `package.json`, `app/`,
  `src/`, `public/`, server components, route handlers, backend modules, and
  arbitrary declared npm dependencies.
- Workstation installs the project's declared dependencies with the bundled
  package manager and supervises the dev server on a loopback-only port.
- The format and lifecycle are the same on macOS, Windows, and Linux. Platform
  conditionals belong in the supplied runtime launcher, never in generated
  project code.
- The editing agent remains inside its configured OS workspace sandbox, so its
  file edits stay project-scoped. The Next.js backend is real executable local
  application code launched by Workstation; do not confuse that separate
  process with the agent's edit sandbox or claim that disabling imports is a
  security boundary.

## Project and process boundaries

- Each interface project is a separate folder with its own source and
  `.interpreter/project.json`. Projects cannot be nested inside one another or
  inside the control workspace.
- The interface project is the agent's primary working directory.
- Project code is served by its own Next.js dev server. Source edits use normal
  Fast Refresh without swapping iframe revisions or mounting two frames.
- Workstation watches `package.json`; changing declared dependencies triggers
  installation through the bundled package manager and a supervised restart.
- The dev server binds only to `127.0.0.1`. Workstation owns startup, readiness,
  diagnostics, shutdown, and process-tree cleanup on all supported platforms.

## App-shipped project SDK

`@interpreter/interface` is the app-shipped project SDK. It provides responsive
layout, durable state, ordinary messages to the primary thread, normal drag and
drop, focused agent runs, and host-rendered Workstation file/folder views.

`@interpreter/motion` is the app-shipped Simple design system. It adapts Motion
Primitives by Julian Ibelik and exposes maintained interaction components.

Both packages are exposed as ordinary project dependencies under app-owned
hidden files. They coexist with, and do not restrict, arbitrary npm packages.
Workstation refreshes their implementation when a project opens without
overwriting user-authored application source.

The app also refreshes `.interpreter/skills/interface-design/SKILL.md`. The
project's `AGENTS.md` points the editing agent to that skill so it knows about
the SDK, normal dependency installation, backend routes, and the visual quality
contract.

## One stable visual surface

Exactly one iframe hosts the current project's stable dev-server URL. It is the
visual composition surface. Fast Refresh changes the running application in
place. Workstation host views are plumbing, not a second interaction model or a
second rendered revision.

Workstation does not fork Next.js to manufacture a transactional hot-reload
runtime. A normal Fast Refresh keeps the live DOM and component state whenever
React can safely apply the edit. If an edit requires a page reload, the bridge
restores persisted form/focus/selection state. A framework compile error may
show the normal development error UI; preserving an arbitrary last-good render
must never come at the cost of a custom, incompatible Next.js fork.

`FileViewer` and `FolderViewer` reserve a rectangle in project React and
register that rectangle with the parent. The parent mounts the canonical
Workstation editor or Explorer at that exact position. This keeps DOCX, PDF,
spreadsheet, Markdown, code, image, and folder support available without
forbidding project-owned viewers or other npm libraries.

## Durable state and host bridge

Meaningful domain state uses `usePersistentState`, stored in
`.interpreter/state.json`. The host bridge also preserves form values, focus,
selection, and scroll. It handles normal messages, focused agents, drag/drop,
selection context, and host file views without becoming the project runtime.

The bridge is served by Workstation and proxied through the project dev server.
The project remains an ordinary application and may implement its own backend
and browser-to-server requests independently.

## Packaging and verification contract

The installed app must contain the Electron Node runtime, the exact pinned pnpm
CLI used by project supervision, and the Interpreter SDK source. Package smoke
tests must launch the bundled CLI with Electron-as-Node on every target OS.
Project dependencies are real project-local dependencies installed by that
supplied toolchain, so standard framework behavior and arbitrary packages work.

Tests must cover project creation and migration, bundled package-manager
resolution, loopback binding, dependency changes, one stable iframe, Fast
Refresh, backend route execution, SDK viewer mounting, process cleanup, and
packaged macOS/Windows/Linux runtime discovery.
