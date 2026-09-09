# CONTEXT

Ubiquitous language for the interpreter-workstation effort. Glossary only — no implementation details.

## Glossary

- **Production-ready (local)**: a packaged production-mode Linux build running on this machine with all must-verify features proven working. Not the release pipeline (signing, distribution, auto-update are a separate effort).
- **Verified**: passing the automated smoke gate plus the manual UI checklist; never claimed from typechecking alone.
- **Must-verify features**: basemind 0.29 integration, GDPR/xberg redaction pipeline, needle deferred routing, onboarding flow, provider/model management.
- **Theater**: UI or progress reporting that claims work it does not perform (e.g. a download that downloads nothing). Never ships as production-ready.
- **Resources-ready**: the app's `resourcesReady` markers (nerModel, embeddings, reranker). Open question whether these marker paths match where basemind actually provisions models — see the download-design ticket.
