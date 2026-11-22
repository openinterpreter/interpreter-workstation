<!-- release-notes-for: 0.2.249 -->
## What's new

- Fixes an upgrade problem in 0.2.248: on a computer with a long history of messages from other agents, the first start after the update could return the outcomes of turns that had ended long before. Inputs admitted by an earlier version are no longer handed over for an outcome return after an update.
- An input admitted from this version on keeps waiting for its outcome return to be recorded for as long as that takes, across restarts.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
