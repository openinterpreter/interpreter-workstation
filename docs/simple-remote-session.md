# Remote Simple session architecture (v1)

## Decision

Reuse Workstation's headless sidecar, durable OIX thread and authenticated
HTTP/SSE transport. The existing operator API retains its own loopback port;
the optional remote listener binds a distinct loopback port and exposes only
the project-scoped v1 routes. A native desktop client renders its compact Simple
composer over an independently sandboxed, project-owned React surface. The
host's project ID is a stable opaque identifier mapped server-side to exactly
one validated project root; wire requests never choose a filesystem path.
Active window and project identity accompany every agent message, and the
remote host—not the display device—owns the thread and workspace tools.

The sidecar and remote listener both bind loopback. Tailscale Serve terminates
private HTTPS only for the remote listener; access-control grants restrict which enrolled devices can
reach its port. Funnel and public ingress are not supported. Device enrollment
is administered separately with a scoped tagged server identity. A QR contains
only the private HTTPS endpoint, public host fingerprint, project/session ID,
expiry and one-use challenge. A separately displayed copyable code authorizes
redeeming that challenge; neither a Tailscale credential nor a bearer session
token is ever embedded in the QR, URL or log. A successful redemption consumes
the challenge and returns a project-scoped session credential in the response
body; disconnect revokes it. The application checks origin and session scope
on every request even when the network has already admitted the device.

Protocol v1 uses JSON over HTTPS for commands and SSE for interface-change and
conversation events. File drop is explicitly disabled in capability discovery;
a future bounded, explicitly authorized upload can extend v1 without exposing
arbitrary filesystem paths. Reconnection reads the authoritative durable thread
history and current promoted interface before rejoining the live SSE stream;
the browser surface and future native mobile composer use the same
protocol, not a desktop WebView control strip. No implicit local screenshots,
selections, computer controls or voice model are exported: a display client
must explicitly attach context, and capabilities identify which host owns each
tool. The v1 voice-source text request routes to the same remote durable
thread. Remote microphone/media transport and a GPT Live client remain
separate follow-up work; this protocol must not create a second agent.

Project compilation and last-known-good promotion remain on the host. New
source is not rendered until it compiles; a failed edit retains the accepted
HTML and its live iframe state. Project-owned source imports only versioned
app-provided runtime/components through stable names. No shared multi-project
source folder or declarative UI schema is introduced.

## Operation and limits

- Serve requires HTTPS enabled for the tailnet and an ACL/grant to the tagged
  host. The operator must enroll each participating device independently.
- Before enabling remote sessions, verify Serve's private configuration and
  reject a Funnel configuration; never fall back to a public host bind.
- Existing Advanced and local Simple UI are unaffected if remote sessions are
  disabled or the optional Tailscale installation is absent.
- Protocol consumers may be native on iPhone or Android in a future release;
  no mobile app is part of this change.
