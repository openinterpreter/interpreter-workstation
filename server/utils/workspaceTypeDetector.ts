import { existsSync, readdirSync, statSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

export type WorkspaceKind = 'obsidian-vault' | 'wiki' | 'markdown-heavy' | 'general';

export interface WorkspaceTypeReport {
  kind: WorkspaceKind;
  hasObsidianFolder: boolean;
  hasWikiStructure: boolean;       // has `wiki/` or `raw/` subdirectories
  hasIndexMd: boolean;              // has index.md at root
  hasLogMd: boolean;                // has log.md at root
  markdownFileCount: number;
  pdfFileCount: number;
  nonMarkdownFileCount: number;
  sampled: boolean;                 // true if scanning was depth-limited
}

const MAX_SCAN_DEPTH = 3;
const MAX_FILES_SCANNED = 1000;
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.obsidian', '.trash', '.Trash',
  'dist', 'build', '.cache', '.venv', 'venv', '.next',
]);

/**
 * Inspect a workspace path and classify it. Used by the UI to decide what
 * suggestion pills / onboarding hints to show.
 *
 *   obsidian-vault  -> directory contains `.obsidian/`
 *   wiki            -> has `wiki/` + (`raw/` or `index.md` or `log.md`)
 *   markdown-heavy  -> >= 50% of sampled files are .md and there are >= 5 .md files
 *   general         -> anything else
 *
 * Scanning is depth-limited and file-count-capped so this endpoint is cheap.
 */
export function detectWorkspaceType(workspacePath: string): WorkspaceTypeReport {
  const report: WorkspaceTypeReport = {
    kind: 'general',
    hasObsidianFolder: false,
    hasWikiStructure: false,
    hasIndexMd: false,
    hasLogMd: false,
    markdownFileCount: 0,
    pdfFileCount: 0,
    nonMarkdownFileCount: 0,
    sampled: false,
  };

  if (!existsSync(workspacePath)) return report;

  // Cheap top-level signals first.
  try {
    const obsidian = pathJoin(workspacePath, '.obsidian');
    report.hasObsidianFolder = existsSync(obsidian) && statSync(obsidian).isDirectory();
  } catch { /* ignore */ }

  try {
    const wikiDir = pathJoin(workspacePath, 'wiki');
    const rawDir = pathJoin(workspacePath, 'raw');
    const hasWiki = existsSync(wikiDir) && statSync(wikiDir).isDirectory();
    const hasRaw = existsSync(rawDir) && statSync(rawDir).isDirectory();
    report.hasIndexMd = existsSync(pathJoin(workspacePath, 'index.md'));
    report.hasLogMd = existsSync(pathJoin(workspacePath, 'log.md'));
    report.hasWikiStructure = hasWiki && (hasRaw || report.hasIndexMd || report.hasLogMd);
  } catch { /* ignore */ }

  // Sample the file tree to compute the markdown ratio.
  let scanned = 0;
  function walk(dir: string, depth: number): void {
    if (scanned >= MAX_FILES_SCANNED) { report.sampled = true; return; }
    if (depth > MAX_SCAN_DEPTH) { report.sampled = true; return; }
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_FILES_SCANNED) { report.sampled = true; return; }
      if (entry.name.startsWith('.') && entry.name !== '.obsidian') continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(pathJoin(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        scanned++;
        if (/\.md$/i.test(entry.name) || /\.markdown$/i.test(entry.name)) {
          report.markdownFileCount++;
        } else if (/\.pdf$/i.test(entry.name)) {
          report.pdfFileCount++;
          report.nonMarkdownFileCount++;
        } else {
          report.nonMarkdownFileCount++;
        }
      }
    }
  }
  walk(workspacePath, 0);

  // Classify.
  if (report.hasObsidianFolder) {
    report.kind = 'obsidian-vault';
  } else if (report.hasWikiStructure) {
    report.kind = 'wiki';
  } else {
    const totalFiles = report.markdownFileCount + report.nonMarkdownFileCount;
    if (report.markdownFileCount >= 5 && totalFiles > 0 && report.markdownFileCount / totalFiles >= 0.5) {
      report.kind = 'markdown-heavy';
    }
  }

  return report;
}
