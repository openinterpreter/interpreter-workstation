---
name: wiki-bootstrap
description: Bootstrap a markdown workspace into a durable wiki structure. Use this when the user wants to initialize a wiki from an empty folder or convert an existing pile of notes into a more structured persistent wiki.
metadata:
  short-description: Bootstrap a markdown wiki workspace
---

# Wiki Bootstrap

Use this skill when the user wants to initialize or restructure a wiki.

Use it for first-run setup before the first ingest when there is no durable wiki workflow yet.

## Start by inspecting the workspace

Use `interpreter_vault` with `action="snapshot"` to see whether the workspace already contains a meaningful note graph.

Then:

1. Inspect the top-level workspace files and folders.
2. Decide whether this is:
   - an empty/greenfield wiki
   - an existing structured vault
   - a markdown-heavy folder that should be converted carefully
3. Show the user the proposed structure before moving or generating many files.

## Default greenfield setup

If the workspace is truly greenfield:

- create `raw/`
- create `wiki/`
- create `index.md`
- create `log.md`
- add an initial setup entry to `log.md`

## Existing workspace rule

If the workspace already has a working vault structure, adopt it. Do not create a second parallel wiki system beside the user's real notes unless they explicitly asked for that.

## Hard rules

- Never move or rewrite lots of notes without showing the plan first.
- Preserve plain markdown.
- Use `[[wikilinks]]`.
- Prefer gradual conversion over a big-bang reshuffle.
