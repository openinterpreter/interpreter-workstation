---
name: "pdf"
description: "Use for PDF work. Prefer direct `builtin-pdf` reads first; use render checks when layout matters, and fall back to focused Python tools such as `pypdf`, `pdfplumber`, or `reportlab` only when the direct PDF path is insufficient."
---


# PDF Skill

## When to use
- Read or review PDF content where layout and visuals matter.
- Create PDFs programmatically with reliable formatting.
- Validate final rendering before delivery.

## Workflow
1. For structured reads, form filling, or straightforward generation, prefer exact native `builtin-pdf` calls first when they are enabled in this runtime. The usual direct path is `read_pdf`, `fill_pdf_form`, and `create_pdf`. Verify with one targeted direct call or exact `--help` query if needed; do not dump the full `builtin-pdf` catalog just to orient yourself.
   - If the final deliverable is primarily a spreadsheet, DOCX, or other non-PDF artifact, do not stop to open this `SKILL.md` from disk. Use one direct PDF read/extraction path and return to the primary workflow.
   - For fillable forms, run `read_pdf` first and copy the exact `[fN]` IDs from its output. Call `fill_pdf_form` once with `fields` as an array of `{ "id": "fN", "value": ... }` objects. Do not pass a field-name keyed object such as `{ "company_name": "Acme" }`.
2. Prefer visual review: render PDF pages to PNGs and inspect them.
   - Use `pdftoppm` if available.
   - If unavailable, install Poppler or ask the user to review the output locally.
3. Use `reportlab` to generate PDFs when creating new documents and native PDF tools are unavailable or insufficient for the requested output.
4. Use `pdfplumber` (or `pypdf`) for text extraction and quick checks; do not rely on it for layout fidelity.
5. After each meaningful update, re-render pages and verify alignment, spacing, and legibility.
6. Keep progress updates focused on the PDF result, not routine dependency checks, file discovery, or standard fallback choices.
7. If these instructions are already loaded in context, do not spend a shell turn re-reading this `SKILL.md` from disk.
8. If the user requests exactly one PDF or another exact deliverable set, keep helper scripts, extracted text, and intermediate render files out of the final deliverable folder when possible; otherwise remove them before final delivery.

## Temp and output conventions
- Use `tmp/pdfs/` for intermediate files; delete when done.
- Write final artifacts under `output/pdf/` when working in this repo.
- Keep filenames stable and descriptive.

## Dependencies (install if missing)
Prefer `uv` for dependency management.

Python packages:
```
uv pip install reportlab pdfplumber pypdf
```
If `uv` is unavailable:
```
python3 -m pip install reportlab pdfplumber pypdf
```
System tools (for rendering):
```
# macOS (Homebrew)
brew install poppler

# Ubuntu/Debian
sudo apt-get install -y poppler-utils
```

If installation isn't possible in this environment, tell the user which dependency is missing and how to install it locally.

## Environment
No required environment variables.

## Rendering command
```
pdftoppm -png $INPUT_PDF $OUTPUT_PREFIX
```

## Quality expectations
- Maintain polished visual design: consistent typography, spacing, margins, and section hierarchy.
- Avoid rendering issues: clipped text, overlapping elements, broken tables, black squares, or unreadable glyphs.
- Charts, tables, and images must be sharp, aligned, and clearly labeled.
- Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or placeholder strings.

## Final checks
- Do not deliver until the latest PNG inspection shows zero visual or formatting defects.
- Confirm headers/footers, page numbering, and section transitions look polished.
- Check explicit constraints before final delivery: file type/count, word or page limits, required dates/labels, image/photo restrictions, and whether only the requested deliverables remain visible.
- Keep intermediate files organized or remove them after final approval.
