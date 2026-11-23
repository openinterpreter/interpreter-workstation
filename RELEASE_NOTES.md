<!-- release-notes-for: 0.2.252 -->
## What's new

- Bounds native submission lookup by paging saved turns instead of loading an entire thread history.
- Treats incomplete history and duplicate submission IDs as unknown rather than returning a potentially incorrect result.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
