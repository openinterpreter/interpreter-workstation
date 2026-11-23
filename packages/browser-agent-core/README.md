# Browser agent core

This workspace package owns browser-local model selection and acquisition, Pi
inference, tool execution, transcript storage, and the Workstation app-server
adapter. A browser application composes the backend into the shared UI. The
desktop renderer and root production dependencies do not import this package.

`BrowserLocalProjectBackend` exposes catalogue provider/model list requests
through the canonical app-server methods before a Pi session exists. The host
passes its `downloadModel` capability to the normal onboarding review; that
idempotent operation verifies cached assets or downloads them with progress.
After a profile is chosen, `openSession(modelId)` verifies the assets, persists
the project selection, and opens the Pi-backed thread. It does not provide an
application-specific picker or a second chat protocol.

With no descriptors supplied, the catalogue registers one public, immutable
revision- and SHA-256-pinned Qwen3 GGUF model. The weights remain external until
explicit acquisition. Downloads use an exact final-host allow-list, the Web
Locks API to serialize tabs, and wllama's streamed OPFS storage; browser hosts
must supply the cross-origin isolation headers required by the multithread
WASM engine. A missing storage or lock capability is an explicit error.

## Repository coupling

This package currently relies on source modules in this repository, so it must
be consumed with the matching Workstation revision rather than installed as an
independently versioned package. Its production imports are:

- `src/lib/codex/api-types` (request bodies)
- `src/lib/codex/event-mapper` (SSE event types only)
- `src/lib/codex/protocol` (request and notification types only)
- `server/handlers/codex-generated-types/index` (thread/model result types)
- `server/handlers/codex-generated-types/serde_json/JsonValue` (JSON result type)

The package uses Pi's normal `Agent` and browser-supplied `StreamFn`. Optional
telemetry is not configured by the package.
The package-local `protocolWire` contains only the emitted app-server method
strings and their SSE projection. Tests compare every emitted notification to
the canonical mapper; no root application code is imported at runtime. The
generated protocol and request types above are type-only imports, removed from
the browser bundle.
