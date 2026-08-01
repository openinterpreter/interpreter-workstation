# Optional document engine

The app's default document workflow is code execution plus skills. An embedded
document engine is an optional distribution integration, not a requirement for
building or running the community app.

The current local protocol uses port 38123. Installation may happen in the
background on supported platforms, but the server starts lazily only when a
document viewer flow calls `officeExtension.ensureRunning()`. The internal
`officeExtension` name is retained for protocol compatibility; it does not
identify or require a particular vendor.

Configure the release repository and installation directory through
`distribution.documentEngine` in `product.json`. Empty values disable automatic
installation. See `docs/document-engine.md` for the integration boundary and a
known compatible implementation.
