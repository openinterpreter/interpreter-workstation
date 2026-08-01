export interface VaultResolvedLink {
  target: string;
  fragment: string | null;
  display: string | null;
  resolvedPath: string;
  resolvedLabel: string;
  resolvedRelativePath: string;
}

export interface VaultBrokenLink {
  target: string;
  fragment: string | null;
  display: string | null;
}

export interface VaultBacklink {
  path: string;
  title: string;
  relativePath: string;
}

export interface VaultNoteRecord {
  path: string;
  title: string;
  relativePath: string;
  aliases: string[];
  tags: string[];
  headings: string[];
  outgoingLinks: VaultResolvedLink[];
  backlinks: VaultBacklink[];
  brokenLinks: VaultBrokenLink[];
  modifiedTime: number;
}

export interface VaultSnapshot {
  workspacePath: string;
  builtAt: number;
  noteCount: number;
  tagCount: number;
  notes: VaultNoteRecord[];
}

export interface VaultNoteContext {
  workspacePath: string;
  builtAt: number;
  noteCount: number;
  tagCount: number;
  note: VaultNoteRecord | null;
}

export interface VaultSearchResult {
  path: string;
  title: string;
  relativePath: string;
  aliases: string[];
  tags: string[];
  score: number;
}

export interface VaultTagSummary {
  tag: string;
  noteCount: number;
  notes: Array<{
    path: string;
    title: string;
    relativePath: string;
  }>;
}

export interface VaultBrokenLinkSummary {
  target: string;
  fragment: string | null;
  display: string | null;
  referenceCount: number;
  referringNotes: VaultBacklink[];
}

export interface VaultLintNoteSummary {
  path: string;
  title: string;
  relativePath: string;
  outgoingLinkCount: number;
  backlinkCount: number;
  brokenLinkCount: number;
  tagCount: number;
}

export interface VaultLintReport {
  workspacePath: string;
  builtAt: number;
  noteCount: number;
  tagCount: number;
  orphanNotes: VaultLintNoteSummary[];
  isolatedNotes: VaultLintNoteSummary[];
  danglingLinks: VaultBrokenLinkSummary[];
  missingPageCandidates: VaultBrokenLinkSummary[];
  tags: Array<{
    tag: string;
    noteCount: number;
  }>;
}
