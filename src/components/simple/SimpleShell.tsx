import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Settings2 } from 'lucide-react';
import { AgentThread } from '../../../agent/components/AgentThread';
import { ComposerArea } from '../../../agent/components/ComposerArea';
import { AgentMetadataProvider } from '../../../agent/contexts/AgentMetadataContext';
import { AgentErrorProvider } from '../../../agent/contexts/AgentErrorContext';
import { getProfiles } from '../../api';
import { createAgentCallerToken } from '../../utils/layoutHelpers';
import { getDefaultModelConfig, profileToModelConfig } from '../../../shared/types/profile';
import type { AgentModelConfig } from '../../../shared/types/model';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
import { ExperienceSectionContent } from '../settings/ExperienceSection';

/** A fixed identity names the one conversation even when the shell is remounted. */
export const SIMPLE_PRIMARY_AGENT_ID = 'simple-primary-agent';

export function sendSimpleMessage(text: string, workspacePath: string): void {
  if (!text.trim()) return;
  if (document.querySelector('[data-simple-shell][data-primary-thread-error="true"]')) return;
  window.dispatchEvent(new CustomEvent('agent-runtime:send', {
    detail: { tabId: SIMPLE_PRIMARY_AGENT_ID, text, workspacePath },
  }));
}

interface SimpleShellProps {
  workspacePath: string;
  initialThreadId: string | null;
  onBindThread: (threadId: string) => void | Promise<void>;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  canvas: ReactNode;
}

/** Simple is a separate surface: no explorer, tabs, sidebars, or second-chat affordances. */
export function SimpleShell({ workspacePath, initialThreadId, onBindThread, onOpenSettings, settingsOpen, onCloseSettings, canvas }: SimpleShellProps) {
  const [expanded, setExpanded] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  const [modelConfig, setModelConfig] = useState<AgentModelConfig>(getDefaultModelConfig);
  const [isStreaming, setIsStreaming] = useState(false);
  const [messageCount, setMessageCount] = useState(0);
  const [persistenceError, setPersistenceError] = useState(false);
  const callerToken = useMemo(() => createAgentCallerToken(), []);
  const readOnly = isWorkstationReadOnly();

  useEffect(() => {
    setThreadId(initialThreadId);
  }, [initialThreadId]);

  useEffect(() => {
    let cancelled = false;
    getProfiles().then(({ profiles, defaultProfileId }) => {
      const selected = profiles.find((profile) => profile.id === defaultProfileId);
      if (!cancelled && selected) setModelConfig(profileToModelConfig(selected));
    }).catch((error) => console.warn('[SimpleShell] Default profile unavailable', error));
    return () => { cancelled = true; };
  }, []);

  const agent = useMemo(() => ({
    id: SIMPLE_PRIMARY_AGENT_ID,
    createdAt: 0,
    agent: {
      runtime: { modelConfig, workspacePath },
      session: { callerToken, codexThreadId: threadId ?? undefined },
    },
  }), [callerToken, modelConfig, threadId, workspacePath]);

  const handleThreadAssigned = useCallback((_agentId: string, assignedThreadId: string) => {
    void Promise.resolve().then(() => onBindThread(assignedThreadId)).then(() => {
      setThreadId(assignedThreadId);
      setPersistenceError(false);
    }).catch((error) => {
      console.error('[SimpleShell] Could not persist primary conversation', error);
      setPersistenceError(true);
      setExpanded(true);
    });
  }, [onBindThread]);

  return (
    <div className="relative flex h-screen w-full flex-col bg-background text-foreground" data-simple-shell="true"
      data-primary-thread-error={persistenceError ? 'true' : undefined}>
      <div className="absolute inset-x-0 top-0 z-20 flex h-12 items-center justify-end px-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <button type="button" aria-label="Open Settings" onClick={onOpenSettings}
          className="rounded-full bg-background/90 p-2 text-muted-foreground shadow-sm hover:text-foreground"
          style={{ WebkitAppRegion: 'no-drag', border: 'var(--border-width) solid var(--border)' } as React.CSSProperties}>
          <Settings2 className="size-4" />
        </button>
      </div>

      <main aria-label="Interface" className="absolute inset-0 overflow-y-auto" onPointerDown={(event) => {
        if (event.target === event.currentTarget) setExpanded(false);
      }}>
        {settingsOpen ? <div className="mx-auto max-w-[780px] px-6 pb-48 pt-20" aria-label="Settings">
          <button type="button" className="mb-6 text-ui-sm text-muted-foreground hover:text-foreground" onClick={onCloseSettings}>← Back to interface</button>
          <h1 className="mb-6 text-2xl font-semibold">Settings</h1>
          <ExperienceSectionContent />
        </div> : <div className="min-h-full" onPointerDown={() => setExpanded(false)}>{canvas}</div>}
      </main>

      <AgentMetadataProvider agent={agent}>
        <AgentErrorProvider>
          <section aria-label="Primary conversation" data-simple-conversation="true"
            className="absolute inset-x-3 bottom-5 z-30 mx-auto flex w-[min(100%-1.5rem,680px)] flex-col overflow-hidden rounded-[24px] bg-background/95 shadow-xl backdrop-blur-xl transition-[height,width] duration-200"
            style={{ height: expanded ? 'min(75vh,720px)' : 'auto', border: 'var(--border-width) solid var(--border)' }}>
            <div className="flex min-h-0 flex-1 flex-col" style={{ display: expanded ? 'flex' : 'none' }}>
              <header className="flex h-10 shrink-0 items-center justify-between px-5 text-ui-sm text-muted-foreground">
                <span>Conversation</span>
                <button type="button" aria-label="Collapse conversation" onClick={() => setExpanded(false)}><ChevronDown className="size-4" /></button>
              </header>
              <div className="min-h-0 flex-1 overflow-hidden">
                <AgentThread agentId={SIMPLE_PRIMARY_AGENT_ID} codexThreadId={threadId ?? undefined}
                  callerToken={callerToken} workspacePath={workspacePath} modelConfig={modelConfig}
                  isVisible={true} isEditorPane={false} readOnly={readOnly}
                  onModelConfigUpdate={(_id, next) => setModelConfig(next)}
                  onCodexThreadIdAssigned={handleThreadAssigned}
                  onLabelUpdate={(_id, _label, running) => setIsStreaming(running)}
                  onMessageCountChange={(_id, count) => setMessageCount(count)} />
              </div>
            </div>
            <div className="min-w-0 shrink-0 px-3 pb-2 pt-2">
              {persistenceError && <div role="alert" className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
                The primary conversation could not be saved. Reload Interpreter to recover before sending again.
                <button type="button" className="ml-2 underline" onClick={() => window.location.reload()}>Reload</button>
              </div>}
              {!expanded && <button type="button" aria-label="Expand conversation" aria-expanded="false"
                onClick={() => setExpanded(true)} className="mb-1 flex w-full items-center justify-between px-3 py-1 text-ui-xs text-muted-foreground">
                <span>{isStreaming ? 'Interpreter is working…' : messageCount > 0 ? 'Show conversation' : 'Ask Interpreter anything'}</span>
                <ChevronUp className="size-4" />
              </button>}
              {!readOnly && !persistenceError && <ComposerArea isTerminal={false} agentId={SIMPLE_PRIMARY_AGENT_ID}
                modelConfig={modelConfig} workspacePath={workspacePath} isStreaming={isStreaming}
                messageCount={messageCount} showSuggestionChips={false} showQueuedMessages={expanded}
                onAgentSend={(text, options) => {
                  window.dispatchEvent(new CustomEvent('agent-runtime:send', {
                    detail: { tabId: SIMPLE_PRIMARY_AGENT_ID, text, workspacePath, attachments: options?.attachments, messageSource: options?.messageSource },
                  }));
                }} />}
            </div>
          </section>
        </AgentErrorProvider>
      </AgentMetadataProvider>
    </div>
  );
}
