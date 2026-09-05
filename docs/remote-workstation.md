# Workstation hosts, browser access, and read-only mode

Workstation is one application shell that can point at the computer running the
desktop app or at another computer running the Workstation sidecar. Tabs,
conversations, Goals, Explorer, and file viewers are shared. The transport
changes; the product does not become a separate viewer application.

Two settings describe a connection:

- **Host** chooses the computer: `local` or `remote`.
- **Access** chooses what the user may do: `read-write` or `read-only`.

They are deliberately independent. A signed-in browser can use a remote
computer read-write, while the same remote host can instead be started as a
read-only inspector. Read-only is an explicit host policy, not a guess based on
which routes happen to be available.

## One shell, one bridge

Renderer components import `src/ipc.ts` and call one typed Workstation bridge:

| Runtime | Request transport | Event transport | Computer |
| --- | --- | --- | --- |
| Desktop | Electron preload/IPC | Electron events | Usually local |
| Browser | HTTP under `/api` | `/api/events` SSE | Local or remote sidecar |
| Public publication | Allowlisted HTTP snapshot/file reads | Snapshot refresh | Remote sidecar through a relay |

Business logic stays in `server/handlers`. Electron handlers and HTTP routes
are transports around that logic. Components should not construct localhost
URLs or detect missing methods to decide whether a control is allowed. Use the
bridge for location and `isWorkstationReadOnly()` for access-aware UI.

Native desktop affordances such as an operating-system file picker still need
an Electron implementation. Their browser equivalent should use a browser-safe
workflow, not pretend that the browser can invoke a native dialog on its own
machine. Operations against the connected workspace, thread, settings, and
tools can use the shared HTTP transport.

## The connection contract

There are not separate desktop, browser, remote-viewer, or publication
products. Every Workstation renderer resolves the same three choices:

- **Endpoint** chooses the backend computer. Electron normally defaults to its
  local sidecar; a browser supplies an endpoint; either renderer may point at a
  remote endpoint.
- **Access** is `read-write` or `read-only`, enforced by the backend and
  reflected by the same shell.
- **Authentication** is whatever that endpoint requires. Anonymous access is
  valid only for a deliberately restricted read-only endpoint.

The endpoint advertises the capabilities it exposes. A private endpoint can
provide the complete Workstation API; an anonymous endpoint should expose only
an allowlisted conversation and workspace view. That is backend policy, not a
fourth renderer mode or a separate interface.

## Run a private browser Workstation

Build the renderer and start the sidecar on the computer whose workspace and
agent runtime should be used:

```bash
pnpm run build:renderer

export INTERPRETER_WORKSTATION_PASSWORD='use-a-long-random-password'
export INTERPRETER_WORKSTATION_SESSION_SECRET='use-a-separate-long-random-secret'

pnpm headless -- \
  --home /srv/workstation/oix-home \
  --workspace /srv/workstation/workspace \
  --host 0.0.0.0 \
  --port 5177 \
  --access read-write \
  --auth password
```

When launching from source, the sidecar serves `dist/` if it contains the
built renderer. Set `INTERPRETER_WORKSTATION_RENDERER_DIR` to an absolute build
directory when the service starts from another working directory. A packaged
sidecar serves the renderer placed beside its executable.

Open the browser shell with an explicit connection contract:

```text
https://workstation.example/?surface=workstation&access=read-write&auth=password
```

For a read-only host, start it with `--access read-only` and open the same URL
with `access=read-only`. The browser and host must agree; Workstation refuses to
mount the shell when access or authentication settings do not match.

The sidecar rejects a non-loopback bind unless both access and password
authentication are explicit. Put TLS in front of it and keep the port private
to the reverse proxy or service network. The recommended deployment is
same-origin: serve the renderer and proxy `/api` to the sidecar under one HTTPS
origin. This gives browser session cookies predictable behavior and avoids a
broad CORS policy.

If a separate UI origin is unavoidable, list exact origins in
`INTERPRETER_WORKSTATION_ALLOWED_ORIGINS` and set
`INTERPRETER_WORKSTATION_SECURE_COOKIE=1`. Do not use wildcard origins with
credentialed requests. Modern browser cookie privacy makes a same-origin proxy
the more reliable design.

The `endpoint` query parameter can point a static renderer at another API
origin:

```text
https://app.example/?surface=workstation&endpoint=https%3A%2F%2Fhost.example&access=read-write&auth=password
```

Use it for development or controlled deployments; prefer a same-origin proxy
in production.

## Authentication and access enforcement

`GET /api/workstation-connection` returns only the connection descriptor. With
password authentication, the login form exchanges the password at
`POST /api/workstation-connection/session` for a signed, expiring, HttpOnly
cookie. The password and signing secret remain on the host.

The server enforces access before normal application routes:

- unauthenticated private API and SSE requests return `401`;
- state-changing requests require an allowed `Origin`;
- read-only hosts reject mutation routes with `403`;
- browser controls are also removed in read-only mode, but hidden controls are
  not the security boundary.

A private read-only connection is still allowed to inspect data available to
the signed-in Workstation user. It is a mutation boundary, not a redaction
boundary. Use the publication protocol when content must be reduced to a small
anonymous allowlist.

## Anonymous read-only backend

The public surface is explicit:

```text
?surface=workstation&endpoint=/api/publication&access=read-only&auth=none
```

The normal Workstation shell renders the connection. The conversation is an
ordinary agent tab, permitted files open in ordinary file tabs, and closing
every tab shows the normal empty-tab surface where the active conversation can
be reopened. `surface=remote-workstation` remains only as a compatibility alias
for existing embeds and should not be used for new deployments.

The browser-facing relay exposes exactly three reads:

| Browser request | Private sidecar route | Purpose |
| --- | --- | --- |
| `GET <endpoint>/snapshot` | `GET /api/public-thread/snapshot` | Conversation and Goal |
| `GET <endpoint>/workspace?path=...` | `GET /api/public-workspace?path=...` | Lazy directory listing |
| `GET <endpoint>/file?path=...` | `GET /api/public-workspace/file?path=...` | One published file |

The relay adds the private bearer token upstream. Never place that token in the
query string, browser bundle, iframe attributes, or browser storage.

Configure the private sidecar:

```bash
export INTERPRETER_PUBLIC_THREAD_ID_FILE=/srv/workstation/state/public-thread-id
export INTERPRETER_PUBLIC_THREAD_TOKEN='a-long-random-relay-secret'
export INTERPRETER_PUBLIC_THREAD_TITLE='Published conversation'
export INTERPRETER_PUBLIC_WORKSPACE_ROOT=/srv/workstation/published
export INTERPRETER_PUBLIC_WORKSPACE_NAME='Published files'

pnpm headless -- \
  --home /srv/workstation/oix-home \
  --workspace /srv/workstation \
  --port 5177
```

Keep this sidecar on loopback and expose only the relay. The publication root
must be a dedicated subtree. The server rejects traversal and symlink escapes,
omits special files, caps response sizes, allowlists preview MIME types, and
does not expose prompt, Goal mutation, approval, terminal, settings, or file
mutation routes.

## Read-only shell behavior

Read-only mode keeps inspection interactions: selecting and closing tabs,
creating an empty browser-local tab, reopening conversations, paging backward
through history, following live output, expanding directories, previewing
files, and safe downloads.

It removes or disables mutations: the composer, Stop and steer actions,
approvals, Goal editing, file creation/editing/rename/delete, workspace
selection, settings changes, terminal input, computer control, drag/drop, and
native reveal actions. New features must enforce this on the host and reflect
it in the UI.

## Conversation, Goal, and disk continuity

OIX owns the durable thread, current turn, native Goal, compaction, and rollout.
Closing a tab or browser does not stop it. Workstation opens history on the
newest page, paints only after it is positioned there, follows new output, and
loads older pages when the user scrolls upward.

Persist both the `--home` directory and the workspace on durable storage. A
sidecar restart should reconnect to the same thread, Goal, and files. The
public thread ID file can be updated atomically when an operator needs to
publish a different persisted thread. See [Goals](goals.md) for Goal creation
and lifecycle semantics.

## Verification checklist

1. Open the desktop build and verify conversation, Goal, Explorer, file editing,
   settings, and terminal behavior through Electron IPC.
2. Open an authenticated read-write browser host and repeat the same shared
   workflows through HTTP/SSE.
3. Start the host read-only, confirm the browser refuses a mismatched
   read-write URL, and verify direct mutation requests return `403`.
4. Reload and reconnect to a running turn; verify streaming resumes without
   creating another turn.
5. Open a long conversation and verify its first visible paint is at the newest
   message. Scroll upward repeatedly and verify the visible anchor is stable.
6. Open and close files and conversations, close every tab, and reopen the
   active conversation from the empty-tab surface.
7. For an anonymous read-only endpoint, verify unauthorized upstream requests, traversal, and
   unconfigured relay routes fail; verify the browser receives no relay token
   or absolute host path.
8. Restart the sidecar and confirm the same persisted thread, Goal, and files
   return.

## Design rules

- Do not create a second web shell or bespoke remote file browser.
- Do not hard-code localhost in renderer components; use `src/ipc.ts` URL and
  request helpers.
- Do not infer read-only mode from unavailable capabilities; use the explicit
  access setting.
- Do not rely on disabled UI to protect mutations.
- Do not add a scheduler or supervisor beside native OIX Goals.
- Keep workload-specific behavior out of Workstation components.
