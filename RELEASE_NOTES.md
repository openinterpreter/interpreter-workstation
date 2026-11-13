## What's new

- Fixed a Windows launch failure caused by an omitted packaged URL dependency.
- Windows installers and updates no longer reopen the app from an elevated installer; open Interpreter from Start after installing the update.
- Raw Markdown edits in Simple interfaces now persist when the interface refreshes or you leave the editor.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
