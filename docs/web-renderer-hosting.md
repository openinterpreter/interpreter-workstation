# Host the Workstation web renderer

Workstation includes a static browser renderer built from the same React user
interface as the desktop application. It can show the complete Workstation
shell, the maintained conversation component, or a seeded demonstration. The
static files contain no backend, credentials, workspace, or agent runtime.

## Build and publish

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run marketing-demo:build
```

Publish the complete `apps/interpreter-marketing-demo/dist/` directory. The
build uses relative asset URLs, so it works at an origin root or beneath a path
prefix. Do not move individual files out of the generated directory.

Preview the production build locally with `pnpm run marketing-demo:preview`.

## Choose a surface

All surfaces use the same build:

| Surface | URL setting | Intended use |
| --- | --- | --- |
| Full Workstation | `surface=workstation` | Files, tabs, Goals, and conversation against a Workstation backend |
| Conversation only | `surface=remote-thread` | Maintained read-only conversation and Goal component |
| Seeded demo | omit `surface` | Static, backend-free product demonstrations |

```text
https://ui.example/app/?surface=workstation&access=read-write&auth=password
https://ui.example/app/?surface=workstation&endpoint=https%3A%2F%2Fhost.example&access=read-only&auth=password
https://ui.example/app/?surface=remote-thread&endpoint=https%3A%2F%2Fexample.com%2Fpublication&pageSize=10&embedded=1
```

- `endpoint` selects the backend or publication-relay base URL. Omit it for a
  same-origin Workstation backend.
- `access` is `read-write` or `read-only`. The backend must enforce the same
  policy independently.
- `auth` is `password` or `none`. Anonymous access is appropriate only for a
  deliberately restricted publication relay.
- `theme` is `light` or `dark`.
- `embed=1` enables iframe-friendly behavior.
- The conversation surface accepts `pageSize` from 1 through 100 and
  `embedded=1` to remove its header.

## Recommended production topology

Serve the renderer and proxy its backend through one HTTPS origin:

```text
https://ui.example/app/       static renderer
https://ui.example/api/       reverse proxy to the private sidecar
```

This keeps browser cookies first-party and avoids broad CORS policy. Keep the
sidecar on loopback or a private service network and terminate TLS at the
public reverse proxy.

If the renderer and backend use different origins, set an explicit `endpoint`,
allow only exact UI origins with `INTERPRETER_WORKSTATION_ALLOWED_ORIGINS`, and
set `INTERPRETER_WORKSTATION_SECURE_COOKIE=1`. Never combine wildcard origins
with credentialed requests.

## Embed it

```html
<iframe
  title="Workstation"
  src="https://ui.example/app/?surface=workstation&amp;access=read-only&amp;auth=password&amp;embed=1"
  style="width:100%;height:720px;border:0"
  allow="clipboard-read; clipboard-write"
></iframe>
```

After mounting, the renderer posts:

```json
{ "type": "interpreter-marketing-demo-ready" }
```

Validate both `event.origin` and `event.source` before accepting this message.
Use `surface=remote-thread` for only the maintained conversation UI. For a
completely custom interface, consume the versioned
[publication API](publication-api.md). A source-level React import is supported
inside a Workstation checkout; there is not currently a versioned npm package.

## Deploy and update

A production pipeline should:

1. Check out a reviewed Workstation commit.
2. Install from the lockfile and build the web renderer.
3. Run type and focused browser tests.
4. Deploy the complete `dist/` directory atomically.
5. Revalidate `index.html` and cache fingerprinted assets immutably.
6. Smoke-test the entry HTML, a script, a worker, and the selected backend.

The included `web-renderer-deploy.yml` demonstrates this flow for Vercel. It
expects `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and
`VERCEL_WEB_RENDERER_PROJECT_ID` repository secrets. Forks should use their own
deployment account or replace the final step for another static host.

Never put sidecar passwords, bearer tokens, or session secrets in the static
build, URLs, iframe HTML, browser storage, or public CI variables. Password mode
exchanges a user-entered password for an HttpOnly cookie. Anonymous publication
mode uses a narrow relay that keeps its upstream bearer token server-side.

## Verify

- Load the URL directly and inside its intended iframe.
- Confirm scripts, styles, PDF workers, thumbnails, file icons, and bundled
  files load beneath the configured path prefix.
- Confirm the browser receives no private token or absolute filesystem path.
- Verify read-only mutation requests receive `403`; hidden controls alone are
  not enforcement.
- Interrupt the backend and ensure the last good view remains during bounded
  reconnect attempts.
- Exercise several large directories and files under realistic latency.

Continue with [Workstation hosts, browser access, and read-only mode](remote-workstation.md)
for backend setup and its complete security model.
