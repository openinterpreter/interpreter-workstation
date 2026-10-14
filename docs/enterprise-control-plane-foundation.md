# Enterprise control-plane foundation (not an enabled product feature)

This repository contains an **unmounted** read-only organization API, a server-owned single-host directory, an OIDC authorization-code client with S256 PKCE, and a separately unmounted HTTP callback router. The shipped desktop's Account settings intentionally reports that enterprise administration is not configured. `EnterpriseAdminDashboard` is a read-only UI component exercised with fixtures; it is not shown to employees or connected to a production identity provider.

## What the foundation does

- An operator-only bootstrap pins each organization's issuer and provisions its first administrator. There is no anonymous or browser-accessible bootstrap endpoint.
- A configured OIDC client creates one-time state, nonce, PKCE verifier and browser binding; exchanges a code only at its pinned token endpoint; verifies a signed ID token against the pinned JWKS URI, issuer, audience, nonce, authorized party, time and allowed algorithms; then checks server-owned membership. The OIDC ID token is **not** accepted as a Workstation API bearer token.
- The unmounted callback router pins the application origin and callback path, rejects unexpected query parameters and forwarded-host substitution, and uses host-only `HttpOnly`, `SameSite=Lax`, `Secure` cookies outside explicit loopback-only test mode. It never puts the opaque session in a URL or renderer storage. Production TLS and reverse-proxy trust topology still require review.
- A separate unmounted same-origin browser API resolves the cookie server-side, checks current session and tenant/role through the locked directory, and fails closed on revocation and audit failure. The read-only dashboard does not accept a token prop or set an `Authorization` header. Its fixture tests are not deployed browser-session proof.
- The server creates a random opaque session; only its SHA-256 digest is retained. Directory reads check the current session, pinned issuer, organization and active admin membership in one locked operation and commit an audit event before returning data. Demoting a member revokes that member's sessions in the same write.
- Server-owned directory writes use restrictive filesystem permissions, an exclusive cross-process lock and atomic replace. A stale lock, failed audit write, corrupt state or missing identity fails closed. This is a bounded **single-host prototype**, not a distributed or hardened database, SIEM, SCIM server, execution policy engine or credential vault. Windows directory-flush durability remains unproven and needs retained-fleet validation.

The [OpenID Connect Core ID-token validation rules](https://openid.net/specs/openid-connect-core-1_0-18.html), [PKCE S256](https://www.rfc-editor.org/rfc/rfc7636.html) and [OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700.html) are the standards references. `jose` is used for signed token/JWKS verification; no competitor code or assets were imported.

## Required before mounting or displaying SSO

1. Independently threat-model deployment authority, trusted HTTPS origin, exact callback URI, account-domain to organization mapping, pinned issuer/JWKS endpoints, redirect/cookie rules, client registration, state/browser binding and IdP metadata. The current local-loopback exception is a test-only constructor option, not a production setting.
2. Independently review and deploy the unmounted callback through an authorized TLS origin with exact account-domain mapping; validate browser binding, CSRF, login/logout, session expiry/revocation and concurrent browser/Electron lifecycle end to end. A local fixture is not proof of production cookie custody or reverse-proxy safety.
3. Replace the single-file directory with a reviewed durable transactional store and backup/restore, retention, migration and audit-export design. Define provisioning ownership, emergency suspension, SCIM group/user lifecycle and IdP-session invalidation. Do not equate a local filesystem workspace with an organization tenant.
4. Enforce policies across agent, tool, IPC, sidecar and execution paths, including direct-route bypass tests. Hold secrets server-side. Verify connector ACL inheritance and revocation before any knowledge-layer security claim.
5. Run an approved end-to-end local IdP deployment with a real callback/account-domain configuration and installed desktop revision, and review dashboard loading, denied, empty and populated states. Then publish and roll out through the ordinary protected release path.

There are no production domains, IdP credentials, paid services or SSO feature flags in this foundation. Tests use only generated local keys and temporary directories.
