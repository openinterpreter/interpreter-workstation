/**
 * Shared type definitions for agent model configuration
 *
 * IMPORTANT: This is the SINGLE SOURCE OF TRUTH for model configuration types.
 * All other files should import from here.
 */

import type { ApiPreset } from './provider';
import type { ReasoningEffort } from './reasoning';
import {
  ANTHROPIC_MODEL_OPTIONS,
  INTERPRETER_MODEL_OPTIONS,
  GROQ_MODEL_OPTIONS,
  OPENAI_MODEL_OPTIONS,
  OPENROUTER_MODEL_OPTIONS,
} from '../generated/modelCatalog';

// DeepSeek's /models endpoint returns only lowercase ids (no display names), so
// the shipped defaults mirror that shape: the dropdown looks identical before and
// after a live fetch replaces them.
const DEEPSEEK_MODEL_OPTIONS = [
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
] as const;

/**
 * Model provider type - what kind of provider is this
 *
 * - 'hosted' = Our hosted service
 * - 'local' = Local runtime (Ollama or LM Studio)
 * - 'openai-oauth' = OpenAI via OAuth (sign in with ChatGPT)
 * - 'agent' = CLI agent (Claude Code) - modelId selects which
 * - 'api' = Custom API (Anthropic, OpenAI, Groq, OpenRouter, etc.)
 * - 'terminal' = Terminal-based agents (runs in PTY)
 */
export type ModelProvider = 'hosted' | 'local' | 'openai-oauth' | 'agent' | 'api' | 'terminal';

export type WireApi = 'responses' | 'chat' | 'messages';

/**
 * API format - which SDK/protocol to use for 'api' providers
 */
export type ApiFormat = 'openai' | 'anthropic';

/**
 * Terminal agent configuration
 * Used for terminal-based coding agents (Claude Code, Codex, custom) that run in a PTY
 */
export interface TerminalConfig {
  id: string;  // Agent ID (e.g., 'claude-code', 'codex', or custom)
  command: string;
  icon?: 'claude' | 'openai' | 'terminal';
  richInput?: boolean;  // If true, show rich text composer; if false, use terminal directly
  hideInput?: boolean;  // If true (and richInput is on), hide the terminal input prompt area
  inputMarker?: string;  // Character to detect input prompt for hiding (default: '❯')
  titleMarker?: string;  // Character to detect assistant response for tab title (e.g., '⏺' for Claude)
  helpDescription?: string;  // Description shown in help panel on hover
}

/**
 * Model configuration — the core "point at a model" shape.
 * Used for the main model, fast model, vision model, etc.
 * Can be any provider - local runtime, hosted, OpenAI, Anthropic, etc.
 */
export interface ModelConfig {
  providerId?: string;  // Reference to a Provider (for OAuth token lookup)
  provider: ModelProvider;
  modelId: string;
  apiKey?: string;      // Optional custom API key
  environmentKey?: string; // Environment variable resolved only when the model runs
  baseURL?: string;     // Optional custom base URL
  apiFormat?: ApiFormat; // API format for 'api' providers (openai or anthropic)
}

/** @deprecated Use ModelConfig instead */
export type VisionModelConfig = ModelConfig;

/**
 * Model configuration for an agent
 *
 * Extends ModelConfig with agent-level behavior settings.
 * The main model fields (provider, modelId, etc.) are inherited from ModelConfig.
 *
 * Agents can either:
 * 1. Reference a profile by ID (profileId is set)
 * 2. Use inline configuration (provider/modelId/etc)
 *
 * When profileId is set, the profile's settings are used.
 * The inline fields serve as fallback if profile is not found.
 *
 * When providerId is set, the server looks up the Provider to get
 * OAuth tokens or other provider-specific configuration.
 */
export interface AgentModelConfig extends ModelConfig {
  profileId?: string; // Reference to a saved profile
  codexProfileId?: string; // Explicit codex runtime profile ID (e.g. 'ollama', 'lmstudio')
  /**
   * OIX agent harness override. Undefined lets OIX choose the recommended
   * harness for the provider/model; null explicitly selects native Codex.
   */
  harness?: string | null;
  reasoningEffort?: ReasoningEffort; // Per-chat reasoning effort override/default
  disabledTools?: string[]; // Tool server IDs disabled/blacklisted for this profile
  // Provider-specific config (only one is set, determined by `provider` field)
  providerConfig?: TerminalConfig;
  // Legacy persisted state. Runtime routing now uses wireApi/wire_api.
  // Keep this field for existing configs, but do not use it to choose Chat Completions.
  useResponsesApi?: boolean;
  // OIX provider wire protocol. Defaults to Responses when omitted.
  wireApi?: WireApi;
  // Maximum tool calls per task before stopping. Default: 1000.
  maxSteps?: number;
  // Maximum subagent nesting depth. Default: 5.
  maxSubagentDepth?: number;
  // Vision model settings - separate model for vision tasks (read_image tool)
  visionModel?: ModelConfig;
  // Fast model settings - optional cheaper/faster model for subagents
  // When set, subagent tools default to using this model instead of the main (smart) model.
  // The main model serves as the "smart" model that subagents can escalate to.
  fastModel?: ModelConfig;
}

/**
 * Type guard for agent provider config
 * Returns true if config is for a CLI agent (Claude Code, Codex, etc.)
 * The modelId determines which specific agent: 'claude-code', 'codex', etc.
 */
export function isAgentConfig(config: AgentModelConfig): boolean {
  return config.provider === 'agent';
}

/**
 * Type guard for terminal model config
 * Returns true if config is for a terminal-based agent (Claude Code Terminal, Codex Terminal)
 */
export function isTerminalConfig(config: AgentModelConfig): config is AgentModelConfig & { provider: 'terminal'; providerConfig: TerminalConfig } {
  return config.provider === 'terminal' && config.providerConfig !== undefined;
}

// DEFAULT_MODEL_CONFIG moved to profile.ts to avoid circular dependency

/**
 * Keys for MODEL_OPTIONS - combines API presets with special provider types
 * This is about the SERVICE (which determines available models), not the API format
 */
export type ModelOptionsKey = ApiPreset | 'hosted' | 'agent' | 'local' | 'terminal';

/**
 * Predefined model options for each service.
 * Remote provider lists are generated from models.dev via `pnpm run generate:model-catalog`.
 * Note: This is keyed by SERVICE (anthropic, openai, groq, etc.), not API format.
 */
export const MODEL_OPTIONS: Record<ModelOptionsKey, { id: string; name: string }[]> = {
  anthropic: [...ANTHROPIC_MODEL_OPTIONS],
  openai: [...OPENAI_MODEL_OPTIONS],
  groq: [...GROQ_MODEL_OPTIONS],
  openrouter: [...OPENROUTER_MODEL_OPTIONS],
  deepseek: [...DEEPSEEK_MODEL_OPTIONS],
  // Our hosted service uses Interpreter aliases plus a curated remote catalog elsewhere.
  hosted: [...INTERPRETER_MODEL_OPTIONS],
  agent: [
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
  ],
  local: [], // Dynamically populated from local runtime at runtime
  terminal: [
    { id: 'claude-code-terminal', name: 'Claude Code Terminal' },
    { id: 'codex-terminal', name: 'Codex Terminal' },
  ],
};
