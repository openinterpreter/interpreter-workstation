# Distribution and release builds

Interpreter Workstation has one open application, one canonical repository, and
one public release implementation. Distribution profiles change public client
configuration and package identity; they do not unlock client capabilities or
replace application code.

## Shipped profiles

### Community source build

The committed `product.json` is the safe default for contributors, downstream
packagers, and organizations:

- no hosted account provider or hosted API
- no telemetry or crash-reporting endpoint
- no vendor update feed or external document-engine source
- direct provider, local-model, local tools, skills, OIX, and CUA support

This is a complete client, not a limited edition. A client feature that exists
only in another profile is an architecture failure.

### Official build

`distribution/product.official.json` is the checked-in profile used for
official Interpreter releases. It adds the public client coordinates for
optional Interpreter-hosted services, the official update feed, and an optional
compatible document engine. Users can still use direct providers or local
models without signing in.

The official profile contains no server authority. Supabase anonymous keys,
Sentry DSNs, service URLs, and update-feed coordinates are visible in every
installed client and are therefore public configuration. Authentication,
authorization, rate limits, billing, and data access must be enforced by the
services, never by hiding a client value.

Build it with:

```bash
pnpm run build:official
pnpm run package:official
```

The official binary is not defined merely by running that command locally. An
official release is a build of protected `main` produced by the checked-in
`Official release` workflow, approved through the `production-release`
environment, signed and notarized with project credentials, accompanied by
checksums and an SPDX SBOM, and covered by GitHub artifact attestations. See
[Official releases](releases.md).

### Internal build

The internal profile uses the same official client configuration and source,
but a separate package name and application identifier so it can be installed
beside production. It is an unsigned review artifact, not a private feature
edition.

```bash
pnpm run package:internal:mac-arm64
pnpm run release:verify:internal
```

The `Internal release` workflow produces an unsigned review build under the
protected `internal-release` environment. It is never an official release and
must not publish to the production update channel.

## Secret boundary

GitHub protected environments and repository secrets should hold only values
whose disclosure grants authority, including:

- signing certificates and passwords
- Apple notarization credentials
- update-storage write credentials
- private-submodule checkout tokens while any release dependency is private
- a scoped token that can write internal artifacts to the designated private
  release repository after this source repository becomes public

Do not put service-role keys, model-provider keys, refresh tokens, or customer
credentials in a product profile. Service secrets belong in the hosted
service's secret manager. Values embedded in a desktop binary cannot be kept
secret even if CI supplied them from a GitHub secret.

## Custom and enterprise profiles

An organization can create a small JSON overlay with its service endpoint,
public auth-client settings, managed update channel, and optional document
engine:

```json
{
  "distribution": {
    "id": "example-enterprise",
    "hostedApiBaseUrl": "https://ai.example.com",
    "auth": {
      "provider": "supabase",
      "url": "https://auth.example.com",
      "anonKey": "public-client-configuration",
      "storageKey": "example-auth-token"
    },
    "telemetry": {
      "sentryDsn": "",
      "eventsUrl": "",
      "eventsAnonKey": ""
    },
    "updates": {
      "provider": "none",
      "bucket": "",
      "endpoint": "",
      "path": "",
      "internalPath": "",
      "region": "",
      "acl": ""
    }
  }
}
```

Build without permanently modifying `product.json`:

```bash
node scripts/with-distribution-config.mjs ./product.example.json -- pnpm run build
```

The wrapper takes an exclusive lock and restores the original product file even
when the child command fails. A private operations repository may retain
internal binary artifacts, organization-specific configuration, credentials,
and deployment policy, or trigger these public workflows. It must not become a
second application or the owner of canonical release logic.

## Privacy contract

The community profile has no vendor telemetry destination. Providing a
telemetry endpoint in another profile does not grant consent: JavaScript events,
analytics, and native crash reports remain disabled unless the user explicitly
opts in. If consent state cannot be read, reporting fails closed.
