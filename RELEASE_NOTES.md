<!-- release-notes-for: 0.2.261 -->
## What's new

- Fixes bundled resource paths when running the standalone server.
- Allows time for updated download manifests to become visible before verifying a published release.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
