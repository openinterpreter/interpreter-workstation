import type { WorkspaceTypeInfo } from '../../../api';

export function isWikiWorkspace(workspace: WorkspaceTypeInfo | null | undefined): boolean {
  return workspace?.kind === 'obsidian-vault' || workspace?.kind === 'wiki';
}

export function shouldOfferBootstrapNudge(workspace: WorkspaceTypeInfo | null | undefined): boolean {
  if (!workspace || !isWikiWorkspace(workspace)) {
    return false;
  }
  return !workspace.hasWikiStructure;
}

export function buildWikiBootstrapPrompt(scopeLabel: 'notes' | 'workspace'): string {
  const sourceLabel = scopeLabel === 'notes' ? 'existing notes' : 'files in this workspace';

  return `Read $wiki-bootstrap. Then bootstrap a durable wiki workflow from my ${sourceLabel}.

Start by inspecting the workspace with \`interpreter_vault\` and decide whether this is:
- an empty or greenfield wiki
- an existing structured vault you should adopt
- a markdown-heavy folder that should be converted carefully

If the workspace is truly greenfield, create the default \`raw/\`, \`wiki/\`, \`index.md\`, and \`log.md\` layout.
If the workspace already has a working vault structure, adopt it instead of creating a second parallel wiki.

Show me the proposed structure and conversion plan before moving files or generating many notes.
`;
}

export function buildWikiIngestPrompt(): string {
  return `Read $wiki-ingest. Start with \`interpreter_vault\` to inspect the current note graph. If there is not yet a real wiki or established vault workflow to ingest into, stop and use $wiki-bootstrap first.

Then ingest the single source below into the existing wiki:
- read it fully
- create or update the source page
- update every materially affected entity, concept, synthesis, or comparison page
- add \`[[wikilinks]]\` for durable connections
- update \`index.md\` and \`log.md\`
- flag contradictions explicitly
- report what changed

URL:
`;
}

export function buildWikiQueryPrompt(): string {
  return `Read $wiki-query. Start with \`interpreter_vault\` search and note-context actions. Read \`index.md\` only if it exists and still helps you orient. Then read only the relevant wiki pages, follow the useful \`[[wikilinks]]\`, and answer the question below with (\`[[Page Name]]\`) citations.

If the answer is non-trivial, offer to file it back as a synthesis or comparison page.

Question:
`;
}

export function buildWikiLintPrompt(): string {
  return `Read $wiki-lint. Start with \`interpreter_vault\` action=\`lint\`, then run a focused maintenance pass for:

- orphan pages with no inbound links
- dangling \`[[wikilinks]]\` that point to pages that do not exist yet
- concepts repeatedly referenced but lacking their own page
- topic gaps where new sources would strengthen the synthesis
- stale claims newer sources have superseded

Return a prioritized list with suggested next actions.
`;
}

export function buildWikiConnectionsPrompt(): string {
  return `Read $wiki-query. Start with \`interpreter_vault\` search and note-context actions, then read across the relevant wiki pages and surface non-obvious connections between entities, concepts, or sources.

Return the strongest 3-5 connections, each with supporting citations, and offer to file the result as a synthesis page.
`;
}
