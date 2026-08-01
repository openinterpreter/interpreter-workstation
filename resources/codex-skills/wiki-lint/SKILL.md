---
name: wiki-lint
description: Health-check a persistent markdown wiki. Use this when the user wants to find orphan notes, dangling links, missing pages, graph gaps, contradictions to review, or general wiki maintenance opportunities.
metadata:
  short-description: Lint a markdown wiki for maintenance issues
---

# Wiki Lint

Use this skill for maintenance and health checks.

## Start with the vault tool

Run `interpreter_vault` with `action="lint"` first. That report is the structural source of truth for:

- orphan notes
- isolated notes
- dangling links
- repeated missing-page candidates
- tag coverage summary

You may also use:

- `interpreter_vault` with `action="search_notes"` for follow-up exploration
- `interpreter_vault` with `action="note_context"` for notes that need closer inspection
- `interpreter_vault` with `action="notes_with_tag"` when a tag cluster looks under-maintained

## Lint workflow

1. Run the structural vault lint.
2. Prioritize the biggest maintenance issues first.
3. If the user asked for semantic review, inspect the most relevant pages for contradictions or stale synthesis.
4. Return a prioritized list of findings and next actions.
5. Do not auto-fix unless the user asked for fixes.

## Hard rules

- Treat the vault lint output as the graph baseline.
- Be explicit about what is structural fact versus semantic judgment.
- If you claim a contradiction, cite both sides.
- If you suspect a stale page but cannot prove it from the files you read, label it as a review candidate rather than a confirmed issue.
