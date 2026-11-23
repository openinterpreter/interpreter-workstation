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

For a retained loopback-only agent host, explicit runtime flags configure the
default profile when the sidecar starts, even though it does not manufacture an
immediate task or conversation:

```bash
export OPENAI_API_KEY='...'

pnpm sidecar:node -- \
  --home /srv/workstation/home \
  --workspace /srv/workstation/workspace \
  --port 5177 \
  --profile-id retained-worker \
  --profile-name 'Retained worker' \
  --model gpt-5.6-sol \
  --reasoning low \
  --openai-api-key-env OPENAI_API_KEY \
  --approval-policy never \
  --sandbox danger-full-access \
  --network-access \
  --quiet-startup
```

The persisted profile records the environment-variable name rather than its
secret value. Subsequent tasks created through Workstation's HTTP API inherit
the profile. Subscription-backed hosts omit the programmatic OpenAI API flags
and use the OAuth profile already authenticated in their persistent home. In
both cases OIX remains Workstation's bundled execution runtime, not a parallel
host service.

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

## Simple mode from another device

Simple mode's generated interface is served by the project's own Next.js dev
server on a dynamic loopback port. It has no base path, so it cannot share the
shell's origin; a browser on another device needs a second origin for it.

Two origins are therefore required, each mapped by an authenticating HTTPS
front to a loopback port on the host:

| Public origin | Loopback target | Serves |
| --- | --- | --- |
| Shell, for example `https://workstation.example` | The sidecar port, for example `127.0.0.1:5177` | Renderer, `/api`, `/api/events` |
| Preview, for example `https://preview.workstation.example` | The preview proxy port, for example `127.0.0.1:5178` | The running Simple project, including its WebSocket |

Configure the sidecar:

```bash
export INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT=5178
export INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN='https://preview.workstation.example'
```

- `INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT` makes the sidecar listen on
  `127.0.0.1:<port>` and forward every request and WebSocket upgrade to the
  currently running Simple project server. It rewrites `Host` and `Origin` to
  the project's loopback address so the dev server accepts them, streams
  bodies in both directions, and answers `503` while no project is running.
  It always binds loopback.
- `INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN` is the absolute `https://` origin
  the front maps to that port. When a request reaches the sidecar on a
  non-loopback `Host` (or `X-Forwarded-Host`), the interface URL returned to
  the renderer uses this origin. Requests on a loopback host, including the
  desktop app, keep the loopback URL. It requires the port variable.

The front must preserve the browser's `Host` header or send
`X-Forwarded-Host`, and must pass WebSocket upgrades to the preview origin.
The project server always reaches the sidecar over loopback, whichever
address the browser used.

The shell's session cookie is not sent to the preview origin inside a frame,
so the preview protects itself. When the public origin is set, the interface
URL carries a signed ticket that is valid once, for thirty seconds. Tickets are
issued only to a paired device (through the device gateway below) or to a
browser signed in with password authentication; any other request receives no
preview URL, so a host whose front authenticates the shell without password
mode shows no interface preview on other devices. The preview proxy exchanges
the ticket for its own cookie (`HttpOnly; Secure; SameSite=None; Partitioned`,
twelve hours) and redirects to the same URL without the ticket. Every later
request and WebSocket upgrade needs that cookie; anything else receives `401`.
A ticket or cookie issued to a paired device stops working when the device is
revoked, and one issued to a password session stops working when that session
expires. When the device gateway is configured, preview responses carry
`Content-Security-Policy: frame-ancestors <gateway public origin>`, so only that
origin can frame the preview. Tickets are signed with
`INTERPRETER_WORKSTATION_SESSION_SECRET` when it is set, otherwise with a
random key the sidecar keeps in its data directory. Without the public origin
the preview proxy adds no authentication and is reachable only on loopback.

The sidecar's own port does not authenticate loopback requests in the default
local mode. The front must authenticate the shell origin (or use password
mode or Connect a device below), and both ports must stay private to the
host.

GPT Live voice normally uses the default OpenAI profile's key or
`OPENAI_API_KEY`. A host that signs in with a subscription can set
`INTERPRETER_LIVE_OPENAI_API_KEY` instead; it is used only for GPT Live
sessions and does not affect model-provider detection.

Focused agent runs started by a generated interface and composer draft sync
are currently available only in the desktop app.

## Connect a device

Connect a device pairs another device, first a phone's web browser, with this
Workstation. The device opens the same interface (Simple mode with its chat
pill, voice and generated interface) against this computer's backend and the
same durable conversation. It is another window of the same agent, not a
separate app, conversation or agent. The person holding the device does not
sign in or set up a network.

Pairing produces one link, `https://<gateway origin>/pair#code=<code>`, and a
QR code of that link. Anyone holding the link before it is used gets full
access to this Workstation, so by default it is shown only on the Workstation
itself:

- The bridge methods `deviceConnections.create` (returns `link`, `expiresAt`
  and `qrSvg`) and `deviceConnections.pending` (unclaimed, unexpired links)
  serve this Workstation's own interface
  (`POST /api/ipc/deviceConnections/<method>`). They are refused for a request
  from a paired device.
- The agent tool
  `interpreter-app tools builtin-interpreter interpreter_device_connection_create`
  creates a connection but returns only `{created: true, expiresAt, note}`; the
  link waits in `deviceConnections.pending` for the person at the Workstation.
  Content the agent reads (a web page, an email, a file) therefore cannot make
  it hand a working link to someone else.
- An unattended host whose agent is the one that sends the link to its owner
  can set `INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS=1`. The tool then also returns
  `link`, `qrSvg` and `qrSvgPath` (an SVG file of the QR code). This trades that
  protection for convenience: anything that can steer the agent can ask it to
  create and disclose a link, so enable it only when the agent's inputs are
  trusted or its outbound channels go only to the owner.

`interpreter_device_connections_list` and `interpreter_device_connection_revoke`
(and `deviceConnections.list` and `deviceConnections.revoke` on the bridge)
list device metadata and disconnect devices. A paired device can disconnect
only itself. The tools refuse with an explanation when the gateway is not
configured.

### Configure the device gateway

```bash
export INTERPRETER_DEVICE_GATEWAY_PORT=5179
export INTERPRETER_DEVICE_GATEWAY_PUBLIC_ORIGIN='https://workstation.example'
export INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT=5178
export INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN='https://preview.workstation.example'
```

`INTERPRETER_DEVICE_GATEWAY_PORT` starts a second listener in the sidecar on
`127.0.0.1:<port>`; it always binds loopback. Each variable requires the
other. The two preview variables are needed for the generated interface to
appear on the device; without them the device still gets the conversation,
but the interface frame points at a loopback address it cannot reach. The sidecar's main listener, its port and its policy are unchanged, so
local tools keep using it as before. Any HTTPS tunnel or reverse proxy then
maps two public origins to loopback ports:

| Public origin | Loopback target | Serves |
| --- | --- | --- |
| `INTERPRETER_DEVICE_GATEWAY_PUBLIC_ORIGIN` | `127.0.0.1:<INTERPRETER_DEVICE_GATEWAY_PORT>` | Pairing page, renderer, `/api`, `/api/events`, WebSocket upgrades |
| `INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN` | `127.0.0.1:<INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT>` | The running Simple project, including its WebSocket |

The tunnel must pass WebSocket upgrades and must not buffer server-sent
events. It does not need to authenticate either origin. Using two subdomains
of one registrable domain keeps the preview frame same-site with the shell,
which browsers that restrict cookies in cross-site frames handle more
reliably. This change does not create or manage tunnels.

### What happens on the device

Opening the link loads a small pairing page. Its script reads the code from
the URL fragment, which the browser never sends to a server, removes it from
the address bar, and exchanges it for a device cookie
(`__Host-interpreter_device_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`,
about 400 days). The page then opens the normal shell at
`/?surface=workstation&access=<host access>&auth=password`. The gateway
answers the shell's connection check as an authenticated session, so no
password form appears. An expired or used link shows a short message asking
for a new one.

The gateway streams every other request, server-sent events and WebSocket
upgrades to the sidecar over loopback. It removes client copies of its
identity headers and adds the device id, so messages typed or spoken on the
device use the same routes as the desktop composer. Every route that submits
user text (start, steer, programmatic tasks and the message queue) labels it
with the device name (`[From Phone]`, or `[From GPT Live on Phone]` for
voice), the label Simple mode already uses for other input sources. Routes
reserved for this computer (wake events, custody inspection, channel binding)
refuse requests that arrive through the gateway or any proxy that sets
`X-Forwarded-Host`.

### Security model

- A paired device has the same access as the person at the desk: read-write
  unless the host runs read-only. Pair only devices you control.
- Codes are random (144 bits), single use and expire after 10 minutes. They
  are compared by hash in constant time. Wrong codes never lock out or discard
  valid ones: guessing is not feasible at that length, and the gateway sits
  behind a tunnel whose socket address does not identify the sender, so a
  lockout would only let anyone block pairing.
- The host stores each device's id, label, kind, creation and last-activity
  times and a SHA-256 hash of its secret in the app config, never the secret.
  Settings and device lists return the metadata only.
- Without a valid, unrevoked device cookie the gateway answers `401` with no
  detail. State-changing requests and WebSocket upgrades must also come from
  the gateway's public `Origin`. Requests a browser marks `Sec-Fetch-Site:
  cross-site` or `same-site`, or that come from the preview origin, are
  refused, except a top-level navigation to `/pair`.
- HTML the gateway serves or forwards carries `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`, and `Access-Control-Allow-*` headers are removed.
- Revoking a device (`interpreter_device_connection_revoke`) refuses its next
  request, including its preview, and closes its open event streams and
  WebSockets. Signing out on the device revokes it too.

Limits: a device credential does not expire on its own; revoke the device to
end its access. The preview proxy rewrites `Host` and `Origin` to the
project's loopback address, so a project server cannot tell which public
origin a request came from. An agent with unrestricted shell access on the
host can read local secrets, including the app config and, when agent links
are enabled, the QR files it wrote.

Not yet available: a Settings panel for devices, native device apps, and
built-in tunnel management.

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

To render this publication in an independent interface instead of the shared
Workstation shell, use the versioned [publication API contract](publication-api.md).
It documents message schemas, pagination, polling, files, errors, compatibility,
and includes a framework-free client.

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

For an ordinary thread with native wake sources, a sidecar shutdown first
fences fresh admission, allows an in-flight native steer/start and its durable
receipt to settle, then releases the sole wake owner. A command still held by
its external source is not acknowledged merely because it was peeked; a
schedule's next due time survives the restart and missed recurring occurrences
coalesce. The successor reconciles offered inputs with native thread history
before allowing later events to overtake them. An ambiguous native RPC remains
visible for operator reconciliation rather than being blindly duplicated.
This is input custody, not proof that a model answered, a Goal exists, or an
outbound channel reply was delivered. A maintenance operator must independently
verify those facts and avoid stopping an active turn or blocked tool.

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
9. For native wake sources, assert one owner, stable provider IDs, deduped
   restart recovery and ordered steer/idle-start on the saved thread; confirm
   a due schedule is retained and offline provider input remains unacknowledged.

## Design rules

- Do not create a second web shell or bespoke remote file browser.
- Do not hard-code localhost in renderer components; use `src/ipc.ts` URL and
  request helpers.
- Do not infer read-only mode from unavailable capabilities; use the explicit
  access setting.
- Do not rely on disabled UI to protect mutations.
- Do not add a scheduler or supervisor beside native OIX Goals.
- Keep workload-specific behavior out of Workstation components.
