# Document workflows and engines

Interpreter's default document strategy is code execution plus reusable skills.
Agents can inspect, transform, and generate common file formats with open-source
libraries while keeping each operation visible and reviewable.

## Default Office previews

Community builds include open-source, embedded read-only viewers for DOCX, XLSX,
and PPTX files. When a user opens one of these files, the app reads its bytes
through the existing permissioned Electron file boundary and renders the
preview locally with bundled viewer assets. The preview is intentionally
read-only: it does not provide editing, download, print, or HTML-export
controls, and it does not require a hosted account or a separately installed
office suite.

These viewers are for inspection. Agents can still use code execution and
reusable skills when a workflow needs to transform, recalculate, or generate a
document.

## Optional rich editing

Rich embedded editing and format conversion are optional integrations. A
compatible document engine can be configured by a distribution and installed
independently when those capabilities are needed. The community source does
not bundle a paid SDK, license file, or proprietary conversion runtime.

## Integration contract

A compatible engine is expected to provide the local extension protocol used by
the desktop host for:

- opening supported documents in an embedded editor
- exporting to a requested format
- reporting readiness and version information
- clean startup and shutdown under the app lifecycle

The configured release repository and install directory live under
`product.json`'s `distribution.documentEngine` object. Empty values disable
automatic installation without disabling code-and-skills document workflows.

[OO Editors](https://github.com/openinterpreter/oo-editors) is one compatible
implementation. It has its own repository, release process, dependencies, and
license obligations. Deployers are responsible for reviewing those obligations
before enabling it.

## Design direction

New document capabilities should normally begin as skills and executable code.
Add a native or embedded engine dependency only when it materially improves a
workflow that cannot be delivered safely and transparently through that model.
