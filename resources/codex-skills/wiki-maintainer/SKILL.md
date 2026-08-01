---
name: wiki-maintainer
description: Build and maintain a persistent, interlinked markdown wiki (second brain / research notebook / personal knowledge base) from raw sources. Use this skill when the user wants to ingest an article / paper / note / URL / PDF into their wiki, ask a question against their wiki, lint/health-check their wiki, or set up a new wiki from a folder. Triggers include phrases like "add this to my wiki", "ingest this", "file this article", "update my notes with this", "what does my wiki say about X", "health-check my wiki", "find stale/orphan pages", or any workflow involving a `raw/` source folder, `wiki/` markdown folder, `index.md`, or `log.md`. Compatible with Obsidian vaults.
metadata:
  short-description: Maintain a personal markdown wiki from sources
---

# Wiki Maintainer

Treat the workspace as a **persistent, compounding knowledge base**. The human curates sources and asks questions; you do all the reading, summarizing, cross-referencing, filing, and bookkeeping.

When the task is a single clear sub-operation, prefer the specialized skills:

- `$wiki-ingest` for filing one new source
- `$wiki-query` for answering from the wiki
- `$wiki-lint` for maintenance and health checks
- `$wiki-bootstrap` for initializing or restructuring the wiki

Use this umbrella skill when the task spans multiple operations or when you need the overall workflow contract.

## Vault tool

Interpreter exposes the note graph through `interpreter_vault`.

Use it before large wiki operations:

- `action="snapshot"` to confirm workspace scale and graph shape
- `action="search_notes"` to find relevant notes by title, alias, or tag
- `action="note_context"` to inspect backlinks, outgoing links, tags, and broken links for one note
- `action="notes_with_tag"` and `action="list_tags"` for tag-driven navigation
- `action="lint"` for structural wiki health checks

Do not manually rebuild the note graph with ad hoc grep when `interpreter_vault` already has the graph.

## Architecture

Default greenfield layout:

- **`raw/`** — immutable source documents (clipped articles, PDFs, notes, transcripts). Read-only. Never write to `raw/`.
- **`wiki/`** — your output: summary, entity, concept, and synthesis pages. You own this layer entirely.
- **`index.md`** and **`log.md`** at the workspace root — navigation and history.

If the workspace already has an established markdown/wiki structure, adopt it instead of forcing a parallel `raw/` + `wiki/` tree. Respect the user's existing folders, daily-note location, frontmatter conventions, and note naming. Only bootstrap the default layout when the workspace is actually empty or when the user explicitly asks for the `raw/` + `wiki/` structure.

## Page Types (in `wiki/`)

Every wiki page is a markdown file with YAML frontmatter. Use hyphen-case filenames matching the title.

```yaml
---
title: Page Title
type: source | entity | concept | synthesis | comparison | overview
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [raw/path/to/source1.md, raw/path/to/source2.pdf]
tags: [tag1, tag2]
---
```

- **source** — one per ingested document. Title = source title. Includes citation, 3–8 bullet takeaways, key quotes with page/section refs, open questions, and `[[wikilinks]]` to every entity/concept it touches.
- **entity** — a person, organization, place, product, paper, event. One page per entity across all sources.
- **concept** — an idea, mechanism, theory, method, pattern. One page per concept.
- **synthesis** — a multi-source analysis, thesis, or evolving position. Cites sources with `[[wikilinks]]`.
- **comparison** — side-by-side table or contrast across two+ things.
- **overview** — a top-level framing page for a topic area.

**Link everything.** Use `[[Page Name]]` wikilinks (Obsidian-compatible). If you reference something that doesn't have a page yet, link it anyway — orphan links surface what to create next.

## Operations

### Ingest

When the user drops a new source into `raw/` (or gives you a URL) and asks to ingest it:

1. **Read the source fully.** If it's a URL and a web-fetch tool is available, fetch it. If it's a PDF, extract text. If it's a markdown clip (Obsidian Web Clipper), read it directly. If images are referenced and the user asks, view them separately.
2. **Discuss key takeaways briefly with the user** (3–6 bullets) before writing. Ask what to emphasize only if the angle is genuinely ambiguous.
3. **Create the source page** at `wiki/sources/<title-slug>.md` with frontmatter, citation, takeaways, quotes, and `[[wikilinks]]`.
4. **Touch every related page.** For each entity, concept, or claim mentioned: create the page if missing, or update the existing page with the new information. Note contradictions explicitly with a `> [!warning] Contradiction` callout or inline `⚠️` note, citing both sources.
5. **Update `index.md`** with a new entry under the appropriate section.
6. **Append to `log.md`** with the standard prefix format.
7. **Report back to the user**: which pages were created, which were updated, and any contradictions flagged. Be concise.

A durable wiki workflow must already exist before these steps begin. If not, bootstrap first with `$wiki-bootstrap`.

A single ingest typically touches 5–15 wiki pages. That is expected and correct.

### Query

When the user asks a question of the wiki:

1. **Read `index.md` first** to find relevant pages.
2. **Drill into those pages.** Follow `[[wikilinks]]` as needed.
3. **Answer with citations.** Every claim should point to a wiki page (which itself cites `raw/` sources). Use the form `([[Page Name]])` inline.
4. **Offer to file the answer back as a new wiki page** if it's a synthesis, comparison, or non-trivial analysis worth keeping. Exploration outputs should compound in the wiki, not disappear into chat history.

### Lint

When the user asks for a health-check:

1. **Contradictions** — scan for pages where claims conflict with newer sources.
2. **Stale claims** — pages not updated since their sources were superseded.
3. **Orphans** — pages with no inbound links.
4. **Dangling links** — `[[wikilinks]]` pointing to pages that don't exist yet.
5. **Missing concepts** — important terms mentioned repeatedly but lacking their own page.
6. **Gaps** — areas where more sources would strengthen the synthesis.

Report findings as a prioritized list with suggested next actions. Do not auto-fix unless the user asks.

## `index.md` Format

Content-oriented catalog. Organized by section. One line per page:

```markdown
# Index

## Synthesis
- [[Evolving thesis on X]] — current position across 12 sources

## Overviews
- [[Topic A]] — framing page for topic A

## Entities
- [[Person Name]] — short description
- [[Org Name]] — short description

## Concepts
- [[Concept Name]] — one-line hook

## Sources
- [[Source Title]] — author, date, 1-line summary
```

Update on every ingest. Keep one-line summaries tight (under ~80 chars).

## `log.md` Format

Chronological, append-only, grep-friendly. Every entry starts with the exact prefix:

```markdown
## [YYYY-MM-DD] ingest | Source Title
- Created: [[Source Title]], [[New Entity]]
- Updated: [[Existing Concept]], [[Other Page]]
- Contradiction: [[Claim X]] (new source disagrees with [[Older Source]])

## [YYYY-MM-DD] query | "user's question verbatim or paraphrased"
- Filed as: [[Resulting Analysis Page]] (optional)

## [YYYY-MM-DD] lint | summary
- 3 orphans, 2 dangling links, 1 contradiction flagged
```

The prefix `## [YYYY-MM-DD] <op> | ` must be stable so `grep "^## \[" log.md` works.

## Hard Rules

- **Never modify `raw/`.** Sources are immutable. If a source is wrong, note it on the corresponding `wiki/sources/` page.
- **Always update `index.md` and `log.md` on every ingest.** No silent changes.
- **Always use `[[wikilinks]]`**, not markdown `[text](path.md)` links, for inter-wiki references. Obsidian compatibility matters.
- **Flag contradictions, don't resolve them silently.** The human decides which side wins.
- **Cite sources.** Every non-trivial claim on an entity/concept/synthesis page must trace back to a `raw/` source via its `wiki/sources/` page.
- **Don't re-summarize from scratch.** Before writing, read the existing page (if any) and build on it. The wiki is a compounding artifact.
- **Prefer touching more pages over fewer.** If a source mentions 8 entities, update all 8 pages.
- **Keep the human in the loop on sourcing.** Do not auto-fetch and auto-ingest URLs the user did not hand you.
- **Respect the existing vault structure.** Do not create a second note system beside the user's real one unless they asked for that.

## First-Run Setup

If the workspace is empty or clearly greenfield and has no `raw/`, `wiki/`, `index.md`, or `log.md`:

1. Create `raw/` and `wiki/` directories.
2. Create `index.md` with empty section headers.
3. Create `log.md` with a single entry: `## [YYYY-MM-DD] setup | wiki initialized`.
4. Tell the user the wiki is ready and suggest they drop their first source into `raw/` (or clip one with Obsidian Web Clipper).

If the workspace already has a real markdown/wiki layout, skip bootstrap and work inside that layout.

## Obsidian Compatibility

This wiki is designed to work inside an Obsidian vault. `[[wikilinks]]`, YAML frontmatter, and the default `raw/` + `wiki/` layout all render natively, but when the user already has a working vault structure, respect that structure instead of replacing it. The user can browse the graph view, use backlinks, and edit pages directly — you maintain consistency from the other side.
