<!-- release-notes-for: 0.2.248 -->
## What's new

- Fixes an upgrade problem in 0.2.247: on a computer that had already returned turn outcomes to another agent, outcome returns and Goal notices could stay switched off after the update. Records written by earlier versions are now carried over unchanged, and nothing already delivered is sent again.
- The carried-over records are saved as soon as the app starts, rather than on the first later change.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
