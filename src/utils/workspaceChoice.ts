import type { DetectedNoteWorkspace, DetectedNoteWorkspaceSource } from '../api';
import { NOTE_WORKSPACE_SOURCE_SECTION_LABELS } from './workspacePickerMenu';

export interface DetectedWorkspaceSection {
  source: DetectedNoteWorkspaceSource;
  title: string;
  workspaces: DetectedNoteWorkspace[];
}

export const DETECTED_WORKSPACE_SCROLL_THRESHOLD = 4;

const NOTE_WORKSPACE_SOURCE_ORDER: DetectedNoteWorkspaceSource[] = [
  'obsidian',
  'logseq',
  'dendron',
  'foam',
];

export function buildDetectedWorkspaceSections(
  workspaces: DetectedNoteWorkspace[],
): DetectedWorkspaceSection[] {
  return NOTE_WORKSPACE_SOURCE_ORDER
    .map((source) => {
      const workspacesForSource = workspaces.filter((workspace) => workspace.source === source);
      if (workspacesForSource.length === 0) {
        return null;
      }

      return {
        source,
        title: NOTE_WORKSPACE_SOURCE_SECTION_LABELS[source],
        workspaces: workspacesForSource,
      };
    })
    .filter((section): section is DetectedWorkspaceSection => section !== null);
}

export function shouldConstrainDetectedWorkspaceList(count: number): boolean {
  return count > DETECTED_WORKSPACE_SCROLL_THRESHOLD;
}
