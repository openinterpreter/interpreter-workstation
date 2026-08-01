import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { globalTools, skills as skillsIpc, workspace } from '../../../ipc';
import { getUserName, recordSkillUseActivity } from '../../../api';
import { useSuggestionSignals } from '../../../hooks/useSuggestionSignals';
import { buildSuggestionTree, findOptionByPath, type PillOption } from './suggestionTree';
import { SuggestionPillRow } from './SuggestionPillRow';
import { useLayoutActions } from '../../../hooks/useLayout';
import { getIcon } from '../../../utils/iconMap';
import { GhostElement } from '../../ui/ghost-element';
import { BaseTiptapComposerRef } from '../../../../agent/components/composer/BaseTiptapComposer';
import { useSlideAnimation } from './useSlideAnimation';
import { NewTabComposer } from './NewTabComposer';
import { ApprovalsContainer } from './ApprovalsContainer';
import type { SkillOption } from '../../../../shared/types/skill';
import { humanizeSkillName } from '../../../../shared/utils/skillDisplay';
import { serializeSkillMentionToken } from '../../../../shared/utils/skillMentions';



interface GhostState {
  startRect: DOMRect;
  title: string;
  iconName?: string;
  endX: number;
  endY: number;
}

interface WorkspaceSkillChip {
  id: string;
  name: string;
  path: string;
  label: string;
  title: string;
}

function getGreeting(name: string, translate: (key: string, options?: Record<string, unknown>) => string): string {
  const hour = new Date().getHours();

  if (hour >= 5 && hour < 12) {
    return translate('newTab.greetingMorning', { name });
  }
  if (hour >= 12 && hour < 17) {
    return translate('newTab.greetingAfternoon', { name });
  }
  if (hour >= 17 && hour < 21) {
    return translate('newTab.greetingEvening', { name });
  }
  return translate('newTab.greetingWelcomeBack', { name });
}

function SmoothHeight({
  children,
  className,
  allowOverflow = false,
}: {
  children: React.ReactNode;
  className?: string;
  allowOverflow?: boolean;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0].borderBoxSize?.[0]?.blockSize ?? entries[0].contentRect.height;
      setHeight(h);
      if (first) {
        first = false;
        requestAnimationFrame(() => setAnimate(true));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className={className}
      style={{
        height: height ?? 'auto',
        overflow: allowOverflow ? 'visible' : 'clip',
        transition: animate ? 'height 300ms cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}

export function MainContent({
  agentId,
  userName,
  onComposerSend,
  onCreateEmptyNote,
  onCreateDailyNote,
  showFirstStartupNudge,
  topBanner,
  composerRef: externalComposerRef,
  composerElement,
  belowComposer,
  externalComposer,
}: {
  agentId?: string;
  userName: string;
  onComposerSend: (text: string) => void;
  onCreateEmptyNote: () => void | Promise<void>;
  onCreateDailyNote: () => void | Promise<void>;
  showFirstStartupNudge?: boolean;
  topBanner?: React.ReactNode;
  composerRef?: React.RefObject<BaseTiptapComposerRef | null>;
  composerElement?: React.ReactNode;
  belowComposer?: React.ReactNode;
  externalComposer?: boolean;
}) {
  "use no memo";

  const { t } = useTranslation();
  const internalComposerRef = useRef<BaseTiptapComposerRef>(null);
  const composerRef = externalComposerRef ?? internalComposerRef;
  const composerAreaRef = useRef<HTMLDivElement>(null);

  const [ghost, setGhost] = useState<GhostState | null>(null);
  const [webSearchDisabled, setWebSearchDisabled] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceSkills, setWorkspaceSkills] = useState<WorkspaceSkillChip[]>([]);
  const [resolvedUserName, setResolvedUserName] = useState(userName);

  const { getAnimClass, getTransitionClass, animate } = useSlideAnimation();

  useEffect(() => {
    setResolvedUserName(userName);
  }, [userName]);

  useEffect(() => {
    if (userName) return;

    let cancelled = false;

    const loadUserName = async () => {
      try {
        const data = await getUserName();
        if (!cancelled && data.userName) {
          setResolvedUserName(data.userName);
        }
      } catch {
        if (!cancelled) {
          setResolvedUserName('');
        }
      }
    };

    void loadUserName();

    return () => {
      cancelled = true;
    };
  }, [userName]);

  useEffect(() => {
    globalTools.get('builtin-google').then((result: { enabled: boolean }) => {
      setWebSearchDisabled(!result.enabled);
    }).catch(() => {
      setWebSearchDisabled(false);
    });

    const unsubscribe = globalTools.onChanged((event: { serverId: string; enabled: boolean }) => {
      if (event.serverId === 'builtin-google') {
        setWebSearchDisabled(!event.enabled);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const toChip = (skill: SkillOption): WorkspaceSkillChip | null => {
      const displayLabel = humanizeSkillName(skill.title || skill.name);
      if (!displayLabel) return null;
      return {
        id: skill.id,
        name: skill.name,
        path: skill.filePath,
        label: displayLabel,
        title: displayLabel,
      };
    };

    const loadSkills = async () => {
      try {
        const result = await skillsIpc.list();
        if (!result.success || !result.data) {
          setWorkspaceSkills([]);
          return;
        }

        const next = result.data.project.skills
          .map((skill: SkillOption) => toChip(skill))
          .filter((skill: WorkspaceSkillChip | null): skill is WorkspaceSkillChip => skill !== null);
        setWorkspaceSkills(next);
      } catch {
        setWorkspaceSkills([]);
      }
    };

    void workspace.get().then((result: { workspace: string | null }) => {
      setWorkspacePath(result.workspace);
    }).catch(() => {
      setWorkspacePath(null);
    });

    void loadSkills();
    const unsubscribeSkillsChanged = skillsIpc.onChanged?.(() => {
      void loadSkills();
    });
    const unsubscribeWorkspaceChanged = workspace.onChanged((event: { workspacePath: string | null }) => {
      setWorkspacePath(event.workspacePath);
      void loadSkills();
    });

    return () => {
      unsubscribeSkillsChanged?.();
      unsubscribeWorkspaceChanged();
    };
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);



  const serializedSkillToken = useCallback((skill: WorkspaceSkillChip) => serializeSkillMentionToken({
    id: skill.id,
    label: skill.label,
    name: skill.name,
    path: skill.path,
  }), []);

  const skillPreviewText = useCallback((option: PillOption) => {
    if (!option.skill) return null;
    const description = (option.subtitle || option.skill.title || option.title).trim();
    const normalizedDescription = description
      ? description.charAt(0).toLowerCase() + description.slice(1).replace(/\.$/, '')
      : 'run this workflow';
    return `Use ${serializedSkillToken(option.skill)} to ${normalizedDescription}.`;
  }, [serializedSkillToken]);

  const handleInsertSkill = useCallback((skill: WorkspaceSkillChip) => {
    const current = composerRef.current?.getContent() || '';
    const separator = current.length > 0 && !current.endsWith('\n') ? ' ' : '';
    const serialized = serializedSkillToken(skill);
    composerRef.current?.setContent(`${current}${separator}${serialized}`);
    composerRef.current?.focus();
    void recordSkillUseActivity(skill.id, skill.name);
  }, [serializedSkillToken]);

  // ---- Suggestion pill row (deterministic, workspace + behavior driven) ----
  const { openFile: openFileAction } = useLayoutActions();
  const suggestionSignals = useSuggestionSignals(workspacePath ?? '__no-workspace__');
  const suggestionTree: PillOption[] = useMemo(() => {
    const availableSkills = workspaceSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      label: skill.label,
      path: skill.path,
      title: skill.title,
    }));
    return buildSuggestionTree({
      workspace: suggestionSignals.workspace,
      activity: suggestionSignals.activity,
      hourOfDay: suggestionSignals.hourOfDay,
      availableSkills,
      translate: t,
    });
  }, [suggestionSignals.workspace, suggestionSignals.activity, suggestionSignals.hourOfDay, workspaceSkills, t]);

  const handleInvokePill = useCallback((option: PillOption) => {
    composerRef.current?.setPreviewText(null);
    if (option.actionType === 'create-note') {
      void onCreateEmptyNote();
      return;
    }
    if (option.actionType === 'create-daily-note') {
      void onCreateDailyNote();
      return;
    }
    if (option.actionType === 'insert-skill' && option.skill) {
      handleInsertSkill(option.skill);
      return;
    }
    if (option.actionType === 'open-file' && option.filePath) {
      openFileAction(option.filePath);
      return;
    }
    if (option.actionType === 'prompt' && option.prompt !== undefined) {
      composerRef.current?.setContent(option.prompt);
      composerRef.current?.focus();
      return;
    }
    composerRef.current?.focus();
  }, [composerRef, onCreateDailyNote, onCreateEmptyNote, handleInsertSkill, openFileAction]);

  // Drill path for the suggestion pill row. Lives here (not inside the row)
  // so the header + pill animation are driven in sync by useSlideAnimation.
  const [drillPath, setDrillPath] = useState<string[]>([]);
  const { currentOptions, currentQuestion } = useMemo(
    () => findOptionByPath(suggestionTree, drillPath),
    [suggestionTree, drillPath],
  );

  const handleDrillIn = useCallback((option: PillOption) => {
    composerRef.current?.setPreviewText(null);
    animate('deeper', () => setDrillPath((prev) => [...prev, option.id]));
  }, [animate, composerRef]);

  const handleDrillOut = useCallback(() => {
    composerRef.current?.setPreviewText(null);
    animate('back', () => setDrillPath((prev) => prev.slice(0, -1)));
  }, [animate, composerRef]);

  const handleSetPreview = useCallback((option: PillOption | null) => {
    if (!option) {
      composerRef.current?.setPreviewText(null);
      return;
    }

    if (!option.children && option.actionType === 'prompt' && option.prompt !== undefined) {
      composerRef.current?.setPreviewText(option.prompt);
      return;
    }

    if (!option.children && option.actionType === 'insert-skill' && option.skill) {
      composerRef.current?.setPreviewText(skillPreviewText(option));
      return;
    }

    composerRef.current?.setPreviewText(null);
  }, [composerRef, skillPreviewText]);

  useEffect(() => {
    composerRef.current?.setPreviewText(null);
    return () => {
      composerRef.current?.setPreviewText(null);
    };
  }, [composerRef]);

  const greeting = useMemo(
    () => (resolvedUserName ? getGreeting(resolvedUserName, t) : t('newTab.greetingFallback')),
    [resolvedUserName, t],
  );

  const headerText = currentQuestion ?? greeting;

  // Web search tip is shown when the user has web-search globally disabled and is in a
  // category that depends on it (legacy drill paths); the new pill row does not surface it directly.
  const showWebSearchTip = webSearchDisabled && drillPath[drillPath.length - 1] === 'cat:analyze';

  const GhostIcon = ghost?.iconName ? getIcon(ghost.iconName) : undefined;
  const rendersInlineComposer = !externalComposer;

  return (
    <div
      className={externalComposer ? 'relative w-full' : 'relative flex h-full flex-1 flex-col overflow-auto'}
      style={{ backgroundColor: 'transparent' }}
    >
      <div
        className={externalComposer
          ? 'flex flex-col items-center px-6 pt-6'
          : 'flex min-h-full flex-1 flex-col items-center justify-center px-6 py-6'}
      >
        <div className="flex w-full max-w-[680px] flex-col">

          {topBanner && (
            <div className="mb-8">
              {topBanner}
            </div>
          )}

          {/* Header — text stays centered. The pill row below handles its own back button. */}
          <div className={`mb-5 ${getTransitionClass()} ${getAnimClass()}`}>
            <div className="relative mx-auto w-full max-w-[640px]">
              <h1 className="text-[22px] font-normal tracking-[-0.02em] text-[var(--oa-text-strong)] text-center">
                {headerText}
              </h1>
            </div>
            {showWebSearchTip && (
              <p className="mt-2 text-center text-ui-xs text-[var(--oa-text-muted)]">
                {t('newTab.webSearchTip')}
              </p>
            )}
          </div>

          {/* Suggestion pill row — horizontal scrollable, drill-down (animated), hover previews to composer. */}
          <SmoothHeight className="mb-5">
            <div ref={containerRef} className={`mx-auto w-full max-w-[660px] ${getTransitionClass()} ${getAnimClass()}`}>
              <SuggestionPillRow
                options={currentOptions}
                canGoBack={drillPath.length > 0}
                onInvoke={handleInvokePill}
                onDrillIn={handleDrillIn}
                onDrillOut={handleDrillOut}
                onPreview={handleSetPreview}
              />
            </div>
          </SmoothHeight>

          {rendersInlineComposer ? (
            <>
              {/* Composer */}
              <SmoothHeight allowOverflow>
                <div ref={composerAreaRef} className="relative new-tab-composer-wrapper mx-auto w-full max-w-[660px]">
                  {composerElement ?? (
                    <NewTabComposer
                      ref={composerRef as React.RefObject<BaseTiptapComposerRef>}
                      agentId={agentId}
                      onSend={onComposerSend}
                      showFirstStartupNudge={showFirstStartupNudge}
                    />
                  )}
                </div>
              </SmoothHeight>

              {belowComposer ? (
                <SmoothHeight>
                  <div className="mx-auto w-full max-w-[520px] pt-12 sm:pt-14">{belowComposer}</div>
                </SmoothHeight>
              ) : null}
            </>
          ) : null}

          {/* Tool approvals */}
          {rendersInlineComposer ? (
            <SmoothHeight>
              <ApprovalsContainer
                ownerAgentId={agentId}
                className="mx-auto w-full max-w-[660px] pt-10 sm:pt-12"
              />
            </SmoothHeight>
          ) : null}

        </div>
      </div>

      {/* Ghost button animation */}
      {ghost && (
        <GhostElement
          startRect={ghost.startRect}
          endX={ghost.endX}
          endY={ghost.endY}
          endScale={0.8}
          onComplete={() => setGhost(null)}
          className="flex items-center gap-2 rounded-full bg-[var(--oa-bg-app)] px-4 py-2.5 shadow-[var(--oa-shadow-sm)]"
          style={{ border: '1px solid var(--oa-border, var(--border))' }}
        >
          {GhostIcon && <GhostIcon className="size-4 shrink-0 text-[var(--oa-text-muted)]" />}
          <span className="flex-1 text-[13px] text-[var(--oa-text)]">{ghost.title}</span>
        </GhostElement>
      )}
    </div>
  );
}
