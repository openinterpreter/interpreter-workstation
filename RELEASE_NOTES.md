## What's new

- First-run setup opens in Simple mode with a default workspace, Chrome extension setup, and optional WhatsApp connection. MCP guidance appears only when relevant.
- The compact conversation drawer now exposes activity, approvals, and What's New without obscuring the generated interface.
- Settings add a Light/Dark/System appearance control, persistent Feedback visibility, model presets, and durable conversation/channel bindings. Advanced retains its dedicated thread controls.
- Chrome connection status is steadier during reconnects; channel bindings and reply receipts recover more safely after interruptions.
- Generated React interfaces remain editable on disk and keep the last working render if a new edit fails to compile.
- On Windows, sandboxed agent execution may require one-time administrator approval to set up local sandbox accounts.

## Distribution

This release is built from the public repository using the checked-in official distribution profile.
The exact bundled coding runtime is recorded in `RELEASE-MANIFEST.json`.
Installers and update metadata are published only for the platforms explicitly
listed in the release. A platform awaiting signing or notarization remains on
its previous update feed until its verified package is published.
