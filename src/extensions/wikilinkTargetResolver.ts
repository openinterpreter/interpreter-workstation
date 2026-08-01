import { getFileCache } from '../stores/fileStore';
import { pathBasename, pathJoin, pathSplit, pathStartsWith, pathStripPrefix } from '@/ipc';
import { getWorkspacePathSnapshot } from '../stores/workspaceStore';
import { stripMarkdownFileExtension } from '../utils/localReferenceDisplay';
import { normalizeLooseWikilinkName, normalizeLooseWikilinkSegments } from '../../shared/wikilinkMatching';

export interface ResolvedWikilink {
  /** Absolute path to the file backing the wikilink. For unresolved targets,
   *  this is a synthetic path under the workspace root so FileSystemProxy has
   *  a stable identity (icon, click handler). */
  path: string;
  /** Display label — the target name without any extension. */
  label: string;
  /** True when an actual workspace file was matched in the cache. */
  found: boolean;
}

function normalizeRelativeWikilinkTarget(target: string): string {
  const segments = pathSplit(target.trim());
  if (segments.length === 0) return '';

  const normalizedSegments = [...segments];
  const lastIndex = normalizedSegments.length - 1;
  normalizedSegments[lastIndex] = stripMarkdownFileExtension(normalizedSegments[lastIndex]);

  return normalizedSegments.map((segment) => segment.toLowerCase()).join('/');
}

function normalizeLooseRelativeWikilinkTarget(target: string): string {
  const segments = pathSplit(target.trim());
  return normalizeLooseWikilinkSegments(segments);
}

/**
 * Resolve an Obsidian-style wikilink target (e.g. "Page Name" or "folder/Page")
 * against the current workspace file cache. Returns an absolute path even if
 * the target is not yet in the cache — callers should use `found` to decide
 * whether to render as resolved or dangling.
 *
 * Matching is case-insensitive by basename. If the target contains a path
 * separator, we also try to match the full relative path directly.
 */
export function resolveWikilinkTarget(
  target: string,
  workspacePathOverride?: string | null,
): ResolvedWikilink {
  const trimmedTarget = target.trim();
  const label = stripMarkdownFileExtension(pathBasename(trimmedTarget) || trimmedTarget);
  const workspacePath = workspacePathOverride === undefined
    ? getWorkspacePathSnapshot()
    : workspacePathOverride;
  const files = getFileCache();
  const needleBase = label.toLowerCase();
  const needleRelative = normalizeRelativeWikilinkTarget(trimmedTarget);
  const looseNeedleBase = normalizeLooseWikilinkName(label);
  const looseNeedleRelative = normalizeLooseRelativeWikilinkTarget(trimmedTarget);
  const hasSeparator = trimmedTarget.includes('/') || trimmedTarget.includes('\\');
  let exactRelativeMatch: ResolvedWikilink | null = null;
  let exactBaseMatch: ResolvedWikilink | null = null;
  let looseRelativeMatch: ResolvedWikilink | null = null;
  let looseBaseMatch: ResolvedWikilink | null = null;

  for (const entry of files) {
    if (entry.type !== 'file') continue;
    if (!/\.(md|markdown)$/i.test(entry.name)) continue;
    const entryBaseNoExt = stripMarkdownFileExtension(entry.name).toLowerCase();
    if (exactBaseMatch === null && entryBaseNoExt === needleBase) {
      exactBaseMatch = { path: entry.path, label, found: true };
    }
    if (workspacePath && pathStartsWith(entry.path, workspacePath)) {
      const entryRelativePath = pathStripPrefix(entry.path, workspacePath);
      if (
        exactRelativeMatch === null &&
        normalizeRelativeWikilinkTarget(entryRelativePath) === needleRelative
      ) {
        exactRelativeMatch = { path: entry.path, label, found: true };
      }

      if (
        looseRelativeMatch === null &&
        normalizeLooseRelativeWikilinkTarget(entryRelativePath) === looseNeedleRelative
      ) {
        looseRelativeMatch = { path: entry.path, label, found: true };
      }
    }

    if (
      looseBaseMatch === null &&
      normalizeLooseWikilinkName(entry.name) === looseNeedleBase
    ) {
      looseBaseMatch = { path: entry.path, label, found: true };
    }
  }

  if (hasSeparator && exactRelativeMatch) {
    return exactRelativeMatch;
  }

  if (hasSeparator) {
    if (looseRelativeMatch) {
      return looseRelativeMatch;
    }
    if (exactBaseMatch) {
      return exactBaseMatch;
    }
  } else if (exactBaseMatch) {
    return exactBaseMatch;
  }

  if (looseRelativeMatch) {
    return looseRelativeMatch;
  }

  if (looseBaseMatch) {
    return looseBaseMatch;
  }

  // Synthetic fallback path so the mention pill has a stable identity.
  const withExt = stripMarkdownFileExtension(trimmedTarget) === trimmedTarget
    ? `${trimmedTarget}.md`
    : trimmedTarget;
  const syntheticPath = workspacePath ? pathJoin(workspacePath, withExt) : withExt;
  return { path: syntheticPath, label, found: false };
}
