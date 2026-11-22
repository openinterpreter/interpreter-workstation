<!-- release-notes-for: 0.2.251 -->
## What's new

- Restores the app CLI environment when an eligible saved agent thread is loaded after a restart, so later turns on that thread can access its existing tools.
- Preserves saved caller tool and model scope during cold recovery; conflicting scopes are refused rather than widened, and callers from another workspace are not revoked.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
