<!-- release-notes-for: 0.2.262 -->
## What's new

- Keeps first-failure end-to-end traces and logs available for diagnosing intermittent tests.
- Resumes a matching published release only after verifying its source and all asset digests.
- Copies stable download aliases from verified versioned packages and checks their public SHA-256 before completing publication.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
