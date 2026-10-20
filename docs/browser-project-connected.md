# Browser projects: proposal-only connected agent contract

## What exists

The static browser project can keep files in the visitor's origin-private storage,
run browser-safe Workers, and preview explicitly approved edits in an opaque
iframe. `src/browser-project/connectedAgent.ts` adds a **version 1 client
contract** for an optional connected proposal backend. It does not mount a new
app-server route, authenticate visitors, select a provider, or grant native
Workstation tools. The existing Workstation sidecar's password session is for
an owner's host; it is **not** a per-visitor tenant identity or scoped project
permission. Do not point a public project at `/api/agent/chat/stream` or share
the owner host's OAuth, password, or cookie.

`server/browserProject/connectedBoundary.ts` is an **unmounted** reference
handler with injected signed-session verification, per-request project ownership,
atomic quota/idempotency reservation and inference-only model port. Its fixture
tests two tenants, denied cross-origin/CSRF and unowned access, consent and
quota, and rejects model-supplied paths/revisions outside the selected file.

## Contract for an independently authenticated backend

Serve the static project and backend under **one HTTPS origin** (or owner-only
loopback during local development). The backend owns an HttpOnly, Secure,
SameSite application session; it verifies issuer, audience, signature, expiry,
subject and tenant **server-side**, binds the browser origin and a session CSRF
token, and checks project ownership on every request. The browser client sends
`credentials: same-origin`; it never accepts another endpoint origin, URL
credentials, an API key, or an OAuth access token.

The backend provides:

- `GET /api/browser-project/v1/session?projectId=<id>`: only for a verified
  session and owned project. Return `version:1`, `authenticated:true`, the
  opaque project/tenant/subject IDs, `access:"propose-only"`, a same-session
  CSRF value, bounded allowed project-file paths, and a provider label. A
  same-origin read-only GET need not carry an `Origin` header; verify its
  cookie and reject any explicit cross-site Fetch Metadata marker.
- `POST /api/browser-project/v1/proposals`: require exact Origin, session
  cookie, matching CSRF header, per-turn visitor consent, an owned project,
  unique client message ID, a selected allowed path and revision, at most
  1,200 UTF-8 message bytes and 64 KiB selected file bytes. Return bounded
  reply text plus **at most one file proposal for the selected path and exact
  revision**. Never apply or execute it. Browser UI must show a diff and ask
  approval before `applyConnectedProposal` writes to its own `ProjectFiles`
  via compare-and-swap. A failed/stale revision rejects the write.

The backend must inject a provider-independent, inference-only model port;
allow **no** shell, browser, filesystem, native Workstation or arbitrary HTTP
tools. A server-owned per-user provider authorization and a durable per-user
quota/cost reservation must succeed before calling that port. There is no
anonymous fallback, shared host credential, automatic retry of a paid call, or
silent provider switch. Treat the model's text, paths and source as untrusted.
Do not create a model call on `GET`, mount, reconnect or file approval.
Neither the client module nor its deterministic fixture supplies a production
identity provider, durable quota store, model service or permission directory.

## Feasibility and acceptance

1. **Visitor-local mode:** browser-safe UI, project files, previews and
   simulations need no operator-hosted project compute. A local model would
   require a separately measured, permission-safe browser runtime; native
   OIX/Node is not an unchanged tab dependency.
2. **Connected mode:** a consented inference service may be remote, while
   visitor files and selected project computation remain in the browser.
   This needs the verified backend above; serving the static shell alone is
   insufficient. React/source proposals are untrusted data, not executed by
   the backend, and require a sandboxed preview, user review and rollback.
3. **Owner-device companion:** a single visitor's locally installed loopback
   backend can hold that visitor's own provider credentials. This is not the
   zero-install website path or multi-user service.

No-cost fixture acceptance: two distinct subject/tenant fixtures, an owned and
unowned project, no model call without consent, a rate/quota denial, exact
same-origin cookie/CSRF transport, rejected cross-origin and cross-file
responses, explicit approval, stale CAS rejection, and no native tool surface.
The fixtures prove **client and unmounted HTTP boundaries**, not a deployed
multi-tenant backend. A real backend additionally needs HTTPS, actual signed
session verification, a persistent project permission store, durable quota and
idempotency reservation, model-provider entitlement, security review and
installed browser acceptance. Do not mount the reference handler with a
test identity, memory-only quota or owner's existing host credentials.

[OpenAI's Sign in with ChatGPT website guide](https://developers.openai.com/siwc/website)
currently describes a selected-partner website flow with a registered client,
backend callback and verified application session. Its
[quickstart](https://developers.openai.com/siwc/quickstart) distinguishes this
from eligible open-source plan-use clients. Neither a public-site registration
nor a pure-browser callback is supplied by this code; do not label a password
sidecar or a visitor-supplied API key as ChatGPT website sign-in.

See [Workstation hosts and browser access](remote-workstation.md) for the
existing owner-host connection and [web renderer hosting](web-renderer-hosting.md)
for same-origin deployment requirements.
