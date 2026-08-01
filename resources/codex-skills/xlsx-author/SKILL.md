---
name: xlsx-author
description: Produce a .xlsx workbook file on disk for headless sessions or artifact-based workflows instead of driving a live Excel workbook. Use when the user needs a workbook artifact created or updated from data and instructions.
metadata:
  short-description: Author workbook artifacts on disk
---

# XLSX Author

Use this skill when running headless or when the user needs an Excel workbook delivered as a file artifact rather than editing a live workbook.

Use this skill for file-producing workflows. A configured document engine may
provide a live embedded editor or visual export, but workbook authoring remains
code-driven and works without that optional integration.

## Output Contract

- Write to `./out/<name>.xlsx` unless the user provides a different path.
- Create `./out/` if it does not exist.
- Return the relative path in the final message.

## How To Build The Workbook

Write a short script and run it. Prefer `openpyxl` for Python-based workbook authoring.

```python
from openpyxl import Workbook
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active
ws.title = "Inputs"
ws["B2"] = "Revenue"
ws["C2"] = 1_250_000_000
ws["C2"].font = Font(color="0000FF")  # blue = hardcoded input

calc = wb.create_sheet("DCF")
calc["C5"] = "=Inputs!C2*(1+Inputs!C3)"  # formula cell

wb.save("./out/model.xlsx")
```

## Conventions

- Blue cells are hardcoded inputs.
- Black cells are formulas.
- Green cells are links to another sheet or file.
- Do not hardcode values in calculation cells.
- Put assumptions on an Inputs tab.
- Use named ranges for values referenced from a deck or memo.
- Include a Checks tab for balance checks, cash tie-outs, and other TRUE/FALSE controls.
- Keep one model per file unless the user explicitly asks to append to an existing workbook.
