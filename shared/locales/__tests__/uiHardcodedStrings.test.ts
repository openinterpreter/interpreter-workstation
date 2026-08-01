import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..');

const auditedFiles: Array<{ path: string; forbiddenSnippets: string[] }> = [
  {
    path: 'src/components/layout/new-tab/SuggestionGrid.tsx',
    forbiddenSnippets: [
      "'Suggestions'",
      "'Show less'",
      "'Show all'",
    ],
  },
  {
    path: 'src/components/Explorer.tsx',
    forbiddenSnippets: [
      "'No workspace selected'",
      "'Use File > Open to select a folder'",
      "'Loading files...'",
      "'Please wait'",
      "'No matching files found'",
      "'No files found'",
    ],
  },
  {
    path: 'src/components/FileSearchResults.tsx',
    forbiddenSnippets: [
      "'Search whole computer'",
      "'Searching notes...'",
      "'Searching file contents...'",
      "'Notes'",
      "'Aliases'",
      "'Open'",
      "'Files'",
      "'In files'",
    ],
  },
  {
    path: 'agent/components/SidebarTabStrip.tsx',
    forbiddenSnippets: [
      "'New Agent'",
      "'Close '",
    ],
  },
  {
    path: 'agent/components/composer/ApprovalPromptDock.tsx',
    forbiddenSnippets: [
      "'Other'",
      "'Enter a custom answer'",
      "'Skip'",
    ],
  },
  {
    path: 'agent/components/composer/WorkspacePopover.tsx',
    forbiddenSnippets: [
      "'Work in a folder'",
      "'Workspace'",
      "'Dismiss warning'",
      "'Recent'",
      "'Open folder...'",
      "'Runtime permissions'",
      "'Sandbox Mode'",
      "'Permissions'",
    ],
  },
  {
    path: 'agent/components/ComposerArea.tsx',
    forbiddenSnippets: [
      "'Send'",
      "'Stop agent'",
      "'Download experimental voice models?'",
      "'Total download'",
      "'Download models'",
      "'What can I use you for?'",
    ],
  },
  {
    path: 'agent/hooks/useMessageQueue.ts',
    forbiddenSnippets: [
      "'Empty message'",
      "'Failed to queue message. Please try again.'",
      "'Failed to queue message'",
    ],
  },
  {
    path: 'agent/components/composer/SendButtonWithMenu.tsx',
    forbiddenSnippets: [
      "'Send immediately'",
      "'Queue for end of turn'",
      "'Send after next tool call'",
      "'Submit this message to the current turn without interrupting it. Interpreter will pick it up after the next tool or result boundary.'",
    ],
  },
  {
    path: 'agent/components/prompt-kit/thread-messages.tsx',
    forbiddenSnippets: [
      "'Interpreting...'",
      "'Working...'",
      "'On my way...'",
      "'This is taking longer than usual...'",
      "'Copy Message'",
      "'Read Aloud'",
    ],
  },
  {
    path: 'agent/components/composer/mention/FileMentionDropdown.tsx',
    forbiddenSnippets: [
      "'Open'",
      "'Files'",
    ],
  },
  {
    path: 'agent/components/composer/mention/SkillMentionDropdown.tsx',
    forbiddenSnippets: [
      "'Global skill'",
    ],
  },
  {
    path: 'agent/components/composer/attachment/AttachmentChipBody.tsx',
    forbiddenSnippets: [
      "`Remove ${label}`",
    ],
  },
  {
    path: 'src/components/layout/new-tab/suggestionTree.ts',
    forbiddenSnippets: [
      "title: 'Create'",
      "question: 'What are you making?'",
      "title: 'Ask Folder'",
      "title: 'Ask Wiki'",
      "title: 'Research'",
      "title: 'Maintain'",
      "title: 'More'",
      "title: 'Fill Forms'",
      "title: 'Bootstrap Wiki'",
      "subtitle: 'Insert as mention'",
    ],
  },
];

describe('user-facing UI strings use locale keys on audited surfaces', () => {
  for (const { path, forbiddenSnippets } of auditedFiles) {
    test(path, () => {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      for (const snippet of forbiddenSnippets) {
        expect(
          source.includes(snippet),
          `${path} still contains user-facing literal ${snippet}`,
        ).toBe(false);
      }
    });
  }
});
