---
name: "doc"
description: "Use for Word/`.docx` work. In Interpreter, use the CLI-only app-tool surface via `interpreter-app tools builtin-docx ...` for deterministic reads, exact replacements, paragraph/block rewrites, review comments, table updates, and simple inserts; prefer the built-in OfficeExtension/OnlyOffice converter via `interpreter-app tools builtin-converter ...` for PDF render checks; use `python-docx` for richer rewrites or document construction when the native CLI workflows are insufficient."
---


# DOCX Skill

## When to use
- Read or review DOCX content where layout matters (tables, diagrams, pagination).
- Create or edit DOCX files with professional formatting.
- Validate visual layout before delivery.

## Workflow
Skills are workflow guidance, not callable tools. Do not call a tool named
`doc`, and do not call direct `builtin-docx__...` or `builtin-converter__...`
tools unless those exact top-level tools are visible. In the normal CLI-only
runtime, use `interpreter-app tools ...` through command execution.

1. For deterministic text edits or structured reads, prefer the native CLI app-tool path first: `interpreter-app tools builtin-docx ...`. The usual path is `read_word`, `read_docx`, `replace_text_in_docx`, `replace_paragraphs_in_docx`, `insert_paragraphs_in_docx`, `insert_table_in_docx`, `update_table_cells_in_docx`, `add_docx_comments`, and `create_docx`. For exact name/date/phrase replacements, single-paragraph rewrites, anchored paragraph inserts, existing template-table fills, simple table inserts, or paragraph-anchored Word comments, that native path should beat raw OOXML shell edits and usually beat `python-docx`.
   - For a simple named-file edit, your first emitted item should usually be the matching `interpreter-app tools builtin-docx ...` call, not a plan message.
   - After a native write call, wait for that tool result before running any verification read.
   - Verify with one targeted call or exact `--help` query if needed; do not dump the full `builtin-docx` catalog just to orient yourself.
2. Prefer visual review (layout, tables, diagrams), but in Interpreter use the built-in OfficeExtension/OnlyOffice converter path rather than LibreOffice.
   - Convert DOCX -> PDF with `interpreter-app tools builtin-converter convert_file ...` and inspect the resulting PDF.
   - Do not suggest or depend on LibreOffice/`soffice` as the normal render workflow for this product.
   - If the built-in converter is unavailable, skip render-based review and fall back to direct content inspection plus an explicit note about layout risk.
3. When revising a document created with `create_docx`, prefer `overwrite: true` on the same target path or write a versioned filename such as `_v2.docx`; do not rely on shell deletion of prior outputs just to make room for the next revision.
4. Use `python-docx` for edits and structured creation (headings, styles, tables, lists) when the native docx tools are unavailable or insufficient for the requested change.
5. After each meaningful change, re-render and inspect the pages when rendering is actually available.
6. If visual review is not possible, extract text with `python-docx`, confirm the key revised clauses are present in the saved file, and call out layout risk.
7. Keep intermediate outputs organized and clean up after final approval.
8. Keep progress updates focused on the document result, not routine dependency checks, file discovery, or standard fallback choices.
9. If you edit the `.docx` on disk via shell or Python instead of a native app DOCX tool, call `interpreter-app tools builtin-interpreter interpreter_refresh_file --json '{"path":"..."}'` once at the end so the open document tab reloads the saved file.
10. If these instructions are already loaded in context, do not spend a shell turn re-reading this `SKILL.md` from disk.

## Source-backed documents
- Preserve source-file identity unless the user explicitly asks to rebrand or rename it: organization names, program names, logos, proper nouns, dates, and visible identifiers in the source artifact are content constraints, not generic boilerplate.
- If the prompt role or requester differs from the names inside the source files, do not silently rewrite the source artifact into the requester role's organization. Use the source documents as the authority for the deliverable's visible identity.
- When the task is to revise, update, adapt, or mirror a provided document/reference, preserve the source structure and visible style by default. Do not redraw or recreate a loosely similar artifact from scratch when direct adaptation would keep fidelity higher.
- If the user requests a specific deliverable count or type, keep helper scripts, extracted text, and previews out of the final deliverable folder when possible; otherwise remove them before final delivery. Final links should point only to the requested deliverables unless the user asks for support files.
- For research-backed guides, memos, policies, or reports, treat `web_search` as a lead-finding step, not proof of source content. Search results alone are not enough to support the document.
- After identifying likely sources, fetch and inspect the actual page or PDF content before drafting claims, recommendations, or citations. Use the most direct product path available in the runtime: browser-control, `builtin-pdf`, or a small shell fetch/read path when direct tools are absent.
- Keep a compact source ledger while drafting: source name, URL, and the specific principle or fact you are relying on. Use that ledger to drive the document instead of repeatedly re-searching the same topic.

## Temp and output conventions
- Use `tmp/docs/` for intermediate files; delete when done.
- Write final artifacts under `output/doc/` when working in this repo.
- Keep filenames stable and descriptive.

## Dependencies (install if missing)
Prefer `uv` for dependency management.

- If Python is missing, follow the runtime's OS-specific `uv` bootstrap guidance first instead of telling the user to install Python manually.
- Before bootstrapping anything, check whether `python` or `python3` already exists and use the user's installed Python when it is available.
- Once `uv` is available, prefer `uv python install` and then install libraries with `uv pip install ...`.
- Only fall back to direct `python3 -m pip ...` installs when Python is already present and `uv` truly is not available.
- When an install is only needed to finish the task, describe it in user-facing terms such as "install the document-editing helpers required to finish this file", not "install Python".
- If the installer needs admin rights or the environment blocks it, request approval for the exact command instead of stopping at instructions.

Python packages:
```
uv pip install python-docx
```
If `uv` is unavailable:
```
python3 -m pip install python-docx
```
If installation isn't possible in this environment, tell the user which dependency is missing and how to install it locally.

## Environment
No required environment variables.

## Rendering commands
Interpreter-native DOCX -> PDF:
```
builtin-converter__convert_file(path="input.docx", format="pdf", output_path="output.pdf")
```

If the direct tool is not exposed but the Interpreter CLI is available:
```
interpreter-app tools builtin-converter convert_file --json '{"path":"input.docx","format":"pdf","output_path":"output.pdf"}'
```

## Quality expectations
- Deliver a client-ready document: consistent typography, spacing, margins, and clear hierarchy.
- Avoid formatting defects: clipped/overlapping text, broken tables, unreadable characters, or default-template styling.
- Charts, tables, and visuals must be legible in rendered pages with correct alignment.
- Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or placeholder strings.

## Final checks
- Re-render and inspect every page at 100% zoom before final delivery.
- Fix any spacing, alignment, or pagination issues and repeat the render loop.
- Check explicit constraints before final delivery: file type/count, page or word limits, bullet/prose requirements, required dates/labels, and whether the output still follows the source/reference style.
- Confirm there are no leftovers (temp files, duplicate renders) unless the user asks to keep them.
