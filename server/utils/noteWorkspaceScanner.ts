import { existsSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join as pathJoin } from 'node:path';

export type NoteWorkspaceSource = 'obsidian' | 'logseq' | 'dendron' | 'foam';

export interface DetectedNoteWorkspace {
  path: string;
  name: string;
  source: NoteWorkspaceSource;
}

interface ScanNoteWorkspacesOptions {
  candidateRoots?: string[];
  maxResults?: number;
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

const NOTE_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.org']);
const CLOUD_ROOT_PREFIXES = ['onedrive', 'dropbox', 'nextcloud', 'owncloud'];
const SOURCE_ORDER: NoteWorkspaceSource[] = ['obsidian', 'logseq', 'dendron', 'foam'];

const MAX_DEPTH = 4;
const MAX_RESULTS = 24;
const MAX_ENTRIES_PER_DIR = 200;

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeReadDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function addExistingRoot(target: Set<string>, root: string): void {
  if (target.has(root)) {
    return;
  }
  if (existsSync(root) && safeIsDirectory(root)) {
    target.add(root);
  }
}

function addMatchingChildRoots(
  target: Set<string>,
  parent: string,
  predicate: (dirName: string) => boolean,
): void {
  for (const entry of safeReadDir(parent)) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!predicate(entry.name)) {
      continue;
    }
    addExistingRoot(target, pathJoin(parent, entry.name));
  }
}

function hasDirectory(parent: string, childName: string): boolean {
  return safeIsDirectory(pathJoin(parent, childName));
}

function hasFile(parent: string, childName: string): boolean {
  return safeIsFile(pathJoin(parent, childName));
}

function hasEnoughNoteFiles(dir: string, maxDepth: number, minCount: number): boolean {
  let count = 0;

  function walk(currentDir: string, depth: number): void {
    if (count >= minCount || depth > maxDepth) {
      return;
    }

    const entries = safeReadDir(currentDir).slice(0, MAX_ENTRIES_PER_DIR);
    for (const entry of entries) {
      if (count >= minCount) {
        return;
      }

      if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        if (NOTE_FILE_EXTENSIONS.has(extension)) {
          count += 1;
        }
        continue;
      }

      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name.startsWith('.')) {
        continue;
      }

      if (IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      walk(pathJoin(currentDir, entry.name), depth + 1);
    }
  }

  walk(dir, 0);
  return count >= minCount;
}

function detectWorkspaceSource(dir: string): NoteWorkspaceSource | null {
  if (hasDirectory(dir, '.obsidian')) {
    return 'obsidian';
  }

  if (
    hasDirectory(dir, 'logseq')
    && (
      hasDirectory(dir, 'pages')
      || hasDirectory(dir, 'journals')
      || hasEnoughNoteFiles(dir, 2, 3)
    )
  ) {
    return 'logseq';
  }

  if (hasFile(dir, 'dendron.yml') || hasFile(dir, 'dendron.code-workspace')) {
    return 'dendron';
  }

  if (
    hasDirectory(dir, '.foam')
    && (
      safeIsDirectory(pathJoin(dir, '.foam', 'templates'))
      || hasEnoughNoteFiles(dir, 2, 2)
    )
  ) {
    return 'foam';
  }

  return null;
}

function getCandidateRoots(): string[] {
  const home = homedir();
  const roots = new Set<string>();

  for (const dirName of ['Documents', 'Desktop', 'Obsidian', 'Notes', 'vaults']) {
    addExistingRoot(roots, pathJoin(home, dirName));
  }

  addMatchingChildRoots(roots, home, (dirName) => {
    const lowered = dirName.toLowerCase();
    return CLOUD_ROOT_PREFIXES.some((prefix) => lowered.startsWith(prefix));
  });

  if (process.platform === 'darwin') {
    addExistingRoot(roots, pathJoin(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
    addExistingRoot(roots, pathJoin(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'));
    addMatchingChildRoots(roots, pathJoin(home, 'Library', 'CloudStorage'), () => true);
  }

  addExistingRoot(roots, home);
  return Array.from(roots);
}

function walkForNoteWorkspaces(
  dir: string,
  depth: number,
  maxResults: number,
  seenPaths: Set<string>,
  out: DetectedNoteWorkspace[],
): void {
  if (out.length >= maxResults || depth > MAX_DEPTH) {
    return;
  }

  const source = detectWorkspaceSource(dir);
  if (source) {
    if (!seenPaths.has(dir)) {
      seenPaths.add(dir);
      out.push({
        path: dir,
        name: basename(dir) || dir,
        source,
      });
    }
    return;
  }

  const entries = safeReadDir(dir).slice(0, MAX_ENTRIES_PER_DIR);
  for (const entry of entries) {
    if (out.length >= maxResults) {
      return;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (IGNORED_DIR_NAMES.has(entry.name)) {
      continue;
    }
    walkForNoteWorkspaces(pathJoin(dir, entry.name), depth + 1, maxResults, seenPaths, out);
  }
}

export function scanForNoteWorkspaces(options: ScanNoteWorkspacesOptions = {}): DetectedNoteWorkspace[] {
  const maxResults = options.maxResults ?? MAX_RESULTS;
  const candidateRoots = options.candidateRoots ?? getCandidateRoots();
  const seenRoots = new Set<string>();
  const seenPaths = new Set<string>();
  const workspaces: DetectedNoteWorkspace[] = [];

  for (const root of candidateRoots) {
    if (workspaces.length >= maxResults) {
      break;
    }
    if (seenRoots.has(root)) {
      continue;
    }
    seenRoots.add(root);
    if (!existsSync(root) || !safeIsDirectory(root)) {
      continue;
    }
    walkForNoteWorkspaces(root, 0, maxResults, seenPaths, workspaces);
  }

  workspaces.sort((a, b) => {
    const sourceOrder = SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
    if (sourceOrder !== 0) {
      return sourceOrder;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return workspaces;
}
