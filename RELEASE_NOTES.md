## What's new

- Simple mode now opens by default, with standalone React interface projects, a compact composer, and live updates from project files.
- Settings can switch between Simple and Advanced without removing Advanced windows or overlay behavior.
- First-run setup focuses on Simple mode, offers Chrome extension setup, and shows MCP guidance only when a relevant configuration is detected.
- Simple settings retain stored model profiles and GPT Live. Generated interfaces use the app-owned runtime and preserve the last working render when an edit fails to compile.
- On Windows, sandboxed agent execution may require one-time administrator approval to set up local sandbox accounts.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
