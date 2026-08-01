import { existsSync, readdirSync, statSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { homedir } from 'node:os';

export interface DetectedVault {
  path: string;
  name: string;
}

const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'Library',
  'Applications',
  '.Trash',
  '.cache',
  'venv',
  '.venv',
  'build',
  'dist',
]);

const MAX_DEPTH = 4;
const MAX_VAULTS = 30;
const MAX_ENTRIES_PER_DIR = 200;

function isObsidianVault(dir: string): boolean {
  try {
    const marker = pathJoin(dir, '.obsidian');
    return existsSync(marker) && statSync(marker).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir: string, depth: number, out: DetectedVault[]): void {
  if (out.length >= MAX_VAULTS) return;
  if (depth > MAX_DEPTH) return;

  // If this dir itself is a vault, add it and do not recurse into it.
  if (isObsidianVault(dir)) {
    const parts = dir.split(/[/\\]/);
    out.push({ path: dir, name: parts[parts.length - 1] || dir });
    return;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Limit entries scanned per directory to avoid hotspots like ~/Applications.
  const capped = entries.slice(0, MAX_ENTRIES_PER_DIR);
  for (const entry of capped) {
    if (out.length >= MAX_VAULTS) return;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    walk(pathJoin(dir, entry.name), depth + 1, out);
  }
}

function getCandidateRoots(): string[] {
  const home = homedir();
  const roots = [
    pathJoin(home, 'Documents'),
    pathJoin(home, 'Desktop'),
    pathJoin(home, 'iCloud Drive (Archive)'),
    pathJoin(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
    pathJoin(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
    pathJoin(home, 'OneDrive'),
    pathJoin(home, 'Dropbox'),
    pathJoin(home, 'Obsidian'),
    pathJoin(home, 'Notes'),
    pathJoin(home, 'vaults'),
    home,
  ];
  // Deduplicate and keep only those that exist.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    if (existsSync(root)) result.push(root);
  }
  return result;
}

/**
 * Scan common filesystem locations for Obsidian vaults (directories that contain
 * a `.obsidian/` subfolder). Results are deduplicated, sorted by path, and
 * capped at MAX_VAULTS. Runs synchronously but with strict depth/entry limits
 * to keep latency bounded.
 */
export function scanForObsidianVaults(): DetectedVault[] {
  const vaults: DetectedVault[] = [];
  const seen = new Set<string>();

  // When HOME itself is a vault, walk() will still catch it. But ensure the home
  // directory only gets a single-level scan at depth 0 (via MAX_DEPTH check).
  const roots = getCandidateRoots();
  for (const root of roots) {
    walk(root, 0, vaults);
    if (vaults.length >= MAX_VAULTS) break;
  }

  // Dedupe by path.
  const deduped: DetectedVault[] = [];
  for (const vault of vaults) {
    if (seen.has(vault.path)) continue;
    seen.add(vault.path);
    deduped.push(vault);
  }

  deduped.sort((a, b) => a.name.localeCompare(b.name));
  return deduped;
}
