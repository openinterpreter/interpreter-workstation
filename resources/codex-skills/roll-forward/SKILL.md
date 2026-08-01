---
name: roll-forward
description: Build a roll-forward schedule for a balance-sheet account or account group, tying beginning balance, activity, reversals, payments, adjustments, and ending balance to GL support. Use for month-end close packages and audit support.
metadata:
  short-description: Build GL-tied balance roll-forwards
---

# Roll-Forward

Given an account or account group, entity, and period, produce a roll-forward that ties beginning balance to ending balance.

## Structure

```text
Beginning balance, per prior-period close       X
  + Additions / new activity                    A
  + Accruals booked this period                 B
  - Reversals of prior accruals                (C)
  - Payments / settlements                     (D)
  +/- Reclasses / adjustments                   E
  +/- FX translation                            F
Ending balance, per GL at period end            Y
```

## Tie Each Line

- Beginning: prior-period close package or GL balance at the prior-period end date.
- Activity lines: GL detail query by account, date range, and journal source.
- Ending: GL balance at the period-end date.

The schedule must foot:

```text
X + A + B - C - D + E + F = Y
```

If it does not foot, report the unexplained delta. Do not plug the difference.

## Output

Return the roll-forward table with a "ties to" column citing the GL query, document, or file for every line, plus a foot check with pass/fail and unexplained delta.
