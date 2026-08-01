/**
 * TabContent Component
 *
 * Content area that shows active tab's content
 */

import React, { useState, useEffect } from 'react';
import { FileX } from 'lucide-react';
import type { Tab } from '../../../shared/types/layout';
import { EditorArea } from '../EditorArea';
import { BrowserView } from '../BrowserView';
import { EmailView } from '../EmailView';
import { ChatView } from '../ChatView';
import { FolderTabView } from '../FolderTabView';
import { GlobalSettings } from '../GlobalSettings';
import { useLayoutActions } from '../../hooks/useLayout';
import { getWorkspace } from '../../api';
import { Button } from '../ui/button';
import { workspace as workspaceIpc, pathDirname, pathStartsWith, files } from '@/ipc';
import { WorkspaceSwitchBanner } from './WorkspaceSwitchBanner';

interface TabContentProps {
  activeTab: Tab | null;
}

export const TabContent = React.memo(function TabContent({ activeTab }: TabContentProps) {
  const { closeTab } = useLayoutActions();
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [dismissedPaths, setDismissedPaths] = useState<Set<string>>(new Set());
  const [activePathIsDirectory, setActivePathIsDirectory] = useState<boolean | null>(null);

  // Fetch current workspace
  useEffect(() => {
    getWorkspace().then(({ workspace }) => setWorkspacePath(workspace));

    // Listen for workspace changes
    const unsubscribe = workspaceIpc.onChanged((event: { workspacePath: string | null }) => {
      setWorkspacePath(event.workspacePath);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (activeTab?.type !== 'file' || !activeTab.path) {
      setActivePathIsDirectory(null);
      return;
    }

    let isCancelled = false;
    setActivePathIsDirectory(null);

    files
      .isDirectory(activeTab.path)
      .then((result: { isDirectory: boolean }) => {
        if (isCancelled) return;
        setActivePathIsDirectory(result.isDirectory);
      })
      .catch(() => {
        if (isCancelled) return;
        setActivePathIsDirectory(null);
      });

    return () => {
      isCancelled = true;
    };
  }, [activeTab?.type, activeTab?.path]);

  // No active tab
  if (!activeTab) {
    return null;
  }

  // Check if file is deleted
  const isDeleted = activeTab.type === 'file' && (activeTab as any).isDeleted;

  // Show error state for deleted files
  if (isDeleted) {
    return (
      <div
        className="flex h-full flex-1 flex-col items-center justify-center bg-transparent"
        role="alert"
        aria-live="polite"
      >
        <FileX className="size-16 text-muted-foreground mb-4" />
        <p className="text-muted-foreground text-lg mb-2">File not found</p>
        <p className="text-muted-foreground text-ui-base mb-6 max-w-md text-center">
          {activeTab.path}
        </p>
        <Button
          variant="outline"
          onClick={() => closeTab(activeTab.id)}
          className="px-4 py-2"
          aria-label={`Close ${activeTab.label}`}
        >
          Close Tab
        </Button>
      </div>
    );
  }

  // File tab type
  if (activeTab.type === 'file' && activeTab.path) {
    // Check if file is outside workspace (simple runtime check)
    const isOutsideWorkspace = workspacePath &&
      !pathStartsWith(activeTab.path, workspacePath) &&
      activeTab.path !== workspacePath;
    const showBanner = isOutsideWorkspace && !dismissedPaths.has(activeTab.path);
    const isDirectory = activePathIsDirectory === true;
    const targetWorkspacePath = isDirectory ? activeTab.path : pathDirname(activeTab.path);
    const bannerMessage = isDirectory
      ? 'This folder is not in the workspace.'
      : 'This file is not in the workspace.';

    return (
      <div className="h-full flex flex-col">
        {showBanner && (
          <WorkspaceSwitchBanner
            message={bannerMessage}
            displayPath={activeTab.path}
            targetWorkspacePath={targetWorkspacePath}
            actionLabelPrefix="Change workspace to"
            onDismiss={() => setDismissedPaths(prev => new Set(prev).add(activeTab.path!))}
          />
        )}
        <div className="flex-1 min-h-0">
          {isDirectory ? (
            <div className="editor-area flex h-full flex-col bg-background">
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <div className="text-lg mb-2">Folder cannot be displayed</div>
                  <div className="text-ui-base">Folders can be browsed in the explorer, not displayed in the editor.</div>
                </div>
              </div>
            </div>
          ) : (
            <EditorArea
              key={activeTab.path}
              filePath={activeTab.path}
              refreshKey={activeTab.refreshKey || 0}
              pdfPage={activeTab.pdfPage}
            />
          )}
        </div>
      </div>
    );
  }

  if (activeTab.type === 'folder' && activeTab.path) {
    return (
      <div className="h-full">
        <FolderTabView rootPath={activeTab.path} />
      </div>
    );
  }

  // Browser tab type
  if (activeTab.type === 'browser' && activeTab.url) {
    return (
      <div className="h-full">
        <BrowserView
          key={activeTab.id}
          tabId={activeTab.id}
          initialUrl={activeTab.url}
          browserId={activeTab.browserId}
          faviconUrl={activeTab.faviconUrl}
          isVisible
        />
      </div>
    );
  }

  // Email tab type
  if (activeTab.type === 'email' && activeTab.emailId) {
    return (
      <div className="h-full">
        <EmailView
          key={activeTab.id}
          tabId={activeTab.id}
          emailId={activeTab.emailId}
        />
      </div>
    );
  }

  // Chat tab type (WhatsApp / Telegram)
  if (activeTab.type === 'chat' && activeTab.chatThreadId && activeTab.chatChannel) {
    return (
      <div className="h-full">
        <ChatView
          key={activeTab.id}
          tabId={activeTab.id}
          threadId={activeTab.chatThreadId}
          channel={activeTab.chatChannel}
        />
      </div>
    );
  }

  // Settings tab type
  if (activeTab.type === 'settings') {
    return (
      <div className="h-full overflow-auto">
        <GlobalSettings initialSection={activeTab.settingsSection} />
      </div>
    );
  }

  // Stateful tabs (terminal, agent) - rendered in PersistentLayer
  // TabContent returns null; they are positioned over the content slot.
  if (activeTab.type === 'terminal' || activeTab.type === 'agent') {
    return null;
  }

  // Fallback
  return null;
});
