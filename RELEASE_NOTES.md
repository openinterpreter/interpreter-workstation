<!-- release-notes-for: 0.2.259 -->
## What's new

- Reports native thread-list failures instead of treating them as an empty thread list.
- Bounds thread-list requests so a delayed native response cannot silently mask an error.
- Reads thread-list pages from the native state database and checks empty pages against the ordinary scan.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
