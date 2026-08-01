import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { BookOpen, Globe, Play, Plus, X } from 'lucide-react';
import { showContextMenu, showItemInFolder, skills as skillsIpc, workspace, type ContextMenuItem } from '@/ipc';
import { useLayout } from '../hooks/useLayout';
import { serializeSkillMentionToken } from '../../shared/utils/skillMentions';
import {
  AGENT_SEED_COMPOSER_EVENT,
  enqueuePendingAgentComposerSeed,
  type AgentSeedComposerDetail,
} from '../../shared/agentEvents';
import type { SkillOption, SkillsData } from '../../shared/types/skill';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  SIDEBAR_FOOTER_FULL_WIDTH_BUTTON_CLASSNAME,
  SIDEBAR_FOOTER_LEADING_SLOT_CLASSNAME,
} from './sidebarFooterButtonStyles';
import { getSidebarFooterMotion, SIDEBAR_FOOTER_PANEL_STYLE } from './sidebarFooterMotion';

interface SkillsPanelProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onFileOpen: (path: string) => void;
}

function serializeSkillToken(skill: SkillOption): string {
  return serializeSkillMentionToken({
    id: skill.id,
    label: skill.title,
    name: skill.name,
    path: skill.filePath,
  });
}

function buildRunSkillPrompt(skill: SkillOption): string {
  return [
    serializeSkillToken(skill),
    'Follow this skill.',
  ].join('\n\n');
}

function buildEditSkillPrompt(skill: SkillOption): string {
  return [
    `Help me edit this skill: ${serializeSkillToken(skill)}`,
    'I want it to:',
  ].join('\n\n');
}

function buildCreateSkillSeed(skill: SkillOption): string {
  return `${serializeSkillToken(skill)} `;
}

function sortSkills(skills: SkillOption[]): SkillOption[] {
  return [...skills].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === 'project' ? -1 : 1;
    }

    return a.title.localeCompare(b.title, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function SkillRow({
  skill,
  canOpenFolder,
  onRun,
  onOpenFolder,
  onEditWithAgent,
  onOpenFile,
}: {
  skill: SkillOption;
  canOpenFolder: boolean;
  onRun: (skill: SkillOption) => void;
  onOpenFolder: (skill: SkillOption) => void;
  onEditWithAgent: (skill: SkillOption) => void;
  onOpenFile: (skill: SkillOption) => void;
}) {
  const handleContextMenu = useCallback(async (event: React.MouseEvent) => {
    event.preventDefault();

    const items: ContextMenuItem[] = [
      { label: 'Run Skill', action: 'run' },
      { label: 'Edit with Agent', action: 'edit-with-agent' },
      { label: 'Open Skill File', action: 'open-skill-file' },
      { label: 'Show in Finder', action: 'show-in-finder' },
      { label: 'Copy Path', action: 'copy-path' },
    ];
    if (canOpenFolder) {
      items.splice(2, 0, { label: 'Open Folder', action: 'open-folder' });
    }

    const action = await showContextMenu(items, 'skills_panel');
    if (action === 'run') {
      onRun(skill);
      return;
    }
    if (action === 'edit-with-agent') {
      onEditWithAgent(skill);
      return;
    }
    if (action === 'open-folder') {
      onOpenFolder(skill);
      return;
    }
    if (action === 'open-skill-file') {
      onOpenFile(skill);
      return;
    }
    if (action === 'show-in-finder') {
      await showItemInFolder(skill.dirPath);
      return;
    }
    if (action === 'copy-path') {
      await navigator.clipboard.writeText(skill.dirPath);
    }
  }, [canOpenFolder, onEditWithAgent, onOpenFile, onOpenFolder, onRun, skill]);

  return (
    <div
      className="group flex items-center gap-2 rounded-[14px] px-2 py-1 transition-[background-color,transform] duration-200 hover:bg-black/[0.035] dark:hover:bg-white/[0.05]"
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={() => onRun(skill)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[12px] px-2.5 py-2 text-left transition-colors group-hover:text-[#111827] focus-visible:bg-black/[0.04] dark:group-hover:text-[#f8f8f8] dark:focus-visible:bg-white/[0.06]"
      >
        <span className="truncate text-ui-sm text-[#202123] dark:text-[#f5f5f5]">
          {skill.title}
        </span>
        {skill.source === 'global' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="flex size-4 flex-shrink-0 items-center justify-center text-[#7a808a] dark:text-[#9ea3ab]"
                aria-label="This skill is available in all projects."
              >
                <Globe className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              This skill is available in all projects.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </button>

      <div className="ml-3 flex w-[50px] shrink-0 justify-end">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onRun(skill)}
          aria-label={`Run ${skill.title}`}
          title={`Run ${skill.title}`}
          className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full border border-black/[0.06] bg-black/[0.03] px-0 text-[#4b5563] shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] transition-[width,background-color,color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:w-[50px] hover:border-black/[0.1] hover:bg-black/[0.06] hover:text-[#111827] focus-visible:w-[50px] focus-visible:border-black/[0.12] focus-visible:bg-black/[0.06] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#d1d5db] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-white/[0.14] dark:hover:bg-white/[0.09] dark:hover:text-[#f8f8f8] dark:focus-visible:border-white/[0.14] dark:focus-visible:bg-white/[0.09]"
        >
          <span
            className="pointer-events-none absolute inset-y-0 left-0 flex items-center whitespace-nowrap pl-2 transition-transform duration-150 ease-out -translate-x-1 group-hover:translate-x-0 group-focus-visible/button:translate-x-0"
          >
            <span
              className="text-ui-sm font-medium leading-none opacity-0 transition-opacity duration-75 ease-out group-hover:delay-100 group-hover:opacity-100 group-focus-visible/button:delay-100 group-focus-visible/button:opacity-100"
            >
              Run
            </span>
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0 flex w-7 items-center justify-center">
            <Play className="size-3 fill-current" />
          </span>
        </Button>
      </div>
    </div>
  );
}

export function SkillsPanel({ isOpen, onOpenChange, onFileOpen }: SkillsPanelProps) {
  "use no memo";

  const { openFolder, openNewTab, openSeededAgentTab } = useLayout();
  const reducedMotion = useReducedMotion() ?? false;
  const panelMotion = getSidebarFooterMotion('panel', reducedMotion);
  const triggerMotion = getSidebarFooterMotion('trigger', reducedMotion);
  const [data, setData] = useState<SkillsData | null>(null);
  const canOpenFolderTabs = typeof window !== 'undefined' && Boolean(window.electron?.files?.listDirectory);
  const loadSkills = useCallback(async () => {
    try {
      const result = await skillsIpc.list();
      if (result.success && result.data) {
        setData(result.data);
        return;
      }
      setData(null);
    } catch (error) {
      console.error('[SkillsPanel] Failed to load skills:', error);
      setData(null);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
    const unsubscribeSkillsChanged = skillsIpc.onChanged?.(() => {
      void loadSkills();
    });
    const unsubscribeWorkspaceChanged = workspace.onChanged(() => {
      void loadSkills();
    });

    return () => {
      unsubscribeSkillsChanged?.();
      unsubscribeWorkspaceChanged();
    };
  }, [loadSkills]);

  const skills = useMemo(() => {
    return sortSkills([
      ...(data?.project.skills ?? []),
      ...(data?.global.skills ?? []),
    ]);
  }, [data]);

  const skillCreator = useMemo(() => {
    return skills.find((skill) => skill.name === 'skill-creator') ?? null;
  }, [skills]);

  const seedAgentComposer = useCallback((tabId: string, prompt: string, autoSend: boolean) => {
    const detail: AgentSeedComposerDetail = {
      agentId: tabId,
      prompt,
      autoSend,
    };
    enqueuePendingAgentComposerSeed(detail);

    const composer = document.querySelector(`[data-agent-id="${tabId}"] [contenteditable="true"]`);
    if (!composer) {
      return;
    }

    window.dispatchEvent(new CustomEvent(AGENT_SEED_COMPOSER_EVENT, { detail }));
  }, []);

  const handleRunSkill = useCallback((skill: SkillOption) => {
    const prompt = buildRunSkillPrompt(skill);
    openSeededAgentTab(prompt);
  }, [openSeededAgentTab]);

  const handleEditSkill = useCallback((skill: SkillOption) => {
    const tabId = openNewTab();
    seedAgentComposer(tabId, buildEditSkillPrompt(skill), false);
  }, [openNewTab, seedAgentComposer]);

  const handleOpenSkillFolder = useCallback((skill: SkillOption) => {
    if (!canOpenFolderTabs) {
      onFileOpen(skill.filePath);
      return;
    }
    openFolder(skill.dirPath);
  }, [canOpenFolderTabs, onFileOpen, openFolder]);

  const handleOpenSkillFile = useCallback((skill: SkillOption) => {
    onFileOpen(skill.filePath);
  }, [onFileOpen]);

  const handleCreateSkill = useCallback(() => {
    if (!skillCreator) {
      return;
    }
    const tabId = openNewTab();
    seedAgentComposer(tabId, buildCreateSkillSeed(skillCreator), false);
  }, [openNewTab, seedAgentComposer, skillCreator]);

  return (
    <div className="box-border flex flex-shrink-0 flex-col px-1">
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            key="skills-panel"
            initial={panelMotion.initial}
            animate={panelMotion.animate}
            exit={panelMotion.exit}
            transition={panelMotion.transition}
            style={SIDEBAR_FOOTER_PANEL_STYLE}
            className="mb-2 flex max-h-[320px] min-h-0 flex-col overflow-hidden rounded-[18px] border border-black/[0.06] bg-[var(--oa-surface-center)] shadow-[0_8px_30px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:shadow-[0_10px_32px_rgba(0,0,0,0.34)]"
          >
          <div
            className="flex min-h-[calc(var(--unit-height)-8px)] items-center gap-2 px-3 py-2"
            style={{ borderBottom: 'var(--border-width) solid color-mix(in srgb, var(--border) 82%, transparent)' }}
          >
            <BookOpen className="size-3.5 text-[#5f6673] dark:text-[#bdbdbd]" />
            <div className="min-w-0 flex-1 truncate text-ui-sm font-medium leading-tight text-[#2d3440] dark:text-[#e0e0e0]">
              Skills
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-toolbar"
              onClick={() => onOpenChange(false)}
              aria-label="Close skills"
              className="text-[#5f6673] hover:bg-black/[0.045] hover:text-[#202123] dark:text-[#bdbdbd] dark:hover:bg-white/[0.06] dark:hover:text-[#f5f5f5]"
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <div className="min-h-0 max-h-[240px] flex-1 overflow-y-auto overscroll-contain px-1 py-2">
            {skills.length === 0 ? (
              <div className="px-3 py-2 text-ui-sm text-[#6b7280] dark:text-[#b4b4b4]">
                No skills found
              </div>
            ) : (
              skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  canOpenFolder={canOpenFolderTabs}
                  onRun={handleRunSkill}
                  onOpenFolder={handleOpenSkillFolder}
                  onEditWithAgent={handleEditSkill}
                  onOpenFile={handleOpenSkillFile}
                />
              ))
            )}
          </div>

          <div
            className="flex items-center px-2 py-2"
            style={{ borderTop: 'var(--border-width) solid color-mix(in srgb, var(--border) 82%, transparent)' }}
          >
            <Button
              type="button"
              variant="ghost"
              onClick={handleCreateSkill}
              disabled={!skillCreator}
              className="w-full justify-start gap-2 rounded-[12px] px-3 py-2 text-ui-sm text-[#2d3440] hover:bg-black/[0.03] hover:text-[#202123] dark:text-[#e0e0e0] dark:hover:bg-white/[0.04] dark:hover:text-[#f5f5f5]"
            >
              <Plus className="size-3.5" />
              <span>Create Skill</span>
            </Button>
          </div>
          </motion.div>
        ) : (
          <motion.div
            key="skills-trigger"
            initial={triggerMotion.initial}
            animate={triggerMotion.animate}
            exit={triggerMotion.exit}
            transition={triggerMotion.transition}
            className="flex-shrink-0 pb-2 pt-0.5"
          >
            <div className="px-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(true)}
                className={SIDEBAR_FOOTER_FULL_WIDTH_BUTTON_CLASSNAME}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className={SIDEBAR_FOOTER_LEADING_SLOT_CLASSNAME}>
                    <BookOpen className="size-3.5 text-[#5f6673] dark:text-[#bdbdbd]" />
                  </span>
                  <span className="min-w-0 truncate text-ui-sm font-medium leading-tight">Skills</span>
                </span>
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
