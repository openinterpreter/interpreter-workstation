import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import {
  basename as pathBasename,
  dirname as pathDirname,
  extname,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  normalize as pathNormalize,
  relative as pathRelative,
  resolve as pathResolve,
  sep as pathSep,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractMarkdownFrontmatter } from '../../src/utils/markdownFrontmatter';
import { normalizeLooseWikilinkName, normalizeLooseWikilinkSegments } from '../../shared/wikilinkMatching';
import {
  getWikilinkBasename,
  getWikilinkTargetCandidates,
  normalizeExactWikilinkRelativeTarget,
  splitWikilinkTarget,
} from '../../shared/wikilinkTargets';
import type {
  VaultBrokenLink,
  VaultBrokenLinkSummary,
  VaultLintNoteSummary,
  VaultLintReport,
  VaultNoteContext,
  VaultNoteRecord,
  VaultResolvedLink,
  VaultSearchResult,
  VaultSnapshot,
  VaultTagSummary,
} from '../../shared/types/vault';
import { getCurrentWorkspace } from './workspace';

const NOTE_EXTENSIONS = new Set(['.md', '.markdown']);
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', '.obsidian', 'dist', 'build', '.trash']);

interface ParsedWikilink {
  target: string;
  fragment: string | null;
  display: string | null;
}

interface InternalNoteRecord {
  path: string;
  title: string;
  relativePath: string;
  aliases: string[];
  tags: string[];
  headings: string[];
  modifiedTime: number;
  exactRelativeTarget: string;
  looseRelativeTarget: string;
  exactBasenameCandidates: Set<string>;
  exactAliasCandidates: Set<string>;
  looseAliasCandidates: Set<string>;
  parsedLinks: ParsedWikilink[];
  localMarkdownLinkPaths: string[];
}

interface SnapshotCacheEntry {
  snapshot: VaultSnapshot;
  noteByPath: Map<string, VaultNoteRecord>;
  orderedNotes: InternalNoteRecord[];
  markdownReferringPathsByTarget: Map<string, string[]>;
}

interface SnapshotComputationResult {
  snapshot: VaultSnapshot;
  noteByPath: Map<string, VaultNoteRecord>;
  orderedNotes: InternalNoteRecord[];
  markdownReferringPathsByTarget: Map<string, string[]>;
}

export interface PreparedVaultRename {
  workspacePath: string;
  sourcePath: string;
  referringPaths: string[];
  rewriteDestinationPath: boolean;
  internalNotes: InternalNoteRecord[];
}

const snapshotCache = new Map<string, SnapshotCacheEntry>();
const invalidatedWorkspaces = new Set<string>();

function normalizeRelativePath(value: string): string {
  return pathSep === '/' ? value : value.split(pathSep).join('/');
}

function stripMarkdownFileExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '');
}

function normalizeVaultSearchQuery(query: string): string {
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

function encodeMarkdownHrefPath(pathValue: string): string {
  return pathValue.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function decodeMarkdownHrefPath(pathValue: string): string {
  try {
    return decodeURIComponent(pathValue);
  } catch {
    return pathValue;
  }
}

function getNoteTitle(relativePath: string, body: string, frontmatterData: Record<string, unknown>): string {
  const frontmatterTitle = frontmatterData.title;
  if (typeof frontmatterTitle === 'string' && frontmatterTitle.trim().length > 0) {
    return frontmatterTitle.trim();
  }

  for (const rawLine of body.split(/\r?\n/)) {
    const headingMatch = rawLine.match(/^#\s+(.+?)\s*$/);
    if (headingMatch?.[1]) {
      return headingMatch[1].trim();
    }
  }

  return stripMarkdownFileExtension(pathBasename(relativePath));
}

function extractAliases(frontmatterData: Record<string, unknown>): string[] {
  const rawAliases = frontmatterData.aliases ?? frontmatterData.alias;
  if (typeof rawAliases === 'string') {
    const trimmed = rawAliases.trim();
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(rawAliases)) {
    return [];
  }

  const seen = new Set<string>();
  const aliases: string[] = [];

  for (const value of rawAliases) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    aliases.push(trimmed);
  }

  return aliases;
}

function extractFrontmatterTags(frontmatterData: Record<string, unknown>): string[] {
  const rawTags = frontmatterData.tags ?? frontmatterData.tag;
  const tags = new Set<string>();

  const addTag = (value: string) => {
    const trimmed = value.trim().replace(/^#+/, '');
    if (trimmed) {
      tags.add(trimmed);
    }
  };

  if (typeof rawTags === 'string') {
    for (const part of rawTags.split(',')) {
      addTag(part);
    }
  } else if (Array.isArray(rawTags)) {
    for (const entry of rawTags) {
      if (typeof entry === 'string') {
        addTag(entry);
      }
    }
  }

  return Array.from(tags);
}

function extractInlineTags(body: string): string[] {
  const tags = new Set<string>();
  const lines = body.split(/\r?\n/);
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const matches = line.matchAll(/(^|[^\w/])#([A-Za-z0-9/_-]+)/g);
    for (const match of matches) {
      const value = match[2]?.trim();
      if (value) {
        tags.add(value);
      }
    }
  }

  return Array.from(tags);
}

function extractHeadings(body: string): string[] {
  const headings: string[] = [];
  const lines = body.split(/\r?\n/);
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch?.[1]) {
      headings.push(headingMatch[1].trim());
    }
  }

  return headings;
}

function extractWikilinks(body: string): ParsedWikilink[] {
  const links: ParsedWikilink[] = [];
  const lines = body.split(/\r?\n/);
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const matches = line.matchAll(/\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g);
    for (const match of matches) {
      const rawTarget = match[1]?.trim();
      if (!rawTarget) {
        continue;
      }

      const hashIndex = rawTarget.indexOf('#');
      const target = hashIndex >= 0 ? rawTarget.slice(0, hashIndex).trim() : rawTarget;
      const fragment = hashIndex >= 0 ? rawTarget.slice(hashIndex + 1).trim() || null : null;
      const display = match[2]?.trim() || null;

      if (!target) {
        continue;
      }

      links.push({
        target,
        fragment,
        display,
      });
    }
  }

  return links;
}

type ParsedMarkdownLocalHref = {
  path: string;
  fragment: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  kind: 'file-url' | 'absolute' | 'relative';
  trailingSeparator: boolean;
};

const EXTERNAL_MARKDOWN_LINK_PREFIXES = ['http://', 'https://', 'mailto:', 'tel:', 'data:', 'blob:', 'browser://'];

function parseMarkdownLocalHref(href: string): ParsedMarkdownLocalHref | null {
  const trimmedHref = href.trim();
  if (!trimmedHref || trimmedHref.startsWith('#')) {
    return null;
  }

  for (const prefix of EXTERNAL_MARKDOWN_LINK_PREFIXES) {
    if (trimmedHref.startsWith(prefix)) {
      return null;
    }
  }

  let remaining = trimmedHref;
  let kind: ParsedMarkdownLocalHref['kind'];

  if (remaining.startsWith('file://')) {
    kind = 'file-url';
    remaining = remaining.slice(7);
    if (remaining.startsWith('/') && /^\/[A-Za-z]:/.test(remaining)) {
      remaining = remaining.slice(1);
    }
  } else if (pathIsAbsolute(remaining)) {
    kind = 'absolute';
  } else {
    if (remaining.includes('://')) {
      return null;
    }
    kind = 'relative';
  }

  const lineRangeMatch = remaining.match(/:L(\d+)(?:-L?(\d+))?$/);
  let lineStart: number | null = null;
  let lineEnd: number | null = null;
  if (lineRangeMatch) {
    lineStart = Number.parseInt(lineRangeMatch[1], 10);
    lineEnd = lineRangeMatch[2] ? Number.parseInt(lineRangeMatch[2], 10) : null;
    remaining = remaining.slice(0, -lineRangeMatch[0].length);
  }

  const hashIndex = remaining.indexOf('#');
  const fragment = hashIndex >= 0 ? remaining.slice(hashIndex + 1).trim() || null : null;
  const rawPath = hashIndex >= 0 ? remaining.slice(0, hashIndex) : remaining;
  const decodedPath = decodeMarkdownHrefPath(rawPath);
  if (!decodedPath) {
    return null;
  }

  const trailingSeparator = decodedPath.endsWith('/') || decodedPath.endsWith('\\');
  if (trailingSeparator) {
    return null;
  }

  return {
    path: kind === 'relative' ? decodedPath : pathNormalize(decodedPath),
    fragment,
    lineStart,
    lineEnd,
    kind,
    trailingSeparator,
  };
}

function resolveMarkdownLocalHrefPath(href: string, referringPath: string): string | null {
  const parsedHref = parseMarkdownLocalHref(href);
  if (!parsedHref) {
    return null;
  }

  if (parsedHref.kind === 'relative') {
    return pathResolve(pathDirname(referringPath), parsedHref.path);
  }

  return pathResolve(parsedHref.path);
}

function buildUpdatedMarkdownLocalHref(
  href: string,
  sourcePath: string,
  destinationPath: string,
  referringPath: string,
  label: string,
): { href: string; label: string } | null {
  const parsedHref = parseMarkdownLocalHref(href);
  if (!parsedHref) {
    return null;
  }

  let nextPath: string;
  if (parsedHref.kind === 'relative') {
    nextPath = pathRelative(pathDirname(referringPath), destinationPath);
  } else {
    nextPath = destinationPath;
  }

  if (!nextPath) {
    nextPath = pathBasename(destinationPath);
  }

  let nextHref: string;
  if (parsedHref.kind === 'file-url') {
    nextHref = pathToFileURL(destinationPath).toString();
  } else {
    const prefersBackslashes = parsedHref.path.includes('\\') && !parsedHref.path.includes('/');
    const normalizedPath = prefersBackslashes ? nextPath : normalizeRelativePath(nextPath);
    nextHref = encodeMarkdownHrefPath(normalizedPath);
  }

  if (parsedHref.fragment) {
    nextHref += `#${parsedHref.fragment}`;
  }
  if (parsedHref.lineStart !== null) {
    nextHref += `:L${parsedHref.lineStart}${parsedHref.lineEnd !== null ? `-L${parsedHref.lineEnd}` : ''}`;
  }

  const sourceBasename = pathBasename(sourcePath);
  const destinationBasename = pathBasename(destinationPath);
  const sourceNoteName = stripMarkdownFileExtension(sourceBasename);
  const destinationNoteName = stripMarkdownFileExtension(destinationBasename);

  let nextLabel = label;
  if (label === sourceBasename) {
    nextLabel = destinationBasename;
  } else if (label === sourceNoteName) {
    nextLabel = destinationNoteName;
  }

  return {
    href: nextHref,
    label: nextLabel,
  };
}

function extractResolvedMarkdownLocalLinkPaths(body: string, notePath: string): string[] {
  const resolvedPaths = new Set<string>();
  const lines = body.split(/\r?\n/);
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    for (const match of line.matchAll(/(?<!!)\[([^\]\n]+?)\]\(([^)\n]+?)\)/g)) {
      const href = match[2]?.trim();
      if (!href) {
        continue;
      }

      const resolvedPath = resolveMarkdownLocalHrefPath(href, notePath);
      if (resolvedPath) {
        resolvedPaths.add(resolvedPath);
      }
    }
  }

  return Array.from(resolvedPaths);
}

function rewriteMarkdownReferences(
  markdown: string,
  referringPath: string,
  prepared: PreparedVaultRename,
  destinationPath: string,
): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let changed = false;

  const nextLines = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      return line;
    }

    if (inFence) {
      return line;
    }

    let nextLine = line.replace(
      /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g,
      (fullMatch, matchedTarget: string, matchedDisplay?: string) => {
        const trimmedTarget = matchedTarget.trim();
        if (!trimmedTarget) {
          return fullMatch;
        }

        const hashIndex = trimmedTarget.indexOf('#');
        const target = hashIndex >= 0 ? trimmedTarget.slice(0, hashIndex).trim() : trimmedTarget;
        const fragment = hashIndex >= 0 ? trimmedTarget.slice(hashIndex + 1).trim() || null : null;
        const resolvedPath = resolveTargetPath(prepared.internalNotes, target);
        if (resolvedPath !== prepared.sourcePath) {
          return fullMatch;
        }

        const updatedTarget = buildUpdatedTarget(target, destinationPath, prepared.workspacePath);
        const targetWithFragment = fragment ? `${updatedTarget}#${fragment}` : updatedTarget;
        const display = matchedDisplay?.trim();
        changed = true;
        return display ? `[[${targetWithFragment}|${display}]]` : `[[${targetWithFragment}]]`;
      },
    );

    nextLine = nextLine.replace(
      /(?<!!)\[([^\]\n]+?)\]\(([^)\n]+?)\)/g,
      (fullMatch, matchedLabel: string, matchedHref: string) => {
        const resolvedPath = resolveMarkdownLocalHrefPath(matchedHref.trim(), referringPath);
        if (resolvedPath !== prepared.sourcePath) {
          return fullMatch;
        }

        const updatedLink = buildUpdatedMarkdownLocalHref(
          matchedHref.trim(),
          prepared.sourcePath,
          destinationPath,
          referringPath,
          matchedLabel,
        );
        if (!updatedLink) {
          return fullMatch;
        }

        changed = true;
        return `[${updatedLink.label}](${updatedLink.href})`;
      },
    );

    return nextLine;
  });

  return changed ? nextLines.join(lineEnding) : markdown;
}

function rewriteMovedNoteRelativeMarkdownLinks(
  markdown: string,
  prepared: PreparedVaultRename,
  destinationPath: string,
): string {
  if (prepared.sourcePath === destinationPath) {
    return markdown;
  }

  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let changed = false;

  const nextLines = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      return line;
    }

    if (inFence) {
      return line;
    }

    return line.replace(
      /(?<!!)\[([^\]\n]+?)\]\(([^)\n]+?)\)/g,
      (fullMatch, matchedLabel: string, matchedHref: string) => {
        const trimmedHref = matchedHref.trim();
        const parsedHref = parseMarkdownLocalHref(trimmedHref);
        if (!parsedHref || parsedHref.kind !== 'relative') {
          return fullMatch;
        }

        const originalTargetPath = resolveMarkdownLocalHrefPath(trimmedHref, prepared.sourcePath);
        if (!originalTargetPath) {
          return fullMatch;
        }

        const nextTargetPath = originalTargetPath === prepared.sourcePath
          ? destinationPath
          : originalTargetPath;
        const updatedLink = buildUpdatedMarkdownLocalHref(
          trimmedHref,
          originalTargetPath,
          nextTargetPath,
          destinationPath,
          matchedLabel,
        );
        if (!updatedLink) {
          return fullMatch;
        }
        if (updatedLink.href === trimmedHref && updatedLink.label === matchedLabel) {
          return fullMatch;
        }

        changed = true;
        return `[${updatedLink.label}](${updatedLink.href})`;
      },
    );
  });

  return changed ? nextLines.join(lineEnding) : markdown;
}

async function collectMarkdownNotes(
  workspacePath: string,
  currentDir: string,
  out: InternalNoteRecord[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = pathJoin(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      await collectMarkdownNotes(workspacePath, fullPath, out);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = extname(entry.name).toLowerCase();
    if (!NOTE_EXTENSIONS.has(extension)) {
      continue;
    }

    const fileStats = await stat(fullPath);
    const markdown = await readFile(fullPath, 'utf-8');
    const parsed = extractMarkdownFrontmatter(markdown);
    const frontmatterData = parsed.frontmatter?.data ?? {};
    const relativePath = normalizeRelativePath(pathRelative(workspacePath, fullPath));
    const aliases = extractAliases(frontmatterData);
    const tags = Array.from(new Set([
      ...extractFrontmatterTags(frontmatterData),
      ...extractInlineTags(parsed.body),
    ])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const headings = extractHeadings(parsed.body);
    const parsedLinks = extractWikilinks(parsed.body);
    const localMarkdownLinkPaths = extractResolvedMarkdownLocalLinkPaths(parsed.body, fullPath);
    const title = getNoteTitle(relativePath, parsed.body, frontmatterData);

    out.push({
      path: fullPath,
      title,
      relativePath,
      aliases,
      tags,
      headings,
      modifiedTime: fileStats.mtimeMs,
      exactRelativeTarget: normalizeExactWikilinkRelativeTarget(relativePath),
      looseRelativeTarget: normalizeLooseWikilinkSegments(splitWikilinkTarget(relativePath)),
      exactBasenameCandidates: new Set(
        getWikilinkTargetCandidates(pathBasename(relativePath)).map((candidate) => candidate.toLowerCase()),
      ),
      exactAliasCandidates: new Set(aliases.map((alias) => alias.toLowerCase())),
      looseAliasCandidates: new Set(aliases.map((alias) => normalizeLooseWikilinkName(alias)).filter(Boolean)),
      parsedLinks,
      localMarkdownLinkPaths,
    });
  }
}

function rankNotesForMatching(notes: InternalNoteRecord[]): InternalNoteRecord[] {
  return [...notes].sort((a, b) => {
    const depthDelta = a.relativePath.split('/').length - b.relativePath.split('/').length;
    if (depthDelta !== 0) {
      return depthDelta;
    }

    return a.relativePath.localeCompare(b.relativePath, undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  });
}

function resolveTargetPath(notes: InternalNoteRecord[], target: string): string | null {
  const trimmedTarget = target.trim();
  if (!trimmedTarget) {
    return null;
  }

  const hasSeparator = trimmedTarget.includes('/') || trimmedTarget.includes('\\');
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
  const exactBasenameCandidates = new Set(
    getWikilinkTargetCandidates(getWikilinkBasename(trimmedTarget))
      .map((candidate) => candidate.toLowerCase()),
  );
  const looseBasenameCandidates = new Set(
    getWikilinkTargetCandidates(getWikilinkBasename(trimmedTarget))
      .map((candidate) => normalizeLooseWikilinkName(candidate))
      .filter(Boolean),
  );

  let exactBaseMatch: string | null = null;
  let exactAliasMatch: string | null = null;
  let looseRelativeMatch: string | null = null;
  let looseAliasMatch: string | null = null;
  let looseBaseMatch: string | null = null;

  for (const note of notes) {
    if (hasSeparator && exactRelativeCandidates.has(note.exactRelativeTarget)) {
      return note.path;
    }

    for (const candidate of note.exactBasenameCandidates) {
      if (!exactBasenameCandidates.has(candidate)) {
        continue;
      }
      exactBaseMatch ??= note.path;
      if (!hasSeparator) {
        return note.path;
      }
      break;
    }

    if (!hasSeparator) {
      for (const alias of note.exactAliasCandidates) {
        if (!exactBasenameCandidates.has(alias)) {
          continue;
        }
        exactAliasMatch ??= note.path;
        break;
      }
    }

    if (hasSeparator && looseRelativeMatch === null && looseRelativeCandidates.has(note.looseRelativeTarget)) {
      looseRelativeMatch = note.path;
    }

    if (!hasSeparator && looseAliasMatch === null) {
      for (const alias of note.looseAliasCandidates) {
        if (looseBasenameCandidates.has(alias)) {
          looseAliasMatch = note.path;
          break;
        }
      }
    }

    if (looseBaseMatch === null) {
      for (const candidate of note.exactBasenameCandidates) {
        if (looseBasenameCandidates.has(normalizeLooseWikilinkName(candidate))) {
          looseBaseMatch = note.path;
          break;
        }
      }
    }
  }

  if (looseRelativeMatch) {
    return looseRelativeMatch;
  }

  if (exactAliasMatch) {
    return exactAliasMatch;
  }

  if (exactBaseMatch) {
    return exactBaseMatch;
  }

  if (looseAliasMatch) {
    return looseAliasMatch;
  }

  return looseBaseMatch;
}

async function computeSnapshot(workspacePath: string): Promise<SnapshotComputationResult> {
  const internalNotes: InternalNoteRecord[] = [];
  await collectMarkdownNotes(workspacePath, workspacePath, internalNotes);
  const orderedNotes = rankNotesForMatching(internalNotes);
  const noteByPath = new Map<string, VaultNoteRecord>();
  const markdownReferringPathsByTarget = new Map<string, Set<string>>();

  for (const note of orderedNotes) {
    noteByPath.set(note.path, {
      path: note.path,
      title: note.title,
      relativePath: note.relativePath,
      aliases: note.aliases,
      tags: note.tags,
      headings: note.headings,
      outgoingLinks: [],
      backlinks: [],
      brokenLinks: [],
      modifiedTime: note.modifiedTime,
    });

    for (const targetPath of note.localMarkdownLinkPaths) {
      const referringPaths = markdownReferringPathsByTarget.get(targetPath) ?? new Set<string>();
      referringPaths.add(note.path);
      markdownReferringPathsByTarget.set(targetPath, referringPaths);
    }
  }

  for (const note of orderedNotes) {
    const outgoingByPath = new Map<string, VaultResolvedLink>();
    const brokenByTarget = new Map<string, VaultBrokenLink>();
    const currentRecord = noteByPath.get(note.path);
    if (!currentRecord) {
      continue;
    }

    for (const parsedLink of note.parsedLinks) {
      const resolvedPath = resolveTargetPath(orderedNotes, parsedLink.target);
      if (!resolvedPath) {
        const brokenKey = `${parsedLink.target}#${parsedLink.fragment ?? ''}|${parsedLink.display ?? ''}`;
        brokenByTarget.set(brokenKey, {
          target: parsedLink.target,
          fragment: parsedLink.fragment,
          display: parsedLink.display,
        });
        continue;
      }

      const targetRecord = noteByPath.get(resolvedPath);
      if (!targetRecord) {
        continue;
      }

      if (!outgoingByPath.has(resolvedPath)) {
        outgoingByPath.set(resolvedPath, {
          target: parsedLink.target,
          fragment: parsedLink.fragment,
          display: parsedLink.display,
          resolvedPath,
          resolvedLabel: targetRecord.title,
          resolvedRelativePath: targetRecord.relativePath,
        });
      }

      if (!targetRecord.backlinks.some((backlink) => backlink.path === note.path)) {
        targetRecord.backlinks.push({
          path: note.path,
          title: currentRecord.title,
          relativePath: currentRecord.relativePath,
        });
      }
    }

    currentRecord.outgoingLinks = Array.from(outgoingByPath.values()).sort((a, b) =>
      a.resolvedLabel.localeCompare(b.resolvedLabel, undefined, { sensitivity: 'base' }),
    );
    currentRecord.brokenLinks = Array.from(brokenByTarget.values()).sort((a, b) =>
      `${a.target}#${a.fragment ?? ''}`.localeCompare(`${b.target}#${b.fragment ?? ''}`, undefined, { sensitivity: 'base' }),
    );
  }

  const notes = Array.from(noteByPath.values()).map((note) => ({
    ...note,
    backlinks: [...note.backlinks].sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    ),
  })).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base', numeric: true }),
  );

  const uniqueTags = new Set(notes.flatMap((note) => note.tags));
  const snapshot: VaultSnapshot = {
    workspacePath,
    builtAt: Date.now(),
    noteCount: notes.length,
    tagCount: uniqueTags.size,
    notes,
  };

  return {
    snapshot,
    noteByPath: new Map(notes.map((note) => [note.path, note])),
    orderedNotes,
    markdownReferringPathsByTarget: new Map(
      Array.from(markdownReferringPathsByTarget.entries()).map(([targetPath, referringPaths]) => [
        targetPath,
        Array.from(referringPaths).sort((left, right) => {
          const leftRelativePath = noteByPath.get(left)?.relativePath ?? left;
          const rightRelativePath = noteByPath.get(right)?.relativePath ?? right;
          return leftRelativePath.localeCompare(rightRelativePath, undefined, {
            sensitivity: 'base',
            numeric: true,
          });
        }),
      ]),
    ),
  };
}

async function getSnapshotCacheEntry(workspacePath: string): Promise<SnapshotCacheEntry> {
  const cached = snapshotCache.get(workspacePath);
  if (cached && !invalidatedWorkspaces.has(workspacePath)) {
    return cached;
  }

  const computed = await computeSnapshot(workspacePath);
  const entry: SnapshotCacheEntry = {
    snapshot: computed.snapshot,
    noteByPath: computed.noteByPath,
    orderedNotes: computed.orderedNotes,
    markdownReferringPathsByTarget: computed.markdownReferringPathsByTarget,
  };
  snapshotCache.set(workspacePath, entry);
  invalidatedWorkspaces.delete(workspacePath);
  return entry;
}

function requireWorkspacePath(workspacePath?: string | null): string {
  const resolvedWorkspace = workspacePath ?? getCurrentWorkspace();
  if (!resolvedWorkspace) {
    throw new Error('No workspace set');
  }

  return resolvedWorkspace;
}

function isMarkdownNotePath(filePath: string): boolean {
  return NOTE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function invalidateVaultIndex(workspacePath: string | null | undefined): void {
  if (!workspacePath) {
    return;
  }

  invalidatedWorkspaces.add(workspacePath);
}

export async function getVaultSnapshot(workspacePath?: string | null): Promise<VaultSnapshot> {
  const resolvedWorkspace = requireWorkspacePath(workspacePath);
  return (await getSnapshotCacheEntry(resolvedWorkspace)).snapshot;
}

export async function getVaultNoteContext(
  filePath: string,
  workspacePath?: string | null,
): Promise<VaultNoteContext> {
  const resolvedWorkspace = requireWorkspacePath(workspacePath);
  const entry = await getSnapshotCacheEntry(resolvedWorkspace);
  return {
    workspacePath: entry.snapshot.workspacePath,
    builtAt: entry.snapshot.builtAt,
    noteCount: entry.snapshot.noteCount,
    tagCount: entry.snapshot.tagCount,
    note: entry.noteByPath.get(filePath) ?? null,
  };
}

export async function resolveVaultWikilinkPath(
  target: string,
  workspacePath?: string | null,
): Promise<string | null> {
  const resolvedWorkspace = requireWorkspacePath(workspacePath);
  const entry = await getSnapshotCacheEntry(resolvedWorkspace);
  return resolveTargetPath(entry.orderedNotes, target);
}

function scoreSearchResult(note: VaultNoteRecord, query: string): number {
  const normalizedQuery = normalizeVaultSearchQuery(query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const normalizedTagQuery = normalizedQuery.startsWith('#')
    ? normalizedQuery.slice(1)
    : normalizedQuery;

  const title = note.title.toLowerCase();
  const relativePath = note.relativePath.toLowerCase();
  let score = 0;

  if (title === normalizedQuery) {
    score += 120;
  } else if (title.startsWith(normalizedQuery)) {
    score += 80;
  } else if (title.includes(normalizedQuery)) {
    score += 50;
  }

  for (const alias of note.aliases) {
    const normalizedAlias = alias.toLowerCase();
    if (normalizedAlias === normalizedQuery) {
      score += 90;
      continue;
    }
    if (normalizedAlias.startsWith(normalizedQuery)) {
      score += 45;
      continue;
    }
    if (normalizedAlias.includes(normalizedQuery)) {
      score += 25;
    }
  }

  if (relativePath.includes(normalizedQuery)) {
    score += 20;
  }

  for (const tag of note.tags) {
    const normalizedTag = tag.toLowerCase();
    if (!normalizedTagQuery) {
      continue;
    }
    if (normalizedTag === normalizedTagQuery) {
      score += 24;
      continue;
    }
    if (normalizedTag.startsWith(normalizedTagQuery)) {
      score += 14;
      continue;
    }
    if (normalizedTag.includes(normalizedTagQuery)) {
      score += 8;
    }
  }

  return score;
}

export async function searchVaultNotes(
  query: string,
  options?: { limit?: number; workspacePath?: string | null },
): Promise<{ results: VaultSearchResult[] }> {
  const resolvedWorkspace = requireWorkspacePath(options?.workspacePath);
  const snapshot = await getVaultSnapshot(resolvedWorkspace);
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
  const normalizedQuery = normalizeVaultSearchQuery(query);

  if (!normalizedQuery) {
    return { results: [] };
  }

  const results = snapshot.notes
    .map((note) => ({
      path: note.path,
      title: note.title,
      relativePath: note.relativePath,
      aliases: note.aliases,
      tags: note.tags,
      score: scoreSearchResult(note, normalizedQuery),
    }))
    .filter((note) => note.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.relativePath.localeCompare(b.relativePath, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    })
    .slice(0, limit);

  return { results };
}

export function buildVaultTagSummaries(
  snapshot: VaultSnapshot,
  options?: { limit?: number },
): { tags: VaultTagSummary[] } {
  const tagMap = new Map<string, VaultTagSummary>();

  for (const note of snapshot.notes) {
    for (const tag of note.tags) {
      const existing = tagMap.get(tag) ?? {
        tag,
        noteCount: 0,
        notes: [],
      };
      existing.noteCount += 1;
      existing.notes.push({
        path: note.path,
        title: note.title,
        relativePath: note.relativePath,
      });
      tagMap.set(tag, existing);
    }
  }

  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
  const tags = Array.from(tagMap.values())
    .map((entry) => ({
      ...entry,
      notes: entry.notes.sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath, undefined, {
          sensitivity: 'base',
          numeric: true,
        }),
      ),
    }))
    .sort((a, b) => {
      if (b.noteCount !== a.noteCount) {
        return b.noteCount - a.noteCount;
      }

      return a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base', numeric: true });
    })
    .slice(0, limit);

  return { tags };
}

export async function getVaultTagSummaries(
  options?: { workspacePath?: string | null; limit?: number },
): Promise<{ tags: VaultTagSummary[] }> {
  const resolvedWorkspace = requireWorkspacePath(options?.workspacePath);
  const snapshot = await getVaultSnapshot(resolvedWorkspace);
  return buildVaultTagSummaries(snapshot, options);
}

function groupBrokenLinks(snapshot: VaultSnapshot): VaultBrokenLinkSummary[] {
  const groups = new Map<string, VaultBrokenLinkSummary>();

  for (const note of snapshot.notes) {
    for (const brokenLink of note.brokenLinks) {
      const key = `${brokenLink.target}#${brokenLink.fragment ?? ''}|${brokenLink.display ?? ''}`;
      const existing = groups.get(key) ?? {
        target: brokenLink.target,
        fragment: brokenLink.fragment,
        display: brokenLink.display,
        referenceCount: 0,
        referringNotes: [],
      };
      existing.referenceCount += 1;
      if (!existing.referringNotes.some((referringNote) => referringNote.path === note.path)) {
        existing.referringNotes.push({
          path: note.path,
          title: note.title,
          relativePath: note.relativePath,
        });
      }
      groups.set(key, existing);
    }
  }

  return Array.from(groups.values())
    .map((entry) => ({
      ...entry,
      referringNotes: entry.referringNotes.sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath, undefined, {
          sensitivity: 'base',
          numeric: true,
        }),
      ),
    }))
    .sort((a, b) => {
      if (b.referenceCount !== a.referenceCount) {
        return b.referenceCount - a.referenceCount;
      }

      return `${a.target}#${a.fragment ?? ''}`.localeCompare(`${b.target}#${b.fragment ?? ''}`, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    });
}

function toLintNoteSummary(note: VaultNoteRecord): VaultLintNoteSummary {
  return {
    path: note.path,
    title: note.title,
    relativePath: note.relativePath,
    outgoingLinkCount: note.outgoingLinks.length,
    backlinkCount: note.backlinks.length,
    brokenLinkCount: note.brokenLinks.length,
    tagCount: note.tags.length,
  };
}

export function buildVaultLintReport(snapshot: VaultSnapshot): VaultLintReport {
  const orphanNotes = snapshot.notes
    .filter((note) => note.backlinks.length === 0)
    .map(toLintNoteSummary)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base', numeric: true }));
  const isolatedNotes = snapshot.notes
    .filter((note) => note.backlinks.length === 0 && note.outgoingLinks.length === 0)
    .map(toLintNoteSummary)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base', numeric: true }));
  const danglingLinks = groupBrokenLinks(snapshot);
  const missingPageCandidates = danglingLinks.filter((entry) => entry.referenceCount >= 2);
  const tags = buildVaultTagSummaries(snapshot, { limit: 1000 }).tags
    .map((entry) => ({
      tag: entry.tag,
      noteCount: entry.noteCount,
    }));

  return {
    workspacePath: snapshot.workspacePath,
    builtAt: snapshot.builtAt,
    noteCount: snapshot.noteCount,
    tagCount: snapshot.tagCount,
    orphanNotes,
    isolatedNotes,
    danglingLinks,
    missingPageCandidates,
    tags,
  };
}

export async function getVaultLintReport(
  options?: { workspacePath?: string | null },
): Promise<VaultLintReport> {
  const resolvedWorkspace = requireWorkspacePath(options?.workspacePath);
  const snapshot = await getVaultSnapshot(resolvedWorkspace);
  return buildVaultLintReport(snapshot);
}

export async function prepareVaultRename(
  sourcePath: string,
  workspacePath?: string | null,
): Promise<PreparedVaultRename | null> {
  if (!isMarkdownNotePath(sourcePath)) {
    return null;
  }

  const resolvedWorkspace = requireWorkspacePath(workspacePath);
  const entry = await getSnapshotCacheEntry(resolvedWorkspace);
  const sourceNote = entry.noteByPath.get(sourcePath);
  if (!sourceNote) {
    return null;
  }

  const referringPaths = new Set<string>();
  let rewriteDestinationPath = false;

  for (const backlink of sourceNote.backlinks) {
    if (backlink.path === sourcePath) {
      rewriteDestinationPath = true;
      continue;
    }

    referringPaths.add(backlink.path);
  }

  for (const referringPath of entry.markdownReferringPathsByTarget.get(sourcePath) ?? []) {
    if (referringPath === sourcePath) {
      rewriteDestinationPath = true;
      continue;
    }

    referringPaths.add(referringPath);
  }

  return {
    workspacePath: resolvedWorkspace,
    sourcePath,
    rewriteDestinationPath,
    referringPaths: Array.from(referringPaths).sort((left, right) => {
      const leftRelativePath = entry.noteByPath.get(left)?.relativePath ?? left;
      const rightRelativePath = entry.noteByPath.get(right)?.relativePath ?? right;
      return leftRelativePath.localeCompare(rightRelativePath, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    }),
    internalNotes: entry.orderedNotes,
  };
}

function buildUpdatedTarget(
  rawTarget: string,
  destinationPath: string,
  workspacePath: string,
): string {
  const hasSeparator = rawTarget.includes('/') || rawTarget.includes('\\');
  const relativeTarget = stripMarkdownFileExtension(
    normalizeRelativePath(pathRelative(workspacePath, destinationPath)),
  );

  if (hasSeparator) {
    return relativeTarget;
  }

  return stripMarkdownFileExtension(pathBasename(destinationPath));
}

export async function applyPreparedVaultRename(
  prepared: PreparedVaultRename | null,
  destinationPath: string,
): Promise<void> {
  if (!prepared) {
    return;
  }

  const rewritePaths = new Set(prepared.referringPaths);
  if (prepared.rewriteDestinationPath || prepared.sourcePath !== destinationPath) {
    rewritePaths.add(destinationPath);
  }

  if (rewritePaths.size === 0) {
    invalidateVaultIndex(prepared.workspacePath);
    return;
  }

  for (const referringPath of rewritePaths) {
    const originalMarkdown = await readFile(referringPath, 'utf-8');
    let nextMarkdown = rewriteMarkdownReferences(
      originalMarkdown,
      referringPath,
      prepared,
      destinationPath,
    );
    if (referringPath === destinationPath) {
      nextMarkdown = rewriteMovedNoteRelativeMarkdownLinks(
        nextMarkdown,
        prepared,
        destinationPath,
      );
    }

    if (nextMarkdown !== originalMarkdown) {
      await writeFile(referringPath, nextMarkdown, 'utf-8');
    }
  }

  invalidateVaultIndex(prepared.workspacePath);
}
