# Distribution builds

Interpreter Workstation has one canonical application source tree. A
distribution changes product configuration and release operations; it does not
own a fork of the application.

## Community defaults

The committed `product.json` is safe for a source build:

- no hosted account provider
- no hosted API
- no telemetry or crash-reporting endpoint
- no external document-engine release source
- direct provider and local-model configuration remains available

This is also the review baseline for enterprise deployments. If a feature only
works when a private overlay is present, it is not a community feature.

## Overlay schema

A distribution overlay may replace fields under `distribution`:

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
    "newsletterUrl": "",
    "billingApiBaseUrl": "",
    "updates": {
      "provider": "none",
      "bucket": "",
      "endpoint": "",
      "path": "",
      "internalPath": "",
      "region": "",
      "acl": ""
    },
    "documentEngine": {
      "releaseRepository": "",
      "installDirectoryName": "document-engine"
    }
  }
}
```

Build with an overlay without modifying the checked-in product file:

```bash
node scripts/with-distribution-config.mjs ./product.example.json -- pnpm run build
```

The wrapper takes an exclusive lock, writes the merged configuration for the
child build, and restores the original file even when the build fails.

## Security boundary

Product configuration is shipped to clients and must be treated as public.
Never put service-role keys, provider secrets, signing credentials, refresh
tokens, or customer credentials in an overlay. CI should inject signing and
publishing secrets only into the release process.

An organization may maintain a private release repository containing only:

- its product overlay
- signing and notarization configuration
- deployment policy and managed defaults
- release workflows
- optional integration manifests whose licenses permit redistribution

Application changes belong in this repository so community and deployed builds
receive the same security and runtime fixes.

The overlay wrapper is deliberately transactional: it refuses concurrent
distribution builds, merges the private configuration only for the child
process, and restores the checked-in community file afterward. Release CI
should verify that `product.json` is unchanged when the build completes.
