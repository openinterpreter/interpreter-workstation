import { Router, Request, Response } from 'express';
import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join as pathJoin, relative as pathRelative, normalize as pathNormalize, sep as pathSep } from 'node:path';
// normalizePath from permissions.ts is intentionally NOT used for workspace routes.
// It converts Unicode characters (smart quotes, etc.) to ASCII, which breaks filesystem
// paths containing those characters (e.g., folder names with curly apostrophes).
import { getCurrentWorkspace } from '../utils/workspace';
import {
  getWorkspace as getWorkspaceHandler,
  setWorkspace as setWorkspaceHandler,
} from '../handlers/workspace';
import { thumbnailService, DimensionResult } from '../thumbnailService';
import { writeFileTreeCache } from '../fileTreeCache';
import { spawn } from 'node:child_process';
import { resolveRipgrepBinaryPath } from '../utils/ripgrep';
import * as rgPath from '@vscode/ripgrep';
import { getRecentFolders } from '../configStore';
import { scanForNoteWorkspaces } from '../utils/noteWorkspaceScanner';
import { detectWorkspaceType } from '../utils/workspaceTypeDetector';
import { detectRunnableProject } from '../utils/runnableProjects';
import { resolveVaultWikilinkPath } from '../utils/vaultIndex';
import { normalizeLooseWikilinkName, normalizeLooseWikilinkSegments } from '../../shared/wikilinkMatching';
import {
  getWikilinkBasename,
  getWikilinkTargetCandidates,
  hasMarkdownFileExtension,
  normalizeExactWikilinkRelativeTarget,
  splitWikilinkTarget,
} from '../../shared/wikilinkTargets';

const router = Router();

type WorkspaceCoreRouteDeps = {
  getCurrentWorkspace: typeof getCurrentWorkspace;
  getWorkspaceHandler: typeof getWorkspaceHandler;
  setWorkspaceHandler: typeof setWorkspaceHandler;
  writeFileTreeCache: typeof writeFileTreeCache;
};

const defaultWorkspaceCoreRouteDeps: WorkspaceCoreRouteDeps = {
  getCurrentWorkspace,
  getWorkspaceHandler,
  setWorkspaceHandler,
  writeFileTreeCache,
};

// Helper function to build file tree recursively
interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  mtime?: number;
  thumbnail?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  fileIcon?: string;
  runnableProject?: import('../../shared/types/projectRunner').RunnableProjectMetadata;
  children?: FileTreeNode[];
}

type ProgressCallback = (current: number, total: number, phase: 'counting' | 'processing') => void;
const WIKILINK_IGNORE_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', '.DS_Store']);

function getTreeRelativePath(basePath: string, fullPath: string): string {
  const relativePath = pathRelative(basePath, fullPath);
  return pathSep === '/' ? relativePath : relativePath.split(pathSep).join('/');
}

function joinWikilinkPath(workspacePath: string, target: string): string {
  return pathJoin(workspacePath, ...splitWikilinkTarget(target));
}

async function getActiveWorkspacePath(overridePath: string | null = null): Promise<string | null> {
  if (overridePath !== null) {
    return overridePath;
  }
  const { workspace } = await getWorkspaceHandler();
  return workspace;
}

export function normalizeWorkspaceContentSearchQuery(query: string): string {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return '';
  }

  const tagAliasMatch = trimmedQuery.match(/^tag:\s*(.+)$/i);
  if (!tagAliasMatch) {
    return trimmedQuery;
  }

  const normalizedTag = tagAliasMatch[1]?.trim().replace(/^#+/, '');
  return normalizedTag ? `#${normalizedTag}` : '';
}

export function buildWorkspaceContentSearchSnippet(
  lineText: string,
  query: string,
  maxLength = 400,
): string {
  const normalizedLine = lineText.replace(/\r?\n$/, '');
  if (normalizedLine.length <= maxLength) {
    return normalizedLine;
  }

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return normalizedLine.slice(0, maxLength);
  }

  const matchIndex = normalizedLine.toLowerCase().indexOf(trimmedQuery.toLowerCase());
  if (matchIndex < 0) {
    return normalizedLine.slice(0, maxLength);
  }

  const desiredLeadingContext = Math.max(0, Math.floor((maxLength - trimmedQuery.length) / 2));
  let start = Math.max(0, matchIndex - desiredLeadingContext);
  let end = start + maxLength;

  if (end > normalizedLine.length) {
    end = normalizedLine.length;
    start = Math.max(0, end - maxLength);
  }

  return normalizedLine.slice(start, end);
}

export function resolveWikilinkPathInWorkspace(
  currentWorkspace: string,
  target: string,
): string | null {
  const trimmedTarget = target.trim();
  if (!trimmedTarget) {
    return null;
  }

  const hasSeparator = trimmedTarget.includes('/') || trimmedTarget.includes('\\');
  if (hasSeparator) {
    for (const candidate of getWikilinkTargetCandidates(trimmedTarget)) {
      const directPath = joinWikilinkPath(currentWorkspace, candidate);
      if (existsSync(directPath) && statSync(directPath).isFile()) {
        return directPath;
      }
    }
  }

  const targetBasenameCandidates = new Set(
    getWikilinkTargetCandidates(getWikilinkBasename(trimmedTarget))
      .map((candidate) => candidate.toLowerCase()),
  );
  const exactRelativeCandidates = new Set(
    getWikilinkTargetCandidates(trimmedTarget)
      .map((candidate) => normalizeExactWikilinkRelativeTarget(candidate))
      .filter(Boolean),
  );
  const looseRelativeCandidates = new Set(
    getWikilinkTargetCandidates(trimmedTarget)
      .map((candidate) => normalizeLooseWikilinkSegments(splitWikilinkTarget(candidate)))
      .filter(Boolean),
  );
  const looseBasenameCandidates = new Set(
    getWikilinkTargetCandidates(getWikilinkBasename(trimmedTarget))
      .map((candidate) => normalizeLooseWikilinkName(candidate))
      .filter(Boolean),
  );

  let exactRelativeMatch: string | null = null;
  let exactBasenameMatch: string | null = null;
  let looseRelativeMatch: string | null = null;
  let looseBasenameMatch: string | null = null;

  function walk(dir: string, depth: number): void {
    if ((exactRelativeMatch !== null) || (exactBasenameMatch && !hasSeparator) || depth > 8) return;

    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Files first (shallow preference), then directories.
    for (const entry of entries) {
      if ((exactRelativeMatch !== null) || (exactBasenameMatch && !hasSeparator)) return;
      if (!entry.isFile()) continue;
      const fullPath = pathJoin(dir, entry.name);
      const relativePath = getTreeRelativePath(currentWorkspace, fullPath);

      if (
        hasSeparator &&
        exactRelativeCandidates.has(normalizeExactWikilinkRelativeTarget(relativePath))
      ) {
        exactRelativeMatch = fullPath;
        return;
      }

      if (targetBasenameCandidates.has(entry.name.toLowerCase())) {
        exactBasenameMatch ??= fullPath;
        if (!hasSeparator) {
          return;
        }
      }

      if (
        hasSeparator &&
        looseRelativeMatch === null &&
        looseRelativeCandidates.has(normalizeLooseWikilinkSegments(splitWikilinkTarget(relativePath)))
      ) {
        looseRelativeMatch = fullPath;
      }

      if (
        looseBasenameMatch === null &&
        looseBasenameCandidates.has(normalizeLooseWikilinkName(entry.name))
      ) {
        looseBasenameMatch = fullPath;
      }
    }

    for (const entry of entries) {
      if ((exactRelativeMatch !== null) || (exactBasenameMatch && !hasSeparator)) return;
      if (!entry.isDirectory()) continue;
      if (WIKILINK_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(pathJoin(dir, entry.name), depth + 1);
    }
  }

  walk(currentWorkspace, 0);
  if (hasSeparator) {
    return exactRelativeMatch ?? looseRelativeMatch ?? exactBasenameMatch ?? looseBasenameMatch;
  }

  return exactBasenameMatch ?? looseBasenameMatch;
}

async function buildFileTreeWithProgress(
  dirPath: string,
  basePath: string = dirPath,
  depth: number = 0,
  maxDepth: number = 0,
  includeThumbnails: boolean = false,
  onProgress?: ProgressCallback
): Promise<FileTreeNode[]> {
  const items: FileTreeNode[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    // Separate files and directories
    const files: Array<{ entry: any; fullPath: string; relativePath: string }> = [];
    const directories: FileTreeNode[] = [];
    const runnableProjectLookups: Promise<void>[] = [];

    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules'
      ) {
        continue;
      }

      const fullPath = pathJoin(dirPath, entry.name);
      const relativePath = getTreeRelativePath(basePath, fullPath);

      if (entry.isDirectory()) {
        const directoryNode: FileTreeNode = {
          name: entry.name,
          path: relativePath,
          type: 'directory',
        };
        directories.push(directoryNode);
        runnableProjectLookups.push((async () => {
          const runnableProject = await detectRunnableProject(fullPath);
          if (runnableProject) {
            directoryNode.runnableProject = runnableProject;
          }
        })());
      } else if (entry.isFile()) {
        files.push({ entry, fullPath, relativePath });
      }
    }

    await Promise.all(runnableProjectLookups);

    // Process directories recursively
    for (const dir of directories) {
      const fullPath = pathJoin(basePath, dir.path);
      const node: FileTreeNode = {
        ...dir,
        children: depth < maxDepth ? await buildFileTreeWithProgress(fullPath, basePath, depth + 1, maxDepth, includeThumbnails, onProgress) : undefined
      };
      items.push(node);
    }

    let dimensions: Map<string, DimensionResult> | undefined;
    let fileIcons: Map<string, string> | undefined;
    if (includeThumbnails && files.length > 0) {
      const filePaths = files.map(f => f.fullPath);
      [dimensions, fileIcons] = await Promise.all([
        thumbnailService.batchGetDimensions(filePaths),
        thumbnailService.batchGetFileIcons(filePaths),
      ]);
    }

    for (const { entry, fullPath, relativePath } of files) {
      const stat = statSync(fullPath);
      const dims = dimensions?.get(fullPath);
      const icon = fileIcons?.get(fullPath);
      items.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
        mtime: stat.mtime.getTime(),
        thumbnailWidth: dims?.width,
        thumbnailHeight: dims?.height,
        fileIcon: icon,
      });
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error);
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export async function buildFileTree(dirPath: string, basePath: string = dirPath, depth: number = 0, maxDepth: number = 0, includeThumbnails: boolean = false): Promise<FileTreeNode[]> {
  const items: FileTreeNode[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    // Separate files and directories for batch processing
    const files: Array<{ entry: any; fullPath: string; relativePath: string }> = [];
    const directories: FileTreeNode[] = [];
    const runnableProjectLookups: Promise<void>[] = [];

    for (const entry of entries) {
      // Skip hidden files and common ignore patterns
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules'
      ) {
        continue;
      }

      const fullPath = pathJoin(dirPath, entry.name);
      const relativePath = getTreeRelativePath(basePath, fullPath);

      if (entry.isDirectory()) {
        const directoryNode: FileTreeNode = {
          name: entry.name,
          path: relativePath,
          type: 'directory',
        };
        directories.push(directoryNode);
        runnableProjectLookups.push((async () => {
          const runnableProject = await detectRunnableProject(fullPath);
          if (runnableProject) {
            directoryNode.runnableProject = runnableProject;
          }
        })());
      } else if (entry.isFile()) {
        files.push({ entry, fullPath, relativePath });
      }
    }

    await Promise.all(runnableProjectLookups);

    // Process directories recursively
    for (const dir of directories) {
      const fullPath = pathJoin(basePath, dir.path);
      const node: FileTreeNode = {
        ...dir,
        // Only recurse if we haven't hit max depth (0 = top level only)
        children: depth < maxDepth ? await buildFileTree(fullPath, basePath, depth + 1, maxDepth, includeThumbnails) : undefined
      };
      items.push(node);
    }

    let dimensions: Map<string, DimensionResult> | undefined;
    let fileIcons: Map<string, string> | undefined;
    if (includeThumbnails && files.length > 0) {
      const filePaths = files.map(f => f.fullPath);
      [dimensions, fileIcons] = await Promise.all([
        thumbnailService.batchGetDimensions(filePaths),
        thumbnailService.batchGetFileIcons(filePaths),
      ]);
    }

    for (const { entry, fullPath, relativePath } of files) {
      const stat = statSync(fullPath);
      const dims = dimensions?.get(fullPath);
      const icon = fileIcons?.get(fullPath);
      items.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
        mtime: stat.mtime.getTime(),
        thumbnailWidth: dims?.width,
        thumbnailHeight: dims?.height,
        fileIcon: icon,
      });
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error);
  }

  // Sort: directories first, then files, both alphabetically
  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export function registerWorkspaceCoreRoutes(
  targetRouter: Router,
  deps: WorkspaceCoreRouteDeps = defaultWorkspaceCoreRouteDeps,
): void {
  targetRouter.post("/", async (req: Request, res: Response) => {
    try {
      const { path: workspacePath } = req.body;

      // Use the handler which validates, saves, restarts watcher, and broadcasts
      await deps.setWorkspaceHandler(workspacePath);

      res.json({ workspace: deps.getCurrentWorkspace() });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to set workspace" });
    }
  });

  targetRouter.get("/", async (_req: Request, res: Response) => {
    try {
      res.json(await deps.getWorkspaceHandler());
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to get workspace" });
    }
  });

  targetRouter.get("/files", async (req: Request, res: Response) => {
    try {
      const { workspace: currentWorkspace } = await deps.getWorkspaceHandler();
      if (!currentWorkspace) {
        return res.status(400).json({ error: "No workspace set" });
      }

      if (!existsSync(currentWorkspace)) {
        return res.status(404).json({ error: "Workspace path no longer exists" });
      }

      const streamProgress = req.query.stream === 'true';

      if (streamProgress) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const files = await buildFileTreeWithProgress(
          currentWorkspace,
          currentWorkspace,
          0,
          1,
          true,
          (current, total, phase) => {
            if (phase !== 'processing') return;
            const progress = total > 0 ? Math.floor((current / total) * 100) : 0;
            res.write(`data: ${JSON.stringify({ progress, current, total, phase })}\n\n`);
          }
        );

        deps.writeFileTreeCache(currentWorkspace, files);
        res.write(`data: ${JSON.stringify({ done: true, files })}\n\n`);
        res.end();
      } else {
        const files = await buildFileTree(currentWorkspace, currentWorkspace, 0, 1, true);
        deps.writeFileTreeCache(currentWorkspace, files);
        res.json({ files });
      }
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to get workspace files" });
    }
  });
}

registerWorkspaceCoreRoutes(router);

// Get children of a specific folder (for lazy loading)
router.get("/folder-children", async (req: Request, res: Response) => {
  try {
    const currentWorkspace = await getActiveWorkspacePath();
    if (!currentWorkspace) {
      return res.status(400).json({ error: "No workspace set" });
    }

    const { path: folderPath } = req.query;

    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ error: "folder path is required" });
    }

    // Resolve the full path (folderPath is relative to workspace)
    // NOTE: Use path.normalize instead of normalizePath here because the folderPath
    // comes from the filesystem (via readdirSync in buildFileTree) and may contain
    // Unicode characters like smart quotes (e.g., Kiman's). normalizePath converts
    // these to ASCII equivalents which breaks existsSync.
    const fullPath = pathNormalize(pathJoin(currentWorkspace, folderPath));

    if (!existsSync(fullPath)) {
      console.error(`[folder-children] Path does not exist: "${fullPath}" (folderPath: "${folderPath}")`);
      return res.status(404).json({ error: `Folder path does not exist: ${folderPath}` });
    }

    // Security check: resolve symlinks and ensure the real path is within the workspace
    const realPath = realpathSync(fullPath);
    const realWorkspace = realpathSync(currentWorkspace);

    if (realPath !== realWorkspace && !realPath.startsWith(realWorkspace + pathSep)) {
      return res.status(403).json({ error: "Access denied: path outside workspace" });
    }

    const stats = statSync(realPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory" });
    }

    // Load 1 level deep WITH thumbnails for instant, smooth experience
    // This pre-loads the next level so folder expansion feels instant
    const children = await buildFileTree(realPath, currentWorkspace, 0, 1, true);
    res.json({ children });
  } catch (error: any) {
    console.error(`[folder-children] Error:`, error?.message || error);
    res.status(500).json({ error: error?.message || "Failed to get folder children" });
  }
});

// Add a folder to file watching (when expanded in UI)
router.post("/watch", async (req: Request, res: Response) => {
  try {
    const currentWorkspace = await getActiveWorkspacePath();
    if (!currentWorkspace) {
      return res.status(400).json({ error: "No workspace set" });
    }

    const { path: folderPath } = req.body;
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ error: "folder path is required" });
    }

    // Resolve full path (folderPath is relative to workspace)
    // NOTE: Use path.normalize instead of normalizePath to preserve Unicode characters
    // in filesystem paths (e.g., smart quotes in folder names like "Kiman's")
    const fullPath = pathNormalize(pathJoin(currentWorkspace, folderPath));

    if (!existsSync(fullPath)) {
      return res.status(404).json({ error: "Folder does not exist" });
    }

    // Security check: resolve symlinks and ensure the real path is within the workspace
    const realPath = realpathSync(fullPath);
    const realWorkspace = realpathSync(currentWorkspace);

    if (realPath !== realWorkspace && !realPath.startsWith(realWorkspace + pathSep)) {
      return res.status(403).json({ error: "Access denied: path outside workspace" });
    }

    const stats = statSync(realPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory" });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to add watch" });
  }
});

// Remove a folder from file watching (when collapsed in UI)
router.delete("/watch", async (req: Request, res: Response) => {
  try {
    const currentWorkspace = await getActiveWorkspacePath();
    if (!currentWorkspace) {
      return res.status(400).json({ error: "No workspace set" });
    }

    const { path: folderPath } = req.query;
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ error: "folder path is required" });
    }

    // Resolve full path - use path.normalize to preserve Unicode characters
    const fullPath = pathNormalize(pathJoin(currentWorkspace, folderPath));

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to remove watch" });
  }
});

// Get thumbnails for specific files (works for any file, not just workspace)
router.post("/thumbnails", async (req: Request, res: Response) => {
  try {
    const { paths, size } = req.body;
    if (!Array.isArray(paths)) {
      return res.status(400).json({ error: "paths array is required" });
    }
    const currentWorkspace = await getActiveWorkspacePath();
    const hasRelativePaths = paths.some((inputPath: string) => !inputPath.startsWith('/') && !inputPath.match(/^[A-Za-z]:/));
    if (hasRelativePaths && !currentWorkspace) {
      return res.status(400).json({ error: "No workspace set for relative paths" });
    }

    const { getFileThumbnails } = await import('../handlers/files');
    res.json(await getFileThumbnails(paths, size ?? 64, currentWorkspace));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to get thumbnails" });
  }
});

// Full-text content search across the current workspace using ripgrep.
// Returns up to `limit` matches as { path, line, text, column }.
// Literal (fixed-string) match; respects .gitignore by default.
router.get("/search-content", async (req: Request, res: Response) => {
  try {
    const currentWorkspace = await getActiveWorkspacePath();
    if (!currentWorkspace) {
      return res.status(400).json({ error: "No workspace set" });
    }

    const rawQuery = typeof req.query.q === 'string' ? req.query.q : '';
    const query = normalizeWorkspaceContentSearchQuery(rawQuery);
    if (!query || query.length === 0) {
      return res.json({ matches: [] });
    }
    if (query.length > 200) {
      return res.status(400).json({ error: "query too long" });
    }

    const parsedLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;

    const rgBinary = resolveRipgrepBinaryPath(rgPath.rgPath);
    if (!existsSync(rgBinary)) {
      return res.status(500).json({ error: "ripgrep binary not found" });
    }

    const args = [
      '--json',
      '--fixed-strings',
      '--ignore-case',
      '--max-count', '3',              // up to 3 matches per file
      '--max-filesize', '2M',
      '--hidden',
      '--glob', '!.git',
      '--glob', '!node_modules',
      '--glob', '!.obsidian',
      '--',
      query,
      currentWorkspace,
    ];

    const rg = spawn(rgBinary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });

    type ContentMatch = { path: string; line: number; column: number; text: string };
    const matches: ContentMatch[] = [];
    let stdoutBuffer = '';
    let hitLimit = false;

    rg.stdout.on('data', (chunk: Buffer) => {
      if (hitLimit) return;
      stdoutBuffer += chunk.toString('utf8');
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf('\n')) >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!rawLine) continue;
        let event: any;
        try {
          event = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (event?.type !== 'match') continue;
        const data = event.data;
        const filePath: string | undefined = data?.path?.text;
        const lineNumber: number | undefined = data?.line_number;
        const lineText: string | undefined = data?.lines?.text;
        const firstSubmatch = Array.isArray(data?.submatches) && data.submatches.length > 0 ? data.submatches[0] : null;
        const column = typeof firstSubmatch?.start === 'number' ? firstSubmatch.start + 1 : 1;
        if (!filePath || typeof lineNumber !== 'number' || typeof lineText !== 'string') continue;
        matches.push({
          path: filePath,
          line: lineNumber,
          column,
          text: buildWorkspaceContentSearchSnippet(lineText, query),
        });
        if (matches.length >= limit) {
          hitLimit = true;
          rg.kill();
          return;
        }
      }
    });

    rg.stderr.on('data', () => { /* swallow */ });

    rg.on('close', () => {
      res.json({ matches });
    });

    rg.on('error', (error) => {
      console.error('[search-content] ripgrep error', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'ripgrep failed' });
      }
    });
  } catch (error: any) {
    console.error('[search-content] failed', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error?.message || "Search failed" });
    }
  }
});

// Resolve an Obsidian-style wikilink target ([[Page Name]]) to an absolute
// markdown file path within the current workspace. Walks the workspace
// directory tree, matching the filename (with or without .md/.markdown)
// case-insensitively.
// Returns the first match, preferring shallow/earlier hits.
router.get("/resolve-wikilink", async (req: Request, res: Response) => {
  try {
    const currentWorkspace = await getActiveWorkspacePath();
    if (!currentWorkspace) {
      return res.status(400).json({ error: "No workspace set" });
    }

    const target = typeof req.query.target === 'string' ? req.query.target.trim() : '';
    if (!target) {
      return res.status(400).json({ error: "target is required" });
    }

    return res.json({ path: await resolveVaultWikilinkPath(target, currentWorkspace) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to resolve wikilink" });
  }
});

// Returns the list of recent workspace folders (most recently opened first).
router.get("/recent", async (_req: Request, res: Response) => {
  try {
    const folders = await getRecentFolders();
    const filtered = folders.filter((folder) => existsSync(folder.path));
    res.json({ folders: filtered });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to load recent folders" });
  }
});

// Scans common filesystem roots for note workspaces that have app-specific
// markers on disk (for example Obsidian, Logseq, Dendron, and Foam).
router.get("/detect-note-workspaces", async (_req: Request, res: Response) => {
  try {
    const workspaces = scanForNoteWorkspaces();
    res.json({ workspaces });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to scan for note workspaces" });
  }
});

// Classifies the current workspace (or a supplied path) as obsidian-vault,
// wiki, markdown-heavy, or general. Used by the UI to pick context-aware
// suggestion pills and onboarding hints.
router.get("/type", async (req: Request, res: Response) => {
  try {
    const overridePath = typeof req.query.path === 'string' ? req.query.path : null;
    const targetPath = await getActiveWorkspacePath(overridePath);
    if (!targetPath) {
      return res.status(400).json({ error: "No workspace set" });
    }
    const report = detectWorkspaceType(targetPath);
    res.json({ path: targetPath, ...report });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to detect workspace type" });
  }
});

export default router;
