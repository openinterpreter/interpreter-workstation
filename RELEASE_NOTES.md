<!-- release-notes-for: 0.2.250 -->
## What's new

- Adds a guarded, future-only recovery path for fixed-interval wake sources after a restart. Already-held events remain unchanged, and ambiguous or refused event states are not replayed.
- Updates server error-reporting compatibility with Sentry Node 11 while preserving the existing consent gate.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
