# Website documentation

`website/` is the canonical source for the Workstation end-user documentation
published at `openinterpreter.com/docs/desktop`.

Edit these pages in this public repository. A push to `main` that changes this
directory dispatches the website documentation workflow. The website checks out
the exact pushed revision, regenerates its desktop docs, commits the generated
result, and deploys through its normal Vercel integration.

Do not edit the generated desktop documentation in the website repository.
