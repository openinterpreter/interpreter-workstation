---
name: wiki-ingest
description: Ingest one new source into an existing persistent markdown wiki or established vault workflow. Use this when the user asks to add an article, PDF, note, URL, transcript, or other source into their wiki and wants the source filed, linked, indexed, and logged. If the wiki workflow does not exist yet, use $wiki-bootstrap first. This skill is for the ingest operation only.
metadata:
  short-description: Ingest one source into a markdown wiki
---

# Wiki Ingest

Use this skill for one-source-at-a-time wiki ingestion.

## First principle

Treat the workspace as a persistent knowledge base. You are not answering a one-off question. You are updating the durable markdown artifact.

## Use the vault tool first

Before making wiki changes, inspect the existing note graph with `interpreter_vault`.

Preferred sequence:

1. `interpreter_vault` with `action="snapshot"` to confirm note count and workspace shape.
2. `interpreter_vault` with `action="search_notes"` for the key entities, concepts, and source title you expect to touch.
3. `interpreter_vault` with `action="note_context"` for the most relevant existing pages before editing them.
4. Read the actual markdown files you need to update.

Do not re-derive backlinks, aliases, or tags with ad hoc grep when the vault tool already has the graph.

If that inspection shows there is not yet a real wiki or established vault workflow to ingest into, stop and use `$wiki-bootstrap` first instead of inventing structure ad hoc inside the ingest pass.

## Ingest workflow

1. Read the source fully.
2. Summarize the key takeaways briefly for the user if the angle is unclear or if confirmation is useful.
3. Create or update the source page.
4. Update every related entity, concept, synthesis, or comparison page that the source materially changes.
5. Add `[[wikilinks]]` for every durable connection.
6. Update `index.md`.
7. Append a grep-friendly entry to `log.md`.
8. Report which pages were created, updated, or flagged for contradiction.

## Hard rules

- Never modify `raw/`.
- Respect an existing vault structure instead of forcing `raw/` + `wiki/` if the user already has one.
- If there is no durable wiki structure yet, use `$wiki-bootstrap` first.
- Always use `[[wikilinks]]` for inter-wiki references.
- Flag contradictions explicitly instead of silently resolving them.
- Update `index.md` and `log.md` on every ingest.
- Prefer touching all materially affected pages over doing the minimum possible.
