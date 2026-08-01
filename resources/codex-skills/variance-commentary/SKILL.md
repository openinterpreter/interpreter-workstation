---
name: variance-commentary
description: Write flux commentary for P&L and balance-sheet lines over threshold, comparing current period against prior period and budget with drivers explained from underlying activity. Use for month-end close packages and management reporting.
metadata:
  short-description: Write month-end variance commentary
---

# Variance Commentary

Given current-period actuals, prior-period actuals, and budget for the same scope, produce a commentary table.

## Threshold

Flag a line for commentary if either condition is true:

- Absolute variance is at or above the firm's materiality threshold.
- The line is on the always-comment list, such as revenue, headcount cost, or cash.

If no threshold is provided, use 5% of the line or a fixed floor if the user supplies one.

## For Each Flagged Line

| Column | Content |
|---|---|
| Line | Account or caption |
| Current / Prior / Budget | The three values |
| Delta vs prior and Delta vs budget | Amount and percent |
| Driver | One sentence explaining the movement from underlying activity |

A driver explains why, not what. Good: "Cloud spend up $1.2M on incremental GPU reservations for the May launch." Bad: "Cloud spend increased $1.2M, or 18%."

## Sourcing the Driver

Inspect the activity behind the line, such as journal-source breakdown, vendor mix, headcount delta, or volume times rate. Use configured GL, ERP, and document tools through `interpreter-app tools ...` when available.

If the driver is not clear from the data, write "driver unclear - flag for controller" rather than inventing one.

## Output

Return the commentary table plus a short narrative, three to five sentences, summarizing the period's biggest movers.
