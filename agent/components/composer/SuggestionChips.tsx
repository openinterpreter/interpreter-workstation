/**
 * SuggestionChips Component
 *
 * Displays contextual suggestion chips above the composer based on:
 * - Active tab type (file, browser, email, settings)
 * - File type (image, code, document, etc.)
 * - Text selection (md/txt files only)
 *
 * Clicking a chip inserts the suggestion text into the composer.
 *
 * Features:
 * - Dynamic theme switching suggestion on settings page
 * - Selection-based suggestions only for markdown/text files
 * - 2-second delayed fade-in animation when suggestions change
 */

import { FC, useContext, useMemo, useState, useEffect, useRef } from 'react';
import { LayoutContext } from '../../../src/contexts/LayoutContext';
import type { Tab } from '../../../shared/types/layout';
import type { SkillOption } from '../../../shared/types/skill';
import { serializeSkillMentionToken } from '../../../shared/utils/skillMentions';
import { findPaneById } from '../../../src/utils/treeOperations';
import { skills as skillsIpc, theme as themeIpc } from '../../../src/ipc';
import type { ThemeChangedEvent } from '../../../electron/ipc/registry';

export interface Suggestion {
  id: string;
  label: string;
  prompt: string;
  action?: 'insert' | 'send';
}

interface SuggestionChipsProps {
  onSuggestionClick: (suggestion: Suggestion) => void;
  messageCount?: number; // If provided, used instead of thread.messages.length
  hasQueuedMessages?: boolean;
  isStreaming?: boolean;
  suggestionsOverride?: Suggestion[];
  fadeInDelayMs?: number;
  positionMode?: 'overlay' | 'inline';
  externalOpacity?: number;
  onMeasuredHeightChange?: (height: number) => void;
}

const REMEMBER_SKILL_MIN_MESSAGES = 6;
const REMEMBER_SKILL_SHOW_PROBABILITY = 0.3;
const SUGGESTION_CHIP_INTERACTION_MIN_OPACITY = 0.18;

export function shouldEnableSuggestionChipInteractions(params: {
  hasQueuedMessages: boolean;
  isStreaming: boolean;
  isVisible: boolean;
  externalOpacity: number;
}): boolean {
  return !params.hasQueuedMessages
    && !params.isStreaming
    && params.isVisible
    && params.externalOpacity >= SUGGESTION_CHIP_INTERACTION_MIN_OPACITY;
}

/**
 * Get file extension from path
 */
function getFileExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1) return '';
  return path.slice(lastDot + 1).toLowerCase();
}

/**
 * Categorize file type based on extension
 */
function getFileCategory(ext: string): 'image' | 'code' | 'document' | 'video' | 'audio' | 'data' | 'unknown' {
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic', 'heif'];
  const codeExts = ['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'swift', 'kt', 'scala', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'vue', 'svelte'];
  const documentExts = ['md', 'mdx', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt'];
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'];
  const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'];
  const dataExts = ['json', 'yaml', 'yml', 'xml', 'csv', 'tsv', 'toml', 'ini', 'conf'];

  if (imageExts.includes(ext)) return 'image';
  if (codeExts.includes(ext)) return 'code';
  if (documentExts.includes(ext)) return 'document';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (dataExts.includes(ext)) return 'data';
  return 'unknown';
}

/**
 * Check if a file extension is a text-editable file (markdown or plain text)
 */
function isTextEditableFile(ext: string): boolean {
  const textEditableExts = ['md', 'mdx', 'txt', 'text'];
  return textEditableExts.includes(ext);
}

/**
 * Determine the effective theme (resolves 'system' to actual light/dark)
 */
function getEffectiveTheme(themeSetting: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (themeSetting === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return themeSetting;
}

/**
 * Generate suggestions based on active tab, selection, and theme
 */
function generateSuggestions(
  activeTab: Tab | null,
  hasSelection: boolean,
  selectionLength: number,
  themeSetting: 'light' | 'dark' | 'system'
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // Selection-based suggestions - only for markdown/text files
  if (hasSelection && selectionLength > 0 && activeTab?.type === 'file' && activeTab.path) {
    const ext = getFileExtension(activeTab.path);
    if (isTextEditableFile(ext)) {
      suggestions.push({
        id: 'selection-enrich',
        label: 'Enrich my selection with research',
        prompt: 'Enrich my selection with web research to add more context and depth.'
      });
      return suggestions;
    }
  }

  if (!activeTab) {
    return [];
  }

  switch (activeTab.type) {
    case 'file': {
      if (!activeTab.path) return [];
      const ext = getFileExtension(activeTab.path);
      const category = getFileCategory(ext);

      if (category === 'image') {
        suggestions.push({ id: 'image-extract-text', label: 'Extract text', prompt: 'Extract any text visible in this image.' });
      }
      break;
    }

    case 'settings': {
      suggestions.push({ id: 'settings-explain', label: 'Explain my settings', prompt: 'Explain what my current settings do and how they affect the application.' });

      // Dynamic theme switching suggestion
      const effectiveTheme = getEffectiveTheme(themeSetting);
      const targetTheme = effectiveTheme === 'dark' ? 'light' : 'dark';
      suggestions.push({
        id: `settings-theme-${targetTheme}`,
        label: `Switch to ${targetTheme} mode`,
        prompt: `Switch my theme to ${targetTheme} mode.`
      });
      break;
    }

    default:
      // No suggestions for other tab types
      break;
  }

  return suggestions;
}

export function buildRememberSkillSuggestion(
  skillCreator: Pick<SkillOption, 'id' | 'name' | 'title' | 'filePath'> | null,
): Suggestion | null {
  if (!skillCreator) {
    return null;
  }

  return {
    id: 'remember-this-skill',
    label: 'Remember this skill',
    prompt: serializeSkillMentionToken({
      id: skillCreator.id,
      label: skillCreator.title || skillCreator.name,
      name: skillCreator.name,
      path: skillCreator.filePath,
    }),
  };
}

export const SuggestionChips: FC<SuggestionChipsProps> = ({
  onSuggestionClick,
  messageCount,
  hasQueuedMessages = false,
  isStreaming = false,
  suggestionsOverride,
  fadeInDelayMs = 2000,
  positionMode = 'overlay',
  externalOpacity = 1,
  onMeasuredHeightChange,
}) => {
  const layout = useContext(LayoutContext);

  const safeMessageCount = messageCount ?? 0;
  const isChatEmpty = safeMessageCount === 0;
  const [showRememberSkill, setShowRememberSkill] = useState(false);
  const [rememberSkillSuggestion, setRememberSkillSuggestion] = useState<Suggestion | null>(null);
  const hasCrossedMessageThresholdRef = useRef(false);

  // Theme state for dynamic suggestions
  const [themeSetting, setThemeSetting] = useState<'light' | 'dark' | 'system'>('system');

  // Animation state: controls visibility with delayed fade-in
  const [isVisible, setIsVisible] = useState(false);
  const [displayedSuggestions, setDisplayedSuggestions] = useState<Suggestion[]>([]);
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load theme and subscribe to changes
  useEffect(() => {
    async function loadTheme() {
      try {
        const response = await themeIpc.get();
        setThemeSetting(response.theme);
      } catch (error) {
        console.error('Failed to load theme:', error);
      }
    }
    loadTheme();

    const unsubscribe = themeIpc.onChanged((event: ThemeChangedEvent) => {
      setThemeSetting(event.theme);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadRememberSkillSuggestion = async () => {
      let response: Awaited<ReturnType<typeof skillsIpc.list>>;
      try {
        response = await skillsIpc.list({ workspacePath: null });
      } catch (error) {
        console.error('Failed to load skill creator:', error);
        if (!cancelled) {
          setRememberSkillSuggestion(null);
        }
        return;
      }

      if (!response.success || !response.data) {
        if (!cancelled) {
          setRememberSkillSuggestion(null);
        }
        return;
      }

      const skillCreator = [
        ...response.data.global.skills,
        ...response.data.project.skills,
      ].find((skill) => skill.name === 'skill-creator') ?? null;

      if (!cancelled) {
        setRememberSkillSuggestion(buildRememberSkillSuggestion(skillCreator));
      }
    };

    void loadRememberSkillSuggestion();
    const unsubscribe = skillsIpc.onChanged?.(() => {
      void loadRememberSkillSuggestion();
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const { activeTab, hasSelection, selectionLength } = useMemo(() => {
    if (!layout) {
      return { activeTab: null, hasSelection: false, selectionLength: 0 };
    }

    // Find active tab from tree-based layout
    const pane = findPaneById(layout.state.tree, layout.state.activePaneId || '');
    const tab = pane?.activeTabId ? layout.state.tabs[pane.activeTabId] ?? null : null;

    // Check selection
    const selection = layout.currentSelection;
    const selLen = selection?.type === 'text' ? selection.text.length : 0;

    return {
      activeTab: tab,
      hasSelection: selection?.type === 'text' ? !!selection.text : selection?.type === 'files' ? selection.items.length > 0 : false,
      selectionLength: selLen,
    };
  }, [layout, layout?.state.tree, layout?.state.tabs, layout?.state.activePaneId, layout?.currentSelection]);

  const suggestions = useMemo(
    () => generateSuggestions(activeTab, hasSelection, selectionLength, themeSetting),
    [activeTab, hasSelection, selectionLength, themeSetting]
  );

  useEffect(() => {
    const hasEnoughMessages = safeMessageCount >= REMEMBER_SKILL_MIN_MESSAGES;

    if (!hasEnoughMessages) {
      hasCrossedMessageThresholdRef.current = false;
      setShowRememberSkill(false);
      return;
    }

    // Roll once when crossing the threshold so visibility is stable for this conversation window.
    if (!hasCrossedMessageThresholdRef.current) {
      hasCrossedMessageThresholdRef.current = true;
      setShowRememberSkill(Math.random() < REMEMBER_SKILL_SHOW_PROBABILITY);
    }
  }, [safeMessageCount]);

  const conversationSuggestions = useMemo(() => {
    if (!isChatEmpty && safeMessageCount >= REMEMBER_SKILL_MIN_MESSAGES && showRememberSkill && rememberSkillSuggestion) {
      return [rememberSkillSuggestion];
    }
    return [];
  }, [isChatEmpty, rememberSkillSuggestion, safeMessageCount, showRememberSkill]);

  const effectiveSuggestions = suggestionsOverride
    ? suggestionsOverride
    : (isChatEmpty ? suggestions : conversationSuggestions);

  // Create a stable key for the current suggestions to detect changes
  const suggestionsKey = useMemo(
    () => effectiveSuggestions.map((suggestion) => JSON.stringify({
      id: suggestion.id,
      label: suggestion.label,
      prompt: suggestion.prompt,
      action: suggestion.action ?? 'insert',
    })).join('|'),
    [effectiveSuggestions]
  );
  const hasSuggestionsToReserve = displayedSuggestions.length > 0;
  const isRailInteractive = shouldEnableSuggestionChipInteractions({
    hasQueuedMessages,
    isStreaming,
    isVisible,
    externalOpacity,
  });
  const shouldHideRail = hasQueuedMessages || isStreaming || !isVisible;
  const shouldDisableRailPointerEvents = shouldHideRail
    || externalOpacity < SUGGESTION_CHIP_INTERACTION_MIN_OPACITY;

  // Handle delayed fade-in when suggestions change
  useEffect(() => {
    // Clear any pending timeout
    if (fadeTimeoutRef.current) {
      clearTimeout(fadeTimeoutRef.current);
      fadeTimeoutRef.current = null;
    }

    // Immediately fade out
    setIsVisible(false);

    // After 2 seconds, update suggestions and fade in
    fadeTimeoutRef.current = setTimeout(() => {
      setDisplayedSuggestions(effectiveSuggestions);
      if (effectiveSuggestions.length > 0) {
        setIsVisible(true);
      }
    }, fadeInDelayMs);

    return () => {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
      }
    };
  }, [fadeInDelayMs, suggestionsKey]);

  const handleChipClick = (suggestion: Suggestion) => {
    onSuggestionClick(suggestion);
  };

  useEffect(() => {
    if (!onMeasuredHeightChange) {
      return;
    }

    if (positionMode !== 'overlay') {
      onMeasuredHeightChange(0);
      return;
    }

    const node = containerRef.current;
    if (!node || displayedSuggestions.length === 0) {
      onMeasuredHeightChange(0);
      return;
    }

    const updateHeight = () => {
      const rect = node.getBoundingClientRect();
      onMeasuredHeightChange(Math.ceil(rect.height) + 12);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [displayedSuggestions.length, isVisible, onMeasuredHeightChange, positionMode]);

  useEffect(() => {
    if (!onMeasuredHeightChange) {
      return;
    }
    if (displayedSuggestions.length === 0 || positionMode !== 'overlay') {
      onMeasuredHeightChange(0);
    }
  }, [
    displayedSuggestions.length,
    onMeasuredHeightChange,
    positionMode,
  ]);

  // Don't render anything if no suggestions to display
  if (!hasSuggestionsToReserve && !isVisible) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={positionMode === 'inline'
        ? 'flex flex-wrap items-start gap-1.5 px-3 pt-3 pb-1 transition-opacity duration-300'
        : 'pointer-events-none absolute flex flex-wrap items-start gap-1.5 transition-opacity duration-300'}
      style={positionMode === 'inline'
        ? {
            opacity: shouldHideRail ? 0 : externalOpacity,
            pointerEvents: shouldDisableRailPointerEvents ? 'none' : undefined,
          }
        : {
            opacity: shouldHideRail ? 0 : externalOpacity,
            left: 'calc(var(--unit-padding) + 2px)',
            right: 'calc(var(--unit-padding) + 2px)',
            bottom: 'calc(100% + 0.625rem)',
            pointerEvents: shouldDisableRailPointerEvents ? 'none' : undefined,
          }}
    >
      {displayedSuggestions.map((suggestion, idx) => (
        <button
          key={idx}
          disabled={!isRailInteractive}
          onClick={() => handleChipClick(suggestion)}
          className={[
            isRailInteractive ? 'pointer-events-auto' : 'pointer-events-none',
            'inline-flex h-7 items-center rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:text-foreground',
          ].join(' ')}
          style={{
            background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 88%, transparent)',
            border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 52%, transparent)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {suggestion.label}
        </button>
      ))}
    </div>
  );
};

export default SuggestionChips;
