# Simple interface runtime

Simple mode is a live, filesystem-backed React application hosted by
Workstation. The generated interface is not a JSON view tree and is not a
second copy of Workstation chrome. The one durable agent edits a standalone
project, while the host supplies maintained capabilities at runtime.

## Boundaries

- Each interface project is a separate folder with its own React source and
  `.interpreter/project.json`. Projects cannot be nested inside one another or
  inside the control workspace.
- The control workspace remains an additional agent root for instructions and
  operational context. The interface project is the agent's primary working
  directory.
- Generated code is compiled by app-shipped `esbuild` in Electron's main
  process. Users do not need Node, Bun, Vite, or a package install.
- Compilation is revisioned. A bad edit records diagnostics and leaves the
  last known-good revision running.

## Maintained modules

`@interpreter/interface` is the capability boundary. It provides responsive
layout, durable state, ordinary messages to the primary thread, normal drag and
drop, focused subagent runs, and host-rendered Workstation file/folder views.

`@interpreter/motion` is the app-shipped Simple design system. It adapts Motion
Primitives by Julian Ibelik and exposes a small stable surface rather than
requiring every generated project to install or copy animation code.

The app refreshes `.interpreter/skills/interface-design/SKILL.md` when a project
is opened. The project's `AGENTS.md` points the editing agent to that skill.
This makes component and design guidance version with the app without
overwriting user React source.

## Host views and selection

`FileViewer` and `FolderViewer` reserve a rectangle inside generated React and
register that rectangle with the parent. The parent overlays the canonical
Workstation editor or Explorer at that exact position. This avoids duplicating
the markdown, code, image, PDF, document, spreadsheet, and folder behavior that
Workstation already owns. Selection is forwarded through the existing
`selection:changed` context used by the primary agent.

The iframe is still the visual composition surface. The overlay is plumbing,
not a separate interaction model.

## Durable live-edit state

Meaningful domain state uses `usePersistentState`, stored in
`.interpreter/state.json`. The host additionally snapshots form values, focus,
and scroll into `.interpreter/ui-state.json` before a revision changes and
restores them into the next revision. Stable `name` or
`data-interpreter-state-key` attributes are therefore part of the interface
contract.

## Agent runs from interfaces

An interface may start a focused headless agent through `runAgent()` and render
its normal streaming events locally. Completion is not delivered through a
second queue or polling system. The interface uses the existing
`sendMessage()` primitive to steer the same durable primary thread with any
result that should become conversation context.

## Drag and drop

The host turns a native drop into ordinary file descriptors for React. The
template and skill encourage normal canvas/list behavior: dropped media should
appear where it was dropped, documents should join the visible collection, and
folders should open with `FolderViewer`. External paths are session-authorized
only after the user drops them.

## Packaging contract

The installed app must include the compiler and every externalized module used
by the compiler. The package smoke test verifies this. Generated projects may
declare React dependencies for editor familiarity, but runtime resolution is
owned by the app and must not depend on a project-local `node_modules`.
