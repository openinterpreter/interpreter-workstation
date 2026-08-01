export const ONBOARDING_STATE_VERSION = 1;
export const ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID = 'overlay-first-success';

export type OnboardingExtensionDecision = 'undecided' | 'install' | 'skip';

export interface OnboardingInterviewResult {
  summary: string;
  modelPreferences: string[];
  workingPreferences: string[];
  customInstructionsDraft: string;
  updatedAt: string;
}

export interface OnboardingImportedToolSummary {
  generatedAt: string | null;
  sources: string[];
  summary: string;
}

export interface OnboardingInterviewAnswers {
  modelsUsed: string;
  aiUseToday: string;
  currentSetup: string;
}

export interface OnboardingImportedToolSummaryInput {
  detectedProviders: string[];
  detectedTools: string[];
  detectedConfigDirs: string[];
  detectedApps: string[];
  discoveredMcps?: OnboardingImportedMcpSummaryInput[];
  generatedAt: string;
}

export interface OnboardingImportedMcpSummaryInput {
  name: string;
  source: 'claude-code' | 'cursor';
  transport: string;
}

export interface OnboardingState {
  version: typeof ONBOARDING_STATE_VERSION;
  completed: boolean;
  completedStepIds: string[];
  interviewDraft: string;
  interviewResult: OnboardingInterviewResult | null;
  extensionDecisions: Record<string, OnboardingExtensionDecision>;
  importedToolSummary: OnboardingImportedToolSummary;
}

export function createDefaultOnboardingState(): OnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    completed: false,
    completedStepIds: [],
    interviewDraft: '',
    interviewResult: null,
    extensionDecisions: {},
    importedToolSummary: {
      generatedAt: null,
      sources: [],
      summary: '',
    },
  };
}

export function markOnboardingStepIdComplete(
  state: OnboardingState,
  stepId: string,
): OnboardingState {
  if (state.completedStepIds.includes(stepId)) {
    return state;
  }

  return {
    ...state,
    completedStepIds: [...state.completedStepIds, stepId],
  };
}

export function buildOnboardingCustomInstructionsDraft(
  result: Pick<OnboardingInterviewResult, 'summary' | 'modelPreferences' | 'workingPreferences'>,
): string {
  const lines = [
    result.summary.trim() ? `Onboarding summary: ${result.summary.trim()}` : null,
    ...result.modelPreferences
      .map((preference) => preference.trim())
      .filter(Boolean)
      .map((preference) => `Model preference: ${preference}`),
    ...result.workingPreferences
      .map((preference) => preference.trim())
      .filter(Boolean)
      .map((preference) => `Working preference: ${preference}`),
  ].filter((line): line is string => line !== null);

  return lines.join('\n');
}

const DETECTED_PROVIDER_LABELS: Record<string, string> = {
  'openai-key': 'OpenAI API key marker',
  'anthropic-key': 'Anthropic API key marker',
  'openrouter-key': 'OpenRouter API key marker',
  'groq-key': 'Groq API key marker',
  'deepseek-key': 'DeepSeek API key marker',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  'claude-cli': 'Claude CLI',
};

const DETECTED_TOOL_LABELS: Record<string, string> = {
  claude: 'Claude CLI',
  'claude-cli': 'Claude CLI',
  codex: 'Interpreter CLI command marker',
  aider: 'Aider',
  cursor: 'Cursor',
  ollama: 'Ollama',
  lms: 'LM Studio',
  lmstudio: 'LM Studio',
  'lm-studio': 'LM Studio',
  code: 'VS Code',
  vscode: 'VS Code',
  'vs code': 'VS Code',
};

const DETECTED_CONFIG_LABELS: Record<string, string> = {
  '.claude': 'Claude CLI config marker',
  '.cursor': 'Cursor config marker',
  '.ollama': 'Ollama config marker',
  '.lmstudio': 'LM Studio config marker',
  '.cache/lm-studio': 'LM Studio cache marker',
  '.cache/huggingface': 'Hugging Face model cache marker',
  '.vscode': 'VS Code config marker',
};

const DETECTED_APP_LABELS: Record<string, string> = {
  'LM Studio.app': 'LM Studio app',
  'GPT4All.app': 'GPT4All app',
  'Jan.app': 'Jan app',
};

const DISCOVERED_MCP_SOURCE_LABELS: Record<OnboardingImportedMcpSummaryInput['source'], string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
};

function labeledMatches(values: string[], labels: Record<string, string>): string[] {
  const matches: string[] = [];
  for (const value of values) {
    const label = labels[value];
    if (label && !matches.includes(label)) {
      matches.push(label);
    }
  }
  return matches;
}

function discoveredMcpLabels(discoveredMcps: OnboardingImportedMcpSummaryInput[] | undefined): string[] {
  const labels: string[] = [];
  for (const mcp of discoveredMcps ?? []) {
    const name = normalizeAnswer(mcp.name);
    const transport = normalizeAnswer(mcp.transport);
    if (!name || !transport) continue;

    const source = DISCOVERED_MCP_SOURCE_LABELS[mcp.source];
    const label = `${name} (${source}, ${transport})`;
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
}

export function buildOnboardingImportedToolSummary(
  input: OnboardingImportedToolSummaryInput,
): OnboardingImportedToolSummary {
  const providers = labeledMatches(input.detectedProviders, DETECTED_PROVIDER_LABELS);
  const tools = labeledMatches(input.detectedTools, DETECTED_TOOL_LABELS);
  const configMarkers = labeledMatches(input.detectedConfigDirs, DETECTED_CONFIG_LABELS);
  const apps = labeledMatches(input.detectedApps, DETECTED_APP_LABELS);
  const mcps = discoveredMcpLabels(input.discoveredMcps);

  const sources = [
    providers.length > 0 ? 'detected-providers' : null,
    tools.length > 0 ? 'detected-tools' : null,
    configMarkers.length > 0 ? 'detected-config-markers' : null,
    apps.length > 0 ? 'detected-apps' : null,
    mcps.length > 0 ? 'discovered-mcp-configs' : null,
  ].filter((source): source is string => source !== null);

  const summary = [
    providers.length > 0 ? `Provider markers: ${providers.join(', ')}.` : null,
    tools.length > 0 ? `Detected tools: ${tools.join(', ')}.` : null,
    configMarkers.length > 0 ? `Local config markers: ${configMarkers.join(', ')}.` : null,
    apps.length > 0 ? `Detected apps: ${apps.join(', ')}.` : null,
    mcps.length > 0 ? `Importable MCP servers: ${mcps.join(', ')}.` : null,
  ].filter((line): line is string => line !== null).join(' ');

  return {
    generatedAt: summary ? input.generatedAt : null,
    sources,
    summary,
  };
}

export function mergeOnboardingImportedToolSummary(
  base: OnboardingImportedToolSummary,
  addition: OnboardingImportedToolSummary,
): OnboardingImportedToolSummary {
  if (!addition.summary) {
    return base;
  }

  const sources = Array.from(new Set([...base.sources, ...addition.sources]));
  if (!base.summary) {
    return {
      generatedAt: addition.generatedAt,
      sources,
      summary: addition.summary,
    };
  }

  const summary = base.summary.includes(addition.summary)
    ? base.summary
    : `${base.summary} ${addition.summary}`;

  return {
    generatedAt: summary === base.summary ? base.generatedAt : addition.generatedAt,
    sources,
    summary,
  };
}

function normalizeAnswer(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function splitModelPreferences(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((item) => normalizeAnswer(item))
    .filter(Boolean)
    .map((item) => `Currently uses ${item}`);
}

export function buildOnboardingInterviewDraft(answers: OnboardingInterviewAnswers): string {
  return [
    answers.modelsUsed.trim() ? `Models used now:\n${answers.modelsUsed.trim()}` : null,
    answers.aiUseToday.trim() ? `How I use AI today:\n${answers.aiUseToday.trim()}` : null,
    answers.currentSetup.trim() ? `Current AI setup:\n${answers.currentSetup.trim()}` : null,
  ].filter((line): line is string => line !== null).join('\n\n');
}

export function parseOnboardingInterviewDraft(interviewDraft: string): OnboardingInterviewAnswers {
  let currentField: keyof OnboardingInterviewAnswers | null = null;
  const collectedLines: Record<keyof OnboardingInterviewAnswers, string[]> = {
    modelsUsed: [],
    aiUseToday: [],
    currentSetup: [],
  };

  for (const line of interviewDraft.split('\n')) {
    if (line === 'Models used now:') {
      currentField = 'modelsUsed';
      continue;
    }
    if (line === 'How I use AI today:') {
      currentField = 'aiUseToday';
      continue;
    }
    if (line === 'Current AI setup:') {
      currentField = 'currentSetup';
      continue;
    }
    if (currentField !== null) {
      collectedLines[currentField].push(line);
    }
  }

  return {
    modelsUsed: collectedLines.modelsUsed.join('\n').trim(),
    aiUseToday: collectedLines.aiUseToday.join('\n').trim(),
    currentSetup: collectedLines.currentSetup.join('\n').trim(),
  };
}

export function buildOnboardingInterviewResult(
  answers: OnboardingInterviewAnswers,
  updatedAt: string,
): { interviewDraft: string; interviewResult: OnboardingInterviewResult | null } {
  const interviewDraft = buildOnboardingInterviewDraft(answers);
  if (!interviewDraft) {
    return { interviewDraft: '', interviewResult: null };
  }

  const modelsUsed = normalizeAnswer(answers.modelsUsed);
  const aiUseToday = normalizeAnswer(answers.aiUseToday);
  const currentSetup = normalizeAnswer(answers.currentSetup);
  const summary = [
    modelsUsed ? `Models used now: ${modelsUsed}.` : null,
    aiUseToday ? `AI use today: ${aiUseToday}.` : null,
    currentSetup ? `Current AI setup: ${currentSetup}.` : null,
  ].filter((line): line is string => line !== null).join(' ');

  const modelPreferences = splitModelPreferences(answers.modelsUsed);
  const workingPreferences = [
    aiUseToday ? `AI use today: ${aiUseToday}` : null,
    currentSetup ? `Current AI setup: ${currentSetup}` : null,
  ].filter((line): line is string => line !== null);

  const interviewResult = {
    summary,
    modelPreferences,
    workingPreferences,
    customInstructionsDraft: buildOnboardingCustomInstructionsDraft({
      summary,
      modelPreferences,
      workingPreferences,
    }),
    updatedAt,
  };

  return { interviewDraft, interviewResult };
}
