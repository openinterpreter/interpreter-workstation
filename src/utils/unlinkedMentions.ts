import type { VaultNoteRecord } from '../../shared/types/vault';
import { stripMarkdownFileExtension } from './localReferenceDisplay';

export interface UnlinkedMentionCandidate {
  phrase: string;
  normalizedPhrase: string;
  targetPath: string;
  targetLabel: string;
  targetRelativePath: string;
  targetWikilink: string;
  requireExactCase: boolean;
}

export interface UnlinkedMentionMatch {
  from: number;
  to: number;
  text: string;
  targetPath: string;
  targetLabel: string;
  targetRelativePath: string;
  targetWikilink: string;
  ignoreKey: string;
}

function isEligiblePhrase(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 4) {
    return false;
  }
  if (!/[A-Za-z0-9]/.test(trimmed)) {
    return false;
  }
  return true;
}

function shouldRequireExactCase(phrase: string): boolean {
  return !phrase.includes(' ') && phrase === phrase.toLowerCase();
}

function isTokenCharacter(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z0-9_]/.test(character));
}

function isBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return true;
  }

  return !isTokenCharacter(text[index]);
}

function getCandidateIgnoreKey(candidate: Pick<UnlinkedMentionCandidate, 'targetPath' | 'phrase'>): string {
  return `${candidate.targetPath}::${candidate.phrase.toLowerCase()}`;
}

function buildCandidateGroups(candidates: UnlinkedMentionCandidate[]): Map<string, UnlinkedMentionCandidate[]> {
  const groups = new Map<string, UnlinkedMentionCandidate[]>();

  for (const candidate of candidates) {
    const firstCharacter = candidate.normalizedPhrase[0];
    if (!firstCharacter) {
      continue;
    }
    const existing = groups.get(firstCharacter) ?? [];
    existing.push(candidate);
    groups.set(firstCharacter, existing);
  }

  for (const group of groups.values()) {
    group.sort((left, right) => right.normalizedPhrase.length - left.normalizedPhrase.length);
  }

  return groups;
}

export function buildUnlinkedMentionCandidates(
  notes: VaultNoteRecord[],
  currentFilePath?: string | null,
): UnlinkedMentionCandidate[] {
  const candidateOwners = new Map<string, Set<string>>();
  const candidateByPhrase = new Map<string, UnlinkedMentionCandidate>();

  for (const note of notes) {
    if (note.path === currentFilePath) {
      continue;
    }

    const phrases = new Set<string>([note.title, ...note.aliases].map((value) => value.trim()).filter(Boolean));
    const targetWikilink = stripMarkdownFileExtension(note.relativePath);

    for (const phrase of phrases) {
      if (!isEligiblePhrase(phrase)) {
        continue;
      }

      const normalizedPhrase = phrase.toLowerCase();
      const owners = candidateOwners.get(normalizedPhrase) ?? new Set<string>();
      owners.add(note.path);
      candidateOwners.set(normalizedPhrase, owners);

      if (!candidateByPhrase.has(normalizedPhrase)) {
        candidateByPhrase.set(normalizedPhrase, {
          phrase,
          normalizedPhrase,
          targetPath: note.path,
          targetLabel: note.title,
          targetRelativePath: note.relativePath,
          targetWikilink,
          requireExactCase: shouldRequireExactCase(phrase),
        });
      }
    }
  }

  return Array.from(candidateByPhrase.entries())
    .filter(([normalizedPhrase]) => (candidateOwners.get(normalizedPhrase)?.size ?? 0) === 1)
    .map(([, candidate]) => candidate)
    .sort((left, right) => right.normalizedPhrase.length - left.normalizedPhrase.length);
}

export function findUnlinkedMentionsInText(
  text: string,
  candidates: UnlinkedMentionCandidate[],
  ignoredKeys?: ReadonlySet<string>,
): UnlinkedMentionMatch[] {
  if (!text || candidates.length === 0) {
    return [];
  }

  const candidateGroups = buildCandidateGroups(candidates);
  const normalizedText = text.toLowerCase();
  const matches: UnlinkedMentionMatch[] = [];

  let index = 0;
  while (index < text.length) {
    const group = candidateGroups.get(normalizedText[index] ?? '');
    let matched = false;

    if (group) {
      for (const candidate of group) {
        if (!normalizedText.startsWith(candidate.normalizedPhrase, index)) {
          continue;
        }

        const end = index + candidate.normalizedPhrase.length;
        if (!isBoundary(text, index - 1) || !isBoundary(text, end)) {
          continue;
        }

        const matchedText = text.slice(index, end);
        if (candidate.requireExactCase && matchedText !== candidate.phrase) {
          continue;
        }

        const ignoreKey = getCandidateIgnoreKey(candidate);
        if (ignoredKeys?.has(ignoreKey)) {
          continue;
        }

        matches.push({
          from: index,
          to: end,
          text: matchedText,
          targetPath: candidate.targetPath,
          targetLabel: candidate.targetLabel,
          targetRelativePath: candidate.targetRelativePath,
          targetWikilink: candidate.targetWikilink,
          ignoreKey,
        });
        index = end;
        matched = true;
        break;
      }
    }

    if (!matched) {
      index += 1;
    }
  }

  return matches;
}
