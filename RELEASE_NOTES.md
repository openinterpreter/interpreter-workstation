<!-- release-notes-for: 0.2.265 -->
## What's new

- Updates the bundled Interpreter runtime to 0.0.64 with a bounded wait for tool responses.
- Automatically resumes usage-limited Goals when the account allowance returns.
- Accepts new thread input after the previous turn failed.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
