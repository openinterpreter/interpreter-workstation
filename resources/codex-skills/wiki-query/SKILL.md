---
name: wiki-query
description: Answer questions against a persistent markdown wiki and optionally file the answer back into the wiki. Use this when the user asks what their wiki says about a topic, wants a comparison across notes, or wants citations grounded in the wiki.
metadata:
  short-description: Query a markdown wiki with note citations
---

# Wiki Query

Use this skill when the user is asking the wiki a question.

## Use the vault tool first

Start with `interpreter_vault` instead of wandering the file tree blindly.

Preferred sequence:

1. `interpreter_vault` with `action="search_notes"` for the user query and likely synonyms.
2. `interpreter_vault` with `action="resolve_link"` if the user references a page by wikilink-like name.
3. `interpreter_vault` with `action="note_context"` for the strongest candidate notes.
4. Read `index.md` if it exists and still helps you orient.
5. Read only the specific wiki pages and source pages needed to answer.

## Answer standard

- Answer from the wiki layer, not from vague memory of raw files.
- Cite claims inline with `([[Page Name]])`.
- Follow `[[wikilinks]]` when a page clearly points to another relevant page.
- If the answer is a useful synthesis, comparison, or analysis artifact, offer to file it back into the wiki as a new page.

## Hard rules

- Do not rewrite the wiki unless the user asks you to file the answer back.
- Prefer durable citations to page names that already exist in the workspace.
- If the wiki is thin or missing needed coverage, say so plainly and suggest the next ingest or lint action.
