import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BaseTiptapComposerRef } from '../../../agent/components/composer/BaseTiptapComposer';
import { useLayoutActions } from '../../hooks/useLayout';
import { getUserName } from '../../api';
import { files as filesIpc, pathJoin, workspace as workspaceIpc } from '../../ipc';
import { AGENT_EMPTY_STATE_PAGE_ID } from '../../../shared/element-ids';
import { MainContent } from './new-tab/MainContent';
import { TopNoticeStack } from './new-tab/TopNoticeStack';

interface AgentEmptyStateProps {
  agentId?: string;
  onAgentSend: (text: string, options?: { workspacePath?: string | null }) => void;
  composerRef: React.RefObject<BaseTiptapComposerRef | null>;
}

const DAILY_NOTES_FOLDER = 'daily';

function formatDailyNoteDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, deltaDays: number): Date {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + deltaDays);
  return nextDate;
}

function buildDailyNoteTemplate(date: Date, previousDateLabel?: string | null): string {
  const dateLabel = formatDailyNoteDate(date);
  const previousNoteLine = previousDateLabel ? `Previous: [[${previousDateLabel}]]\n\n` : '';

  return `# ${dateLabel}

${previousNoteLine}## Tasks

- [ ]

## Notes

## Journal
`;
}

export function AgentEmptyState({
  agentId,
  onAgentSend,
  composerRef,
}: AgentEmptyStateProps) {
  "use no memo";

  const { openFile } = useLayoutActions();
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentUserName, setCurrentUserName] = useState('');

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      try {
        const userNameData = await getUserName();

        if (cancelled) return;
        setCurrentUserName(userNameData.userName ?? '');
      } catch (error) {
        if (cancelled) return;
        console.error('[AgentEmptyState] Failed to load data:', error);
      }
    };

    void loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreateEmptyNote = useCallback(async () => {
    try {
      const { workspace } = await workspaceIpc.get();
      if (!workspace) return;

      const result = await filesIpc.create('note', workspace);
      if (result.success && result.path) {
        openFile(result.path);
      }
    } catch (error) {
      console.error('[AgentEmptyState] Failed to create note:', error);
    }
  }, [openFile]);

  const handleCreateDailyNote = useCallback(async () => {
    try {
      const { workspace } = await workspaceIpc.get();
      if (!workspace) return;

      const today = new Date();
      const dailyNotesPath = pathJoin(workspace, DAILY_NOTES_FOLDER);
      const dailyNotesStats = await filesIpc.getStats(dailyNotesPath);

      if (!dailyNotesStats.isDirectory) {
        if (dailyNotesStats.size !== null) {
          throw new Error(`Daily notes path already exists and is not a folder: ${dailyNotesPath}`);
        }

        const folderResult = await filesIpc.createFolder(workspace, DAILY_NOTES_FOLDER);
        if (!folderResult.success) {
          throw new Error(folderResult.error || 'Failed to create daily notes folder');
        }
        if (folderResult.path !== dailyNotesPath) {
          throw new Error(`Daily notes folder must be created at ${dailyNotesPath}`);
        }
      }

      const dailyNotePath = pathJoin(dailyNotesPath, `${formatDailyNoteDate(today)}.md`);
      const dailyNoteStats = await filesIpc.getStats(dailyNotePath);

      if (dailyNoteStats.isDirectory) {
        throw new Error(`Daily note path already exists and is a folder: ${dailyNotePath}`);
      }

      if (dailyNoteStats.size === null) {
        const previousDateLabel = formatDailyNoteDate(addDays(today, -1));
        const previousDailyNotePath = pathJoin(dailyNotesPath, `${previousDateLabel}.md`);
        const previousDailyNoteStats = await filesIpc.getStats(previousDailyNotePath);
        const previousLink = previousDailyNoteStats.size !== null && !previousDailyNoteStats.isDirectory
          ? previousDateLabel
          : null;
        await filesIpc.write(dailyNotePath, buildDailyNoteTemplate(today, previousLink));
      }

      openFile(dailyNotePath);
    } catch (error) {
      console.error('[AgentEmptyState] Failed to create daily note:', error);
    }
  }, [openFile]);

  return (
    <div
      ref={containerRef}
      className="relative pointer-events-auto"
      data-testid={AGENT_EMPTY_STATE_PAGE_ID}
    >
      <div className="flex flex-col">
        <MainContent
          agentId={agentId}
          userName={currentUserName}
          onComposerSend={onAgentSend}
          onCreateEmptyNote={handleCreateEmptyNote}
          onCreateDailyNote={handleCreateDailyNote}
          topBanner={<TopNoticeStack composerRef={composerRef} />}
          composerRef={composerRef}
          externalComposer={true}
        />
      </div>
    </div>
  );
}
