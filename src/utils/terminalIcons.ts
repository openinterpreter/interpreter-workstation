/**
 * Shared terminal icon map and resolver.
 *
 * Single source of truth for mapping TerminalIconId → React component.
 * Used by sidebar tabs, editor tabs, and the new-agent popover.
 */

import type { ComponentType, CSSProperties } from 'react';
import { Terminal, Bot, Code, Sparkles, Brain, Zap } from 'lucide-react';
import { ClaudeIcon, OpenAIIcon } from '../components/icons/BrandIcons';
import type { TerminalConfig } from '../../shared/types/model';

/** All possible terminal icon identifiers */
export type TerminalIconId = 'claude' | 'openai' | 'terminal' | 'bot' | 'code' | 'sparkle' | 'brain' | 'zap';
import { TERMINAL_AGENTS, type TerminalAgentId } from '../../shared/terminalAgents';

/** Maps each TerminalIconId to its React icon component */
export const TERMINAL_ICON_MAP: Record<TerminalIconId, ComponentType<{ className?: string; style?: CSSProperties }>> = {
  claude: ClaudeIcon,
  openai: OpenAIIcon,
  terminal: Terminal,
  bot: Bot,
  code: Code,
  sparkle: Sparkles,
  brain: Brain,
  zap: Zap,
};

/**
 * Resolves the icon component for a terminal tab.
 *
 * Resolution order:
 * 1. Profile's terminal config icon (custom profiles)
 * 2. Built-in agent icon (claude-code → claude, codex → openai)
 * 3. Fallback: ClaudeIcon
 */
export function getTerminalIcon(
  terminalConfig?: TerminalConfig,
  terminalAgentId?: string,
): ComponentType<{ className?: string; style?: CSSProperties }> {
  // 1. Profile terminal icon
  if (terminalConfig?.icon && terminalConfig.icon in TERMINAL_ICON_MAP) {
    return TERMINAL_ICON_MAP[terminalConfig.icon];
  }

  // 2. Built-in agent icon
  if (terminalAgentId && terminalAgentId in TERMINAL_AGENTS) {
    const agentIcon = TERMINAL_AGENTS[terminalAgentId as TerminalAgentId].icon;
    if (agentIcon in TERMINAL_ICON_MAP) {
      return TERMINAL_ICON_MAP[agentIcon];
    }
  }

  // 3. Fallback
  return ClaudeIcon;
}
