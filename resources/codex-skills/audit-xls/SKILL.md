---
name: audit-xls
description: Audit a spreadsheet for formula accuracy, errors, and common financial-model mistakes. Use for selected ranges, single sheets, or whole-workbook model checks including balance-sheet balance, cash tie-out, roll-forwards, and logic sanity.
metadata:
  short-description: Audit spreadsheet formulas and financial models
---

# Audit Spreadsheet

Use this skill when the user asks to audit a workbook, check formulas, find spreadsheet errors, QA a financial model, debug why a model does not balance, or sanity-check Excel output.

## Step 1: Determine Scope

If the user already gave a scope, use it. Otherwise ask which scope to audit:

- selection: just the currently selected range
- sheet: the current active sheet only
- model: the whole workbook, including financial-model integrity checks

Use model scope for DCF, LBO, three-statement, merger, comps, or integrated financial models before sending to a client, controller, or investment committee.

## Step 2: Formula-Level Checks

Run these for every scope:

| Check | What to look for |
|---|---|
| Formula errors | `#REF!`, `#VALUE!`, `#N/A`, `#DIV/0!`, `#NAME?` |
| Hardcodes inside formulas | Constants embedded in formulas that should be inputs |
| Inconsistent formulas | A formula that breaks the pattern of neighboring rows or columns |
| Off-by-one ranges | `SUM` or `AVERAGE` ranges that miss first or last rows |
| Pasted-over formulas | Cells that should contain formulas but contain hardcoded values |
| Circular references | Intentional or accidental loops |
| Broken cross-sheet links | References to moved or deleted cells |
| Unit and scale mismatches | Thousands mixed with millions, or percent values stored inconsistently |
| Hidden rows or tabs | Overrides or stale calculations hidden from normal review |

## Step 3: Model-Integrity Checks

For model scope, identify the model type and run the relevant checks.

Structural review:

- Inputs, calculations, and outputs are separated.
- Color conventions are used consistently.
- Tabs flow in a logical order.
- Date headers and units are consistent.

Balance sheet:

- Total assets equal total liabilities plus equity in every period.
- Retained earnings roll forward from prior retained earnings plus net income less dividends.
- Goodwill and intangibles flow from acquisition assumptions when relevant.

Cash flow:

- Cash flow ending cash ties to balance-sheet cash.
- CFO plus CFI plus CFF equals change in cash.
- D&A, capex, and working-capital changes tie to supporting schedules and signs.

Income statement:

- Revenue ties to segment or product detail.
- Tax expense is reasonable against pre-tax income.
- Share count ties to dilution schedules when relevant.

Model-specific checks:

- DCF: discount timing, terminal value discounting, WACC basis, unlevered FCF, tax shield treatment.
- LBO: debt paydown, PIK accrual, rollover treatment, exit EBITDA basis, fees and expenses.
- Merger: accretion/dilution share count, synergy phase-in, purchase price allocation, sources and uses.
- Three-statement: working-capital signs, depreciation to PP&E, debt maturity schedule, dividend logic.

## Step 4: Report

Return a findings table:

| # | Sheet | Cell/Range | Severity | Category | Issue | Suggested Fix |
|---|---|---|---|---|---|---|

Severity:

- Critical: wrong output, broken formula, balance sheet does not balance, cash does not tie.
- Warning: risky hardcodes, inconsistent formulas, edge-case failures.
- Info: style or best-practice issues.

For model scope, prepend:

```text
Model type: <type> - Overall: <Clean / Minor Issues / Major Issues> - <N> critical, <N> warnings, <N> info
```

Do not change the workbook without asking. Report first, then fix only on request.
