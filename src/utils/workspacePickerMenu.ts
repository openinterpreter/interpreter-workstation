import { createElement, type ReactNode } from 'react';
import { ArrowUp, BookOpen, Folder, FolderOpen, FolderSearch, type LucideIcon } from 'lucide-react';
import type {
  DetectedNoteWorkspace,
  DetectedNoteWorkspaceSource,
  RecentWorkspaceFolder,
} from '../api';
import { pathBasename, pathDirname } from '@/ipc';

export interface WorkspacePickerMenuItem {
  label: string;
  onClick?: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
  sectionLabel?: boolean;
  title?: boolean;
}

interface BuildWorkspacePickerMenuItemsOptions {
  workspacePath: string | null;
  recentFolders: RecentWorkspaceFolder[];
  noteWorkspaces: DetectedNoteWorkspace[];
  revealWorkspaceLabel: string;
  openFolderShortcut?: string;
  onRevealWorkspace: (path: string) => void;
  onOpenFolder: () => void;
  onSelectWorkspace: (path: string) => void;
}

const NOTE_WORKSPACE_SOURCE_ORDER: DetectedNoteWorkspaceSource[] = [
  'obsidian',
  'logseq',
  'dendron',
  'foam',
];

export const NOTE_WORKSPACE_SOURCE_SECTION_LABELS: Record<DetectedNoteWorkspaceSource, string> = {
  obsidian: 'Obsidian vaults',
  logseq: 'Logseq graphs',
  dendron: 'Dendron workspaces',
  foam: 'Foam workspaces',
};

export const NOTE_WORKSPACE_SOURCE_KIND_LABELS: Record<DetectedNoteWorkspaceSource, string> = {
  obsidian: 'Obsidian vault',
  logseq: 'Logseq graph',
  dendron: 'Dendron workspace',
  foam: 'Foam workspace',
};

function menuIcon(Icon: LucideIcon): ReactNode {
  return createElement(Icon, { className: 'size-4 text-muted-foreground' });
}

export function getRevealInFileManagerLabel(platform: string): string {
  if (platform === 'darwin') {
    return 'Reveal in Finder';
  }
  if (platform === 'win32') {
    return 'Show in Explorer';
  }
  return 'Show in File Manager';
}

function pushSeparator(items: WorkspacePickerMenuItem[]): void {
  if (items.length === 0 || items[items.length - 1]?.separator) {
    return;
  }
  items.push({ label: '', separator: true });
}

function trimTrailingSeparator(items: WorkspacePickerMenuItem[]): WorkspacePickerMenuItem[] {
  const nextItems = [...items];
  while (nextItems.length > 0 && nextItems[nextItems.length - 1]?.separator) {
    nextItems.pop();
  }
  return nextItems;
}

export function buildWorkspacePickerMenuItems({
  workspacePath,
  recentFolders,
  noteWorkspaces,
  revealWorkspaceLabel,
  openFolderShortcut,
  onRevealWorkspace,
  onOpenFolder,
  onSelectWorkspace,
}: BuildWorkspacePickerMenuItemsOptions): WorkspacePickerMenuItem[] {
  const items: WorkspacePickerMenuItem[] = [];
  const filteredRecentFolders = recentFolders
    .filter((folder) => folder.path !== workspacePath)
    .slice(0, 6);
  const filteredNoteWorkspaces = noteWorkspaces.filter((workspace) => workspace.path !== workspacePath);
  const parentFolderPath = workspacePath ? pathDirname(workspacePath) : null;
  const canOpenParent = !!parentFolderPath && parentFolderPath !== workspacePath && parentFolderPath.length > 0;

  if (workspacePath) {
    items.push({
      label: pathBasename(workspacePath) || workspacePath,
      title: true,
    });
    pushSeparator(items);
    items.push({
      label: revealWorkspaceLabel,
      icon: menuIcon(FolderSearch),
      onClick: () => onRevealWorkspace(workspacePath),
    });
    if (canOpenParent && parentFolderPath) {
      items.push({
        label: 'Open parent folder',
        icon: menuIcon(ArrowUp),
        onClick: () => onSelectWorkspace(parentFolderPath),
      });
    }
    pushSeparator(items);
  }

  if (filteredRecentFolders.length > 0) {
    items.push({
      label: 'Recent',
      sectionLabel: true,
    });
    for (const folder of filteredRecentFolders) {
      items.push({
        label: folder.name,
        icon: menuIcon(Folder),
        onClick: () => onSelectWorkspace(folder.path),
      });
    }
    pushSeparator(items);
  }

  for (const source of NOTE_WORKSPACE_SOURCE_ORDER) {
    const workspacesForSource = filteredNoteWorkspaces
      .filter((workspace) => workspace.source === source)
      .slice(0, 4);

    if (workspacesForSource.length === 0) {
      continue;
    }

    items.push({
      label: NOTE_WORKSPACE_SOURCE_SECTION_LABELS[source],
      sectionLabel: true,
    });

    for (const workspace of workspacesForSource) {
      items.push({
        label: workspace.name,
        icon: menuIcon(BookOpen),
        onClick: () => onSelectWorkspace(workspace.path),
      });
    }
  }

  if (filteredNoteWorkspaces.length > 0) {
    pushSeparator(items);
  }

  items.push({
    label: 'Open folder...',
    icon: menuIcon(FolderOpen),
    onClick: onOpenFolder,
    shortcut: openFolderShortcut,
  });

  return trimTrailingSeparator(items);
}
