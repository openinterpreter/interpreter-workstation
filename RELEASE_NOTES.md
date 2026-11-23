<!-- release-notes-for: 0.2.253 -->
## What's new

- Reads requested thread-history pages with bounded native requests and reconnects a second window without loading the full thread history.
- Limits historical tool-output reads so large saved results do not block the current conversation.
- Updates the bundled app preset's Next.js dependency and CI cache action.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
