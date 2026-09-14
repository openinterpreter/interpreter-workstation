# Website documentation

`docs-site/website/` is the canonical source for the Workstation end-user
documentation published at `openinterpreter.com/docs/desktop`. Relevant pushes
to `main` dispatch a production rebuild of the website. Each build hydrates the
current canonical `main`; it does not commit generated documentation.

The directory is copied recursively and verbatim into the Next.js website. Its
`.mdx` files may therefore use JSX, local React/TypeScript component modules,
and `.tsx` layouts. Keep relative component modules inside
`docs-site/website/`. Website application aliases or components are portable
only when intentionally coupled to that website. Do not commit website build
output. Validate changes through the website's normal preview/build workflow.
