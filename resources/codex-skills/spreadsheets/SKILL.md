---
name: Excel
description: Use for spreadsheet work (.xlsx, .xlsm, .csv, and .tsv). Inspect and author workbooks through local code execution, normally with openpyxl and pandas. Preserve formulas and formatting, verify the saved workbook, and use a configured document engine only for optional visual rendering.
---

# Spreadsheet workflow

Use local code execution as the primary spreadsheet substrate. Keep the work
auditable: inspect the workbook, make the requested change in one cohesive
script, save it, reopen it, and verify the result.

Skills are workflow guidance, not callable tools. Do not call a tool named
`Excel` or `spreadsheets`. This distribution does not assume a native
spreadsheet tool server; use the shell or code-execution capability exposed by
the selected OIX harness.

## Choose the library

- Use `openpyxl` for `.xlsx` and `.xlsm` inspection and authoring.
- Load macro-enabled files with `keep_vba=True` when macros must be preserved.
- Use `pandas` for analysis and reshaping, then write the final workbook with
  `openpyxl` when formatting, formulas, validations, charts, or print layout
  matter.
- Use Python's `csv` module or pandas for `.csv` and `.tsv`.
- Do not silently rewrite legacy `.xls` files with an incompatible library.
  Explain the limitation or convert through an explicitly configured engine.

## Inspect before editing

For an existing workbook, inspect the parts that may carry meaning:

- sheet order, hidden sheets, used ranges, and named ranges
- formulas and cached values
- merged cells, fills, fonts, borders, number formats, and alignment
- tables, filters, frozen panes, data validation, comments, and hyperlinks
- charts, images, print areas, page setup, and row/column visibility

Do not flatten a styled workbook to a data frame and then overwrite it. Load the
original workbook and change only the requested cells or structures.

## Authoring rules

- Create a meaningful workbook in the first authoring pass. Do not seed a title
  cell and stop.
- Separate inputs, calculations, and outputs for reusable business models.
- Put assumptions and source notes in visible cells.
- Use formulas for user-editable calculations instead of hardcoded results.
- Use typed numbers and dates, appropriate number formats, readable column
  widths, a clear header treatment, filters, and frozen panes where useful.
- Preserve formulas, macros, styles, and unrelated sheets in existing files.
- Write to the user's requested path. Otherwise place final artifacts under
  `./out/` with an informative filename.

For financial models, follow `templates/financial_models.md` and
`style_guidelines.md`. Include visible checks for balance, cash tie-out,
roll-forwards, units, signs, and scenario assumptions.

## Verification

After saving, reopen the final file and check:

1. it exists and can be parsed
2. expected sheets and ranges exist
3. requested values and formulas are present
4. formulas do not contain obvious broken references
5. styles, merged cells, filters, panes, validations, and charts that matter are
   still present
6. only the intended file was produced

If a compatible document engine is configured, convert the workbook to PDF for
a visual layout check. If no renderer is available, report the structural checks
performed and do not claim that rendered layout was reviewed.

## Audit workflow

For spreadsheet audits, report findings before modifying the workbook. Include
sheet/range, severity, issue, evidence, and suggested fix. Check formula errors,
inconsistent formula patterns, hardcodes inside calculation regions, off-by-one
ranges, hidden overrides, unit mismatches, broken links, and model-specific
integrity tests.

## Delivery

Return a concise summary of the sheets and ranges created or changed, followed
by an absolute Markdown link to each final workbook. Do not link scratch files.
