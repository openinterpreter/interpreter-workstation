import type { LayoutState } from '../../shared/types/layout';
import type { FileThumbnailData } from '../../shared/types/fileThumbnail';
import type { RunnableProjectMetadata } from '../../shared/types/projectRunner';
import type { VaultNoteContext, VaultSearchResult, VaultSnapshot } from '../../shared/types/vault';
import type { WindowFullscreenChangedEvent } from '../../electron/ipc/registry';
import type { Profile, ProfileSetupStatus } from '../../shared/types/profile';
import { profileToModelConfig } from '../../shared/types/profile';
import type { SkillOption, SkillTreeNode } from '../../shared/types/skill';
import type {
  ClaudeCodeLoginResult,
  ClaudeCodeStatus,
  CodexStatus,
  EnvApiKeysResult,
  LmStudioStatus,
  OAuthStatus,
  OllamaStatus,
  OpenRouterModelCatalogResult,
  SupportedOpenAIOAuthModel,
} from '../../shared/types/provider';
import type { v2 } from '../../server/handlers/codex-generated-types/index';
import { DEFAULT_STT_SETTINGS } from '../../shared/types/stt';
import { DEFAULT_TTS_SETTINGS } from '../../shared/types/tts';
import { getRemoteWorkstationLayoutState, isRemoteWorkstationMode } from '../remote/remoteWorkstation';
import {
  isPublicWorkstationPublication,
  isRemoteWorkstationHost,
} from '../remote/workstationConnection';

export interface MarketingDemoFileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  mtime?: number;
  thumbnail?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  fileIcon?: string;
  runnableProject?: RunnableProjectMetadata;
  children?: MarketingDemoFileTreeNode[];
}

export type MarketingDemoSurface =
  | 'onboarding-interpreter-managed-review'
  | 'onboarding-tool-addons'
  | 'onboarding-workspace-choice';

export type MarketingDemoUseCaseId =
  | 'research-synthesis'
  | 'w4-form-filler'
  | 'expense-report-automation'
  | 'nda-redlining';

interface MarketingDemoToolServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'http' | 'sse' | 'websocket';
  url?: string;
  headers?: Record<string, string>;
  name?: string;
  enabled?: boolean;
}

interface MarketingDemoToolServer {
  id: string;
  name: string;
  config?: MarketingDemoToolServerConfig;
  state: {
    status: 'disconnected' | 'connecting' | 'connected' | 'failed';
    error?: string;
    needsAuth?: boolean;
  };
}

interface MarketingDemoDiscoveredMcp {
  id: string;
  name: string;
  source: 'claude-code' | 'cursor';
  transport: 'stdio' | 'http' | 'sse' | 'websocket';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const DEMO_QUERY_PARAM = 'demo';
const DEMO_QUERY_VALUE = 'marketing';
const DEMO_EMBED_PARAM = 'embed';
const DEMO_THEME_PARAM = 'theme';
const DEMO_SURFACE_PARAM = 'surface';
const DEMO_USE_CASE_PARAM = 'useCase';
const DEMO_AUTOPLAY_PROMPT_PARAM = 'autoplayPrompt';
const DEMO_WINDOW_CHROME_PARAM = 'windowChrome';
const MARKETING_DEMO_DEFAULT_USE_CASE_ID: MarketingDemoUseCaseId = 'research-synthesis';
const MARKETING_DEMO_WORKSPACE_ROOTS: Record<MarketingDemoUseCaseId, string> = {
  'research-synthesis': '/generalist-robotics-wiki',
  'w4-form-filler': '/employee-onboarding-packet',
  'expense-report-automation': '/january-expense-close',
  'nda-redlining': '/meridian-nda-review',
};

function isMarketingDemoUseCaseId(value: string | null | undefined): value is MarketingDemoUseCaseId {
  return value === 'research-synthesis'
    || value === 'w4-form-filler'
    || value === 'expense-report-automation'
    || value === 'nda-redlining';
}

function getInitialMarketingDemoUseCaseId(): MarketingDemoUseCaseId {
  if (typeof window === 'undefined') {
    return MARKETING_DEMO_DEFAULT_USE_CASE_ID;
  }

  const params = new URLSearchParams(window.location?.search ?? '');
  const useCase = params.get(DEMO_USE_CASE_PARAM);
  return isMarketingDemoUseCaseId(useCase) ? useCase : MARKETING_DEMO_DEFAULT_USE_CASE_ID;
}

function getMarketingDemoWorkspaceRoot(useCaseId: MarketingDemoUseCaseId): string {
  return MARKETING_DEMO_WORKSPACE_ROOTS[useCaseId];
}

function getMarketingDemoSidebarThreadId(useCaseId: MarketingDemoUseCaseId): string {
  return `marketing-demo-${useCaseId}-sidebar-thread`;
}

const ACTIVE_MARKETING_DEMO_USE_CASE_ID = getInitialMarketingDemoUseCaseId();
const DEMO_WORKSPACE_ROOT = getMarketingDemoWorkspaceRoot(ACTIVE_MARKETING_DEMO_USE_CASE_ID);
const NOOP_UNSUBSCRIBE = () => {};
const MARKETING_DEMO_FULLSCREEN_EVENT: WindowFullscreenChangedEvent = { isFullScreen: true };
const MARKETING_DEMO_WINDOWED_EVENT: WindowFullscreenChangedEvent = { isFullScreen: false };
const MARKETING_DEMO_PRIMARY_COLOR = 'gray';
const MARKETING_DEMO_BACKGROUND_OPACITY = 0;
const MARKETING_DEMO_ZOOM_FACTOR = 1;
const MARKETING_DEMO_LOCALE = 'en';
const MARKETING_DEMO_THUMBNAIL_SIZE = 768;
const MARKETING_DEMO_VAULT_BUILT_AT = 1712700000000;
const MARKETING_DEMO_RESEARCH_PAPER_RELATIVE_PATH = 'raw/papers/pi0-general-robot-control.pdf';
const MARKETING_DEMO_RESEARCH_PAPER_URL = '/papers/pi0-general-robot-control.pdf';
export const MARKETING_DEMO_SIDEBAR_THREAD_ID = getMarketingDemoSidebarThreadId(ACTIVE_MARKETING_DEMO_USE_CASE_ID);
const MARKETING_DEMO_OAUTH_MODELS: SupportedOpenAIOAuthModel[] = [
  { id: 'gpt-5.4', name: 'GPT-5.4', isDefault: true },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', isDefault: false },
];
const MARKETING_DEMO_INTERPRETER_PROVIDERS: v2.InterpreterProvider[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Access many models through one API.',
    isCurrent: true,
    configured: true,
    isDefault: true,
  },
];
const MARKETING_DEMO_OPENROUTER_CATALOG: OpenRouterModelCatalogResult = {
  models: [
    {
      id: 'openai/gpt-5.4',
      name: 'GPT-5.4',
      provider: 'openai',
      description: 'Demo catalog entry.',
    },
    {
      id: 'anthropic/claude-3.5-haiku',
      name: 'Claude 3.5 Haiku',
      provider: 'anthropic',
      description: 'Demo catalog entry.',
    },
  ],
  fetchedAt: 0,
  stale: false,
};
const MARKETING_DEMO_ENV_API_KEYS: EnvApiKeysResult = {
  openai: { found: false },
  anthropic: { found: false },
  openrouter: { found: false },
  groq: { found: false },
  deepseek: { found: false },
};
const MARKETING_DEMO_OLLAMA_STATUS: OllamaStatus = {
  running: false,
  models: [],
  totalChatModels: 0,
};
const MARKETING_DEMO_LM_STUDIO_STATUS: LmStudioStatus = {
  running: false,
  models: [],
  totalChatModels: 0,
  inferenceAvailable: false,
};
const MARKETING_DEMO_CLAUDE_CODE_STATUS: ClaudeCodeStatus = {
  installed: false,
  loggedIn: false,
};
const MARKETING_DEMO_CODEX_STATUS: CodexStatus = {
  installed: false,
  loggedIn: false,
};
const MARKETING_DEMO_EMPTY_VAULT_SNAPSHOT: VaultSnapshot = {
  workspacePath: DEMO_WORKSPACE_ROOT,
  builtAt: MARKETING_DEMO_VAULT_BUILT_AT,
  noteCount: 0,
  tagCount: 0,
  notes: [],
};
const MARKETING_DEMO_EMPTY_VAULT_CONTEXT: VaultNoteContext = {
  workspacePath: DEMO_WORKSPACE_ROOT,
  builtAt: MARKETING_DEMO_VAULT_BUILT_AT,
  noteCount: 0,
  tagCount: 0,
  note: null,
};
const MARKETING_DEMO_EMPTY_VAULT_SEARCH_RESULTS: { results: VaultSearchResult[] } = {
  results: [],
};
const MARKETING_DEMO_DISCOVERED_MCPS: MarketingDemoDiscoveredMcp[] = [
  {
    id: 'github',
    name: 'GitHub',
    source: 'cursor',
    transport: 'http',
    url: 'https://mcp.github.com',
  },
  {
    id: 'notion',
    name: 'Notion',
    source: 'claude-code',
    transport: 'http',
    url: 'https://mcp.notion.com',
  },
  {
    id: 'linear',
    name: 'Linear',
    source: 'cursor',
    transport: 'http',
    url: 'https://mcp.linear.app',
  },
];
const MARKETING_DEMO_DEEP_SCAN_MCPS: MarketingDemoDiscoveredMcp[] = [
  {
    id: 'slack',
    name: 'Slack',
    source: 'claude-code',
    transport: 'http',
    url: 'https://mcp.slack.com',
  },
  {
    id: 'postgres',
    name: 'Postgres',
    source: 'cursor',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
  },
];
const MARKETING_DEMO_DETECTED_NOTE_WORKSPACES = [
  {
    path: '/Users/demo/Research Vault',
    name: 'Research Vault',
    source: 'obsidian',
  },
  {
    path: '/Users/demo/Product Notes',
    name: 'Product Notes',
    source: 'foam',
  },
] as const;

const viteEnv = (import.meta as ImportMeta & {
  env?: Record<string, string | boolean | undefined>;
}).env;

const MARKETING_DEMO_ENV_ENABLED = viteEnv?.VITE_INTERPRETER_MARKETING_DEMO === '1';
const MARKETING_DEMO_EMBED_ENV_ENABLED = viteEnv?.VITE_INTERPRETER_MARKETING_DEMO_EMBED === '1';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function getSearchParams(): URLSearchParams {
  if (!hasWindow()) {
    return new URLSearchParams();
  }
  return new URLSearchParams(window.location?.search ?? '');
}

export function isMarketingDemoMode(): boolean {
  // The marketing bundle also packages the real Workstation shell. A general
  // remote connection must use the live HTTP/SSE bridge, not demo fixtures.
  if (isRemoteWorkstationHost() && !isPublicWorkstationPublication()) {
    return false;
  }

  if (MARKETING_DEMO_ENV_ENABLED) {
    return true;
  }

  if (!hasWindow()) {
    return false;
  }

  const params = getSearchParams();
  return params.get(DEMO_QUERY_PARAM) === DEMO_QUERY_VALUE;
}

export function isMarketingDemoWindowChromeEnabled(): boolean {
  if (!hasWindow()) {
    return false;
  }

  const params = getSearchParams();
  return params.get(DEMO_WINDOW_CHROME_PARAM) === '1';
}

export function isMarketingDemoEmbed(): boolean {
  if (MARKETING_DEMO_EMBED_ENV_ENABLED) {
    return true;
  }

  if (!hasWindow()) {
    return false;
  }

  return getSearchParams().get(DEMO_EMBED_PARAM) === '1';
}

export function getMarketingDemoSurface(): MarketingDemoSurface | null {
  const surface = getSearchParams().get(DEMO_SURFACE_PARAM);

  switch (surface) {
    case 'onboarding-interpreter-managed-review':
    case 'onboarding-tool-addons':
    case 'onboarding-workspace-choice':
      return surface;
    default:
      return null;
  }
}

export function getMarketingDemoUseCaseId(): MarketingDemoUseCaseId {
  const useCase = getSearchParams().get(DEMO_USE_CASE_PARAM);
  return isMarketingDemoUseCaseId(useCase) ? useCase : MARKETING_DEMO_DEFAULT_USE_CASE_ID;
}

export function getMarketingDemoAutoplayPromptId(): string | null {
  return getSearchParams().get(DEMO_AUTOPLAY_PROMPT_PARAM);
}

export function getMarketingDemoDetectedNoteWorkspaces() {
  return MARKETING_DEMO_DETECTED_NOTE_WORKSPACES.map((workspace) => ({ ...workspace }));
}

export function getMarketingDemoWorkspacePath(): string {
  return DEMO_WORKSPACE_ROOT;
}

function getMarketingDemoTheme(): 'light' | 'dark' {
  const themeParam = getSearchParams().get(DEMO_THEME_PARAM);
  if (themeParam === 'dark') {
    return 'dark';
  }
  if (themeParam === 'light') {
    return 'light';
  }
  if (hasWindow() && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function demoPath(relativePath: string): string {
  return `${DEMO_WORKSPACE_ROOT}/${relativePath}`;
}

const marketingDemoProfiles: Profile[] = [
  {
    id: 'demo-smart',
    name: 'Interpreter Smart',
    modelId: 'interpreter-smart',
    provider: 'hosted',
    isBuiltin: false,
    useResponsesApi: true,
    helpDescription: 'Default profile for this workspace.',
  },
];

const marketingDemoProfileStatuses: Record<string, ProfileSetupStatus> = {
  'demo-smart': {
    profileId: 'demo-smart',
    ready: true,
    detail: 'Available in this workspace.',
    badge: 'Ready',
  },
};

const MARKETING_DEMO_SIDEBAR_AGENT_TAB_ID = 'marketing-demo-sidebar-agent';

export interface MarketingDemoTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  parts?: MarketingDemoTranscriptPart[];
}

export type MarketingDemoTranscriptPart =
  | { kind: 'text'; content: string }
  | {
      kind: 'tool-call';
      toolCall: {
        id: string;
        type: string;
        label: string;
        state: 'loading' | 'complete' | 'error';
        details?: string;
        output?: string;
        filePath?: string;
        target?: string;
      };
    };

function getMarketingDemoOAuthStatus(providerType: 'openai' | 'claude'): OAuthStatus {
  if (providerType === 'openai') {
    return {
      isConnected: true,
      email: 'research@interpreter.local',
      accountId: 'generalist-robotics-wiki',
    };
  }

  return { isConnected: false };
}

function getMarketingDemoClaudeLoginResult(): ClaudeCodeLoginResult {
  return {
    success: false,
    error: 'CLI sign-in is unavailable in this browser workspace.',
  };
}

export interface MarketingDemoPromptOption {
  id: string;
  label: string;
  scenarioId: MarketingDemoScenarioId;
  prompt: string;
  composeFrames: string[];
}

export type MarketingDemoScenarioId = string;

export interface MarketingDemoToolCallDescriptor {
  id: string;
  type: 'commandExecution' | 'fileChange' | 'webSearch' | 'reasoning';
  label: string;
  details?: string;
  output?: string;
  filePath?: string;
  target?: string;
}

export interface MarketingDemoScenarioDefinition {
  id: MarketingDemoScenarioId;
  label: string;
  prompt: string;
  aliases?: string[];
  skillNames?: string[];
  introText: string;
  planningLabel: string;
  completionLabel: string;
  replyText: string;
  toolCalls: MarketingDemoToolCallDescriptor[];
}

interface MarketingDemoScenarioMutationResult {
  openedFilePath: string | null;
}

export interface MarketingDemoSeedFile {
  filePath: string;
  content: string;
  assetUrl?: string;
}

const marketingDemoSeededThreads = new Map<string, MarketingDemoTranscriptMessage[]>([
  [
    MARKETING_DEMO_SIDEBAR_THREAD_ID,
    [
      {
        id: 'marketing-demo-msg-1',
        role: 'user',
        text: 'Give me a quick tour of the robotics wiki.',
      },
      {
        id: 'marketing-demo-msg-2',
        role: 'assistant',
        text: `This workspace is a generalist-robotics wiki. You can switch files, open new agent tabs, and message the agent. Start in AGENTS.md for the maintainer rules, raw/ for the paper and company notes, and wiki/index.md for the durable pages that tie the whole topic together.`,
      },
    ],
  ],
]);

const marketingDemoThreads = new Map<string, MarketingDemoTranscriptMessage[]>(
  Array.from(marketingDemoSeededThreads.entries()).map(([threadId, messages]) => [
    threadId,
    messages.map((message) => ({ ...message })),
  ]),
);
let marketingDemoThreadCounter = 0;

type MarketingDemoComposeStep =
  | { kind: 'type'; content: string; stride?: number }
  | { kind: 'insert'; content: string };

const marketingDemoFiles = new Map<string, string>([
  [
    demoPath('AGENTS.md'),
    `# Generalist Robotics Wiki

You are maintaining a durable research workspace on generalist robots, VLA models, and the emerging company landscape around them.

## Directory split

- raw/ contains immutable source material: papers, company notes, interview notes, and quick briefs
- wiki/ contains synthesized markdown pages with cross-links and evolving conclusions
- wiki/log.md records important ingests, rewrites, and new questions

## Ingest rules

1. Read one source at a time.
2. Update existing pages before creating new ones.
3. Preserve links between [[wiki/concepts/vision-language-action-models]], [[wiki/concepts/world-models]], [[wiki/research/pi0]], and the company pages.
4. When a source changes the thesis, revise the thesis pages instead of burying the update in chat.

## Query rules

- Prefer the compiled wiki over raw notes.
- Turn durable answers into new wiki pages or edits to existing ones.
- Keep explicit open questions in [[wiki/questions/open-questions]].
`,
  ],
  [
    demoPath('raw/briefs/generalist-robotics-landscape.md'),
    `# Generalist Robotics Landscape

## Working thesis

The category is converging on a common stack:

- foundation models that map vision and language into action policies
- wider embodiment coverage instead of one-policy-per-robot
- data engines that learn from real-world rollouts, not just teleoperation
- a deployment wedge, usually warehouse, factory, or repetitive indoor work

## Company buckets

- [[raw/companies/physical-intelligence]]: foundation model + multi-embodiment control
- [[raw/companies/skild-ai]]: general robot intelligence / robot brain positioning
- [[raw/companies/figure]]: vertically integrated humanoid deployment story

## Questions

- Who has the strongest data flywheel?
- Who is most likely to win before full home-robot generality exists?
- How much of the moat is model quality vs deployment distribution?
`,
  ],
  [
    demoPath('raw/companies/physical-intelligence.md'),
    `# Physical Intelligence

## Why it matters

- Strong claim around general robot control rather than single-task demos.
- The π0 paper is a useful anchor for how the team frames multi-embodiment control.

## Notes

- Positioning feels research-heavy but product-aware.
- Important link: [[wiki/research/pi0]].
- Related concepts: [[wiki/concepts/vision-language-action-models]], [[wiki/concepts/data-flywheel]].

## Open questions

- How quickly can the model transfer across embodiments?
- What part of the stack is uniquely data-hungry?
`,
  ],
  [
    demoPath('raw/companies/skild-ai.md'),
    `# Skild AI

## Why it matters

- Clear narrative around a general-purpose robot brain.
- Feels closer to a platform bet than a single-robot product bet.

## Notes

- Likely important to compare against [[raw/companies/physical-intelligence]] on embodiment strategy.
- Feels adjacent to [[wiki/concepts/world-models]] and broad policy reuse.
- Worth tracking whether the company wins through model quality, tooling, or partnerships.

## Open questions

- How much robotics data do they need relative to internet-scale pretraining?
- Is the product wedge software, full stack robotics, or enabling infrastructure?
`,
  ],
  [
    demoPath('raw/companies/figure.md'),
    `# Figure

## Why it matters

- Strong humanoid narrative with visible deployment ambition.
- More concrete commercialization story than many pure research players.

## Notes

- Compare against [[wiki/companies/company-map]] for the broader landscape.
- Likely strongest when the discussion turns to operations, deployment, and manufacturing.
- Useful contrast with [[raw/companies/skild-ai]] and [[raw/companies/physical-intelligence]].
`,
  ],
  [
    demoPath('raw/notes/deployment-questions.md'),
    `# Deployment Questions

- What is the minimum viable task set that creates a real customer wedge?
- Which tasks are bottlenecked by dexterity versus robustness?
- Where do failures come from: perception, planning, data sparsity, or embodiment mismatch?
- Does a generalist model actually reduce integration cost, or just move complexity elsewhere?
`,
  ],
  [
    demoPath('raw/papers/rt2-notes.md'),
    `# RT-2 Notes

- Key intuition: transfer web-scale semantic knowledge into robot policies.
- Important bridge paper for the current VLA wave.
- Keep linked from [[wiki/research/rt2]] and [[wiki/concepts/vision-language-action-models]].
`,
  ],
  [
    demoPath(MARKETING_DEMO_RESEARCH_PAPER_RELATIVE_PATH),
    '[Bundled PDF asset: pi0-general-robot-control.pdf]',
  ],
]);

const marketingDemoTree: MarketingDemoFileTreeNode[] = [
  { name: 'AGENTS.md', path: 'AGENTS.md', type: 'file' },
  {
    name: 'raw',
    path: 'raw',
    type: 'directory',
    children: [
      {
        name: 'briefs',
        path: 'raw/briefs',
        type: 'directory',
        children: [
          { name: 'generalist-robotics-landscape.md', path: 'raw/briefs/generalist-robotics-landscape.md', type: 'file' },
        ],
      },
      {
        name: 'companies',
        path: 'raw/companies',
        type: 'directory',
        children: [
          { name: 'figure.md', path: 'raw/companies/figure.md', type: 'file' },
          { name: 'physical-intelligence.md', path: 'raw/companies/physical-intelligence.md', type: 'file' },
          { name: 'skild-ai.md', path: 'raw/companies/skild-ai.md', type: 'file' },
        ],
      },
      {
        name: 'notes',
        path: 'raw/notes',
        type: 'directory',
        children: [
          { name: 'deployment-questions.md', path: 'raw/notes/deployment-questions.md', type: 'file' },
        ],
      },
      {
        name: 'papers',
        path: 'raw/papers',
        type: 'directory',
        children: [
          { name: 'pi0-general-robot-control.pdf', path: MARKETING_DEMO_RESEARCH_PAPER_RELATIVE_PATH, type: 'file' },
          { name: 'rt2-notes.md', path: 'raw/papers/rt2-notes.md', type: 'file' },
        ],
      },
    ],
  },
];

const marketingDemoDirectories = new Set<string>([
  DEMO_WORKSPACE_ROOT,
  demoPath('raw'),
  demoPath('raw/briefs'),
  demoPath('raw/companies'),
  demoPath('raw/notes'),
  demoPath('raw/papers'),
]);

const marketingDemoSeedFilePaths = new Set<string>(marketingDemoFiles.keys());
const marketingDemoFileMtims = new Map<string, number>(
  Array.from(marketingDemoSeedFilePaths).map((filePath, index) => [filePath, 1712700000000 + index]),
);

const marketingDemoWorkspaceChangedListeners = new Set<(event: { workspacePath: string | null }) => void>();
const marketingDemoWorkspaceFilesChangedListeners = new Set<(event: {
  eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change';
  path?: string;
  mtime?: number;
}) => void>();
const marketingDemoFilesRefreshedListeners = new Set<(event: { filePath: string }) => void>();
const marketingDemoToolServersChangedListeners = new Set<(event: { servers: MarketingDemoToolServer[] }) => void>();
const marketingDemoServers = new Map<string, MarketingDemoToolServer>();

function emitMarketingDemoWorkspaceFilesChanged(event: {
  eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change';
  path?: string;
  mtime?: number;
}) {
  marketingDemoWorkspaceFilesChangedListeners.forEach((listener) => listener(event));
}

function emitMarketingDemoFileRefreshed(event: { filePath: string }) {
  marketingDemoFilesRefreshedListeners.forEach((listener) => listener(event));
}

function cloneMarketingDemoToolServers(): MarketingDemoToolServer[] {
  return Array.from(marketingDemoServers.values()).map((server) => structuredClone(server));
}

function emitMarketingDemoToolServersChanged() {
  const servers = cloneMarketingDemoToolServers();
  marketingDemoToolServersChangedListeners.forEach((listener) => listener({ servers }));
}

function toMarketingDemoServerId(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  return normalized || 'tool-server';
}

function subscribeMarketingDemoListener<T>(
  listeners: Set<(event: T) => void>,
  callback: (event: T) => void,
): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function sortMarketingDemoNodes(nodes: MarketingDemoFileTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function getMarketingDemoFileMetadata(relativePath: string): Pick<
  MarketingDemoFileTreeNode,
  'mtime' | 'thumbnail' | 'thumbnailWidth' | 'thumbnailHeight' | 'fileIcon'
> {
  const fullPath = demoPath(relativePath);
  const hasSeedPreview = marketingDemoSeedFilePaths.has(fullPath);
  return {
    mtime: marketingDemoFileMtims.get(fullPath) ?? 1712700000000,
    thumbnail: hasSeedPreview ? getMarketingDemoThumbnailAssetUrl(fullPath) : undefined,
    thumbnailWidth: MARKETING_DEMO_THUMBNAIL_SIZE,
    thumbnailHeight: MARKETING_DEMO_THUMBNAIL_SIZE,
    fileIcon: getMarketingDemoFileIconAssetUrl(fullPath),
  };
}

function cloneMarketingDemoTreeNodes(nodes: MarketingDemoFileTreeNode[]): MarketingDemoFileTreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'directory') {
      return {
        ...node,
        children: node.children ? cloneMarketingDemoTreeNodes(node.children) : undefined,
      };
    }

    return {
      ...node,
      ...getMarketingDemoFileMetadata(node.path),
    };
  });
}

function ensureMarketingDemoDirectory(relativePath: string): MarketingDemoFileTreeNode[] {
  const segments = relativePath.split('/').filter(Boolean);
  let children = marketingDemoTree;
  const traversed: string[] = [];

  for (const segment of segments) {
    traversed.push(segment);
    const currentRelativePath = traversed.join('/');
    let existing = children.find(
      (node) => node.type === 'directory' && node.path === currentRelativePath,
    );

    if (!existing) {
      existing = {
        name: segment,
        path: currentRelativePath,
        type: 'directory',
        children: [],
      };
      children.push(existing);
      sortMarketingDemoNodes(children);
      marketingDemoDirectories.add(demoPath(currentRelativePath));
      emitMarketingDemoWorkspaceFilesChanged({
        eventType: 'addDir',
        path: currentRelativePath,
      });
    }

    existing.children ??= [];
    children = existing.children;
  }

  return children;
}

function ensureMarketingDemoFile(relativePath: string, content: string): string {
  const filePath = demoPath(relativePath);
  const existingContent = marketingDemoFiles.get(filePath);
  const alreadyExists = existingContent !== undefined;
  const mtime = Date.now();
  const directoryRelativePath = relativePath.includes('/')
    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
    : '';
  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const siblings = ensureMarketingDemoDirectory(directoryRelativePath);
  const nodeExists = siblings.some((node) => node.type === 'file' && node.path === relativePath);

  if (!nodeExists) {
    siblings.push({
      name: fileName,
      path: relativePath,
      type: 'file',
      mtime,
    });
    sortMarketingDemoNodes(siblings);
  }

  marketingDemoFiles.set(filePath, content);
  marketingDemoFileMtims.set(filePath, mtime);

  emitMarketingDemoWorkspaceFilesChanged({
    eventType: alreadyExists ? 'change' : 'add',
    path: relativePath,
    mtime,
  });
  emitMarketingDemoFileRefreshed({ filePath });

  return filePath;
}

const MARKETING_DEMO_WIKI_INDEX_RELATIVE_PATH = 'wiki/index.md';
const MARKETING_DEMO_WIKI_SOURCE_RELATIVE_PATH = 'wiki/research/pi0.md';
const MARKETING_DEMO_WIKI_SCHEMA_RELATIVE_PATH = 'wiki/schema/agent-rules.md';
const MARKETING_DEMO_WIKI_OPS_RELATIVE_PATH = 'wiki/ops/ingest-playbook.md';
const MARKETING_DEMO_WIKI_COMPANY_MAP_RELATIVE_PATH = 'wiki/companies/company-map.md';
const MARKETING_DEMO_RAW_SOURCE_RELATIVE_PATH = 'raw/briefs/generalist-robotics-landscape.md';
const MARKETING_DEMO_COMPANY_PI_RELATIVE_PATH = 'raw/companies/physical-intelligence.md';
const MARKETING_DEMO_COMPANY_SKILD_RELATIVE_PATH = 'raw/companies/skild-ai.md';
const MARKETING_DEMO_COMPANY_FIGURE_RELATIVE_PATH = 'raw/companies/figure.md';
const MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH = 'skills';
const MARKETING_DEMO_SOURCE_URL = 'https://arxiv.org/abs/2410.24164';
function buildMarketingDemoComposeFrames(steps: MarketingDemoComposeStep[]): string[] {
  const frames: string[] = [];
  let current = '';

  for (const step of steps) {
    if (step.kind === 'insert') {
      current += step.content;
      frames.push(current);
      continue;
    }

    const stride = Math.max(1, step.stride ?? 2);
    for (let index = stride; index < step.content.length; index += stride) {
      frames.push(current + step.content.slice(0, index));
    }
    current += step.content;
    frames.push(current);
  }

  return frames.filter((frame, index) => frame.length > 0 && frame !== frames[index - 1]);
}

const marketingDemoPromptOptions: MarketingDemoPromptOption[] = [
  {
    id: 'ingest-source-url',
    label: 'Ingest the pi0 paper',
    scenarioId: 'ingest-source-url',
    prompt: `/ingest ${MARKETING_DEMO_SOURCE_URL}`,
    composeFrames: buildMarketingDemoComposeFrames([
      { kind: 'type', content: '/ingest ', stride: 1 },
      { kind: 'type', content: MARKETING_DEMO_SOURCE_URL, stride: 3 },
    ]),
  },
  {
    id: 'draft-ingest-playbook',
    label: 'Map Skild, PI, and Figure',
    scenarioId: 'draft-ingest-playbook',
    prompt: `Compare @[physical-intelligence.md](${demoPath(MARKETING_DEMO_COMPANY_PI_RELATIVE_PATH)}), @[skild-ai.md](${demoPath(MARKETING_DEMO_COMPANY_SKILD_RELATIVE_PATH)}), and @[figure.md](${demoPath(MARKETING_DEMO_COMPANY_FIGURE_RELATIVE_PATH)}). Update @[company-map.md](${demoPath(MARKETING_DEMO_WIKI_COMPANY_MAP_RELATIVE_PATH)}) with the current thesis.`,
    composeFrames: buildMarketingDemoComposeFrames([
      { kind: 'type', content: 'Compare ', stride: 1 },
      {
        kind: 'insert',
        content: `@[physical-intelligence.md](${demoPath(MARKETING_DEMO_COMPANY_PI_RELATIVE_PATH)})`,
      },
      { kind: 'type', content: ' and ', stride: 1 },
      {
        kind: 'insert',
        content: `@[skild-ai.md](${demoPath(MARKETING_DEMO_COMPANY_SKILD_RELATIVE_PATH)})`,
      },
      { kind: 'type', content: ', ', stride: 1 },
      {
        kind: 'insert',
        content: `@[figure.md](${demoPath(MARKETING_DEMO_COMPANY_FIGURE_RELATIVE_PATH)})`,
      },
      { kind: 'type', content: '. Update ', stride: 1 },
      {
        kind: 'insert',
        content: `@[company-map.md](${demoPath(MARKETING_DEMO_WIKI_COMPANY_MAP_RELATIVE_PATH)})`,
      },
      { kind: 'type', content: ' with the current thesis.', stride: 2 },
    ]),
  },
  {
    id: 'compare-wiki-ops',
    label: 'Draft the ingest checklist',
    scenarioId: 'compare-wiki-ops',
    prompt: `Using @[AGENTS.md](${demoPath('AGENTS.md')}) and @[generalist-robotics-landscape.md](${demoPath(MARKETING_DEMO_RAW_SOURCE_RELATIVE_PATH)}), tighten @[ingest-playbook.md](${demoPath(MARKETING_DEMO_WIKI_OPS_RELATIVE_PATH)}) for a robotics research workspace.`,
    composeFrames: buildMarketingDemoComposeFrames([
      { kind: 'type', content: 'Using ', stride: 1 },
      {
        kind: 'insert',
        content: `@[AGENTS.md](${demoPath('AGENTS.md')})`,
      },
      { kind: 'type', content: ' and ', stride: 1 },
      {
        kind: 'insert',
        content: `@[generalist-robotics-landscape.md](${demoPath(MARKETING_DEMO_RAW_SOURCE_RELATIVE_PATH)})`,
      },
      { kind: 'type', content: ', tighten ', stride: 1 },
      {
        kind: 'insert',
        content: `@[ingest-playbook.md](${demoPath(MARKETING_DEMO_WIKI_OPS_RELATIVE_PATH)})`,
      },
      { kind: 'type', content: ' for a robotics research workspace.', stride: 2 },
    ]),
  },
];

function ensureMarketingDemoWikiBase(): {
  indexPath: string;
  sourcePath: string;
  schemaPath: string;
  opsPath: string;
  companyMapPath: string;
} {
  const indexPath = ensureMarketingDemoFile(
    MARKETING_DEMO_WIKI_INDEX_RELATIVE_PATH,
    `# Generalist Robotics Wiki

## Thesis pages

- [[wiki/companies/company-map]] — current market view across Physical Intelligence, Skild AI, and Figure
- [[wiki/research/pi0]] — notes from the π0 paper and what it implies for general robot control
- [[wiki/research/rt2]] — bridge paper for the VLA wave

## Concepts

- [[wiki/concepts/vision-language-action-models]]
- [[wiki/concepts/world-models]]
- [[wiki/concepts/data-flywheel]]

## Companies

- [[wiki/companies/physical-intelligence]]
- [[wiki/companies/skild-ai]]
- [[wiki/companies/figure]]

## Operations

- [[wiki/ops/ingest-playbook]]
- [[wiki/questions/open-questions]]
- [[wiki/log]]
`,
  );

  const sourcePath = ensureMarketingDemoFile(
    MARKETING_DEMO_WIKI_SOURCE_RELATIVE_PATH,
    `# pi0

## Why this paper matters

π0 is useful because it frames robot control as a general-purpose policy problem instead of a narrow robotics benchmark problem.

## Takeaways

- Multi-embodiment control is central to the thesis.
- The paper makes the market feel more like a foundation-model race than a pure hardware race.
- It strengthens the case for [[wiki/concepts/vision-language-action-models]] as the main abstraction.

## Links

- Related company: [[wiki/companies/physical-intelligence]]
- Related concept: [[wiki/concepts/data-flywheel]]
- Compare with: [[wiki/research/rt2]]
`,
  );

  const schemaPath = ensureMarketingDemoFile(
    MARKETING_DEMO_WIKI_SCHEMA_RELATIVE_PATH,
    `# Agent Rules

## Directory split

- raw/ holds immutable source material
- wiki/ holds durable synthesized markdown
- schema/ documents the maintenance rules

## Ingest checklist

1. Capture the source thesis in one sentence.
2. Update [[wiki/index]] and [[wiki/log]].
3. Revise at least one concept page and one company or research page.
4. Add explicit wikilinks to the surrounding pages.

## Query rule

When a question leads to a durable conclusion, file it into the wiki instead of leaving it only in chat.
`,
  );

  const opsPath = ensureMarketingDemoFile(
    MARKETING_DEMO_WIKI_OPS_RELATIVE_PATH,
    `# Ingest Playbook

## Paper ingest

1. Read the abstract, intro, and conclusion.
2. Update [[wiki/research/pi0]] or the relevant research page.
3. Revise [[wiki/concepts/vision-language-action-models]] and [[wiki/concepts/data-flywheel]] if the source changes the argument.
4. Update the relevant company page if the paper materially changes the market map.

## Company ingest

1. Capture the product wedge, the data story, and the embodiment story.
2. Update [[wiki/companies/company-map]].
3. Add new risks or open questions to [[wiki/questions/open-questions]].

## Lint

- find broken or weak wikilinks
- collapse duplicated theses
- surface contradictions across company pages
- keep the market map honest
`,
  );

  const companyMapPath = ensureMarketingDemoFile(
    MARKETING_DEMO_WIKI_COMPANY_MAP_RELATIVE_PATH,
    `# Company Map

## Current read

- [[wiki/companies/physical-intelligence]] feels strongest on foundation-model framing.
- [[wiki/companies/skild-ai]] feels strongest on the general robot brain narrative.
- [[wiki/companies/figure]] feels strongest on deployment visibility and operational ambition.

## What to watch

- whether multi-embodiment transfer becomes real product leverage
- who converts better deployment data into a stronger policy
- who can turn a compelling demo into a repeatable customer wedge
`,
  );

  ensureMarketingDemoFile(
    'wiki/research/rt2.md',
    `# RT-2

RT-2 remains the bridge paper that made web-scale semantics feel relevant to robot control.

## Role in this workspace

- precursor to [[wiki/research/pi0]]
- supporting evidence for [[wiki/concepts/vision-language-action-models]]
`,
  );

  ensureMarketingDemoFile(
    'wiki/concepts/vision-language-action-models.md',
    `# Vision-Language-Action Models

VLAs unify perception, language understanding, and action prediction inside one policy stack.

## Why it matters

- makes robot policies look more like general-purpose models
- creates a path for cross-domain transfer
- ties research papers like [[wiki/research/rt2]] and [[wiki/research/pi0]] into one arc
`,
  );

  ensureMarketingDemoFile(
    'wiki/concepts/world-models.md',
    `# World Models

The key question is whether world models become essential for robust long-horizon robot behavior or whether better action models and better data are enough for early wins.

## Linked pages

- [[wiki/companies/skild-ai]]
- [[wiki/companies/company-map]]
`,
  );

  ensureMarketingDemoFile(
    'wiki/concepts/data-flywheel.md',
    `# Data Flywheel

Generalist robotics probably compounds through deployment data more than through model cleverness alone.

## Linked pages

- [[wiki/research/pi0]]
- [[wiki/companies/physical-intelligence]]
- [[wiki/companies/figure]]
`,
  );

  ensureMarketingDemoFile(
    'wiki/companies/physical-intelligence.md',
    `# Physical Intelligence

- Anchored by [[wiki/research/pi0]]
- Strongest when the conversation is general robot control
- Biggest question: how fast the approach compounds with real deployment data
`,
  );

  ensureMarketingDemoFile(
    'wiki/companies/skild-ai.md',
    `# Skild AI

- Strong narrative around a general-purpose robot brain
- Best read through [[wiki/concepts/world-models]] and [[wiki/companies/company-map]]
- Biggest question: what the actual product wedge becomes
`,
  );

  ensureMarketingDemoFile(
    'wiki/companies/figure.md',
    `# Figure

- Most deployment-forward of the three
- Likely wins if operational execution matters more than pure model elegance
- Compare directly in [[wiki/companies/company-map]]
`,
  );

  ensureMarketingDemoFile(
    'wiki/questions/open-questions.md',
    `# Open Questions

- Is the winning generalist robotics company primarily a model company or a deployment company?
- How much embodiment diversity is enough before transfer becomes compelling?
- Where does the first durable commercial wedge really appear?
`,
  );

  ensureMarketingDemoFile(
    'wiki/log.md',
    `# Log

## [2026-04-10] ingest | pi0

- added [[wiki/research/pi0]]
- refreshed [[wiki/concepts/vision-language-action-models]]
- updated [[wiki/companies/company-map]]
`,
  );

  return { indexPath, sourcePath, schemaPath, opsPath, companyMapPath };
}

function ensureMarketingDemoSkillFiles(): void {
  ensureMarketingDemoFile(
    `${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robot-paper-ingest/SKILL.md`,
    `# Robot Paper Ingest

Use this when you are pulling a new robotics paper into the wiki.

## Focus

- summarize the paper thesis
- update the right research page
- refresh the linked concept pages
`,
  );

  ensureMarketingDemoFile(
    `${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robotics-company-map/SKILL.md`,
    `# Robotics Company Map

Use this when comparing robotics companies and updating the market map.

## Focus

- product wedge
- data advantage
- embodiment strategy
`,
  );

  ensureMarketingDemoFile(
    `${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robotics-ingest-playbook/SKILL.md`,
    `# Robotics Ingest Playbook

Use this when tightening the workflow that turns raw robotics notes into durable wiki pages.

## Output

- the ingest steps
- the target pages to update
- the questions that should remain open
`,
  );
}

const marketingDemoScenarios: Record<MarketingDemoScenarioId, MarketingDemoScenarioDefinition> = {
  'ingest-source-url': {
    id: 'ingest-source-url',
    label: 'Ingest the pi0 paper',
    prompt: `/ingest ${MARKETING_DEMO_SOURCE_URL}`,
    aliases: ['Ingest the pi0 paper into this workspace.'],
    skillNames: ['robot-paper-ingest'],
    introText: 'I’m ingesting the pi0 paper and updating the research and concept pages it touches.',
    planningLabel: 'Planning the ingest',
    completionLabel: 'Writing the updated research notes',
    replyText: 'I pulled the paper into the workspace, updated the pi0 research page, refreshed the linked concept pages, and kept the company map aligned with the new read.',
    toolCalls: [
      {
        id: 'fetch-source',
        type: 'webSearch',
        label: MARKETING_DEMO_SOURCE_URL,
      },
      {
        id: 'extract-structure',
        type: 'commandExecution',
        label: 'Extracting the paper thesis and control claims',
      },
      {
        id: 'write-wiki-pages',
        type: 'fileChange',
        label: 'Updating pi0.md, concept pages, and the company map',
      },
    ],
  },
  'draft-ingest-playbook': {
    id: 'draft-ingest-playbook',
    label: 'Map Skild, PI, and Figure',
    prompt: `Compare @[physical-intelligence.md](${demoPath(MARKETING_DEMO_COMPANY_PI_RELATIVE_PATH)}), @[skild-ai.md](${demoPath(MARKETING_DEMO_COMPANY_SKILD_RELATIVE_PATH)}), and @[figure.md](${demoPath(MARKETING_DEMO_COMPANY_FIGURE_RELATIVE_PATH)}). Update @[company-map.md](${demoPath(MARKETING_DEMO_WIKI_COMPANY_MAP_RELATIVE_PATH)}) with the current thesis.`,
    aliases: ['Update the company map for Physical Intelligence, Skild AI, and Figure.'],
    skillNames: ['robotics-company-map'],
    introText: 'I’m comparing the company notes and tightening the market map.',
    planningLabel: 'Reviewing the company notes',
    completionLabel: 'Updating the market map',
    replyText: 'I compared the three company notes, tightened the market thesis, and opened the company map so you can inspect the current read.',
    toolCalls: [
      {
        id: 'read-company-notes',
        type: 'commandExecution',
        label: 'Reading the company source notes',
      },
      {
        id: 'read-company-map',
        type: 'commandExecution',
        label: 'Reviewing the current company map',
      },
      {
        id: 'write-company-map',
        type: 'fileChange',
        label: 'Updating the company map thesis',
      },
    ],
  },
  'show-generated-pages': {
    id: 'show-generated-pages',
    label: 'Show generated pages',
    prompt: 'Show me the generated wiki pages and open the best page to inspect.',
    introText: 'I’m opening the compiled wiki so you can inspect the durable research layer instead of the raw notes.',
    planningLabel: 'Inspecting generated pages',
    completionLabel: 'Choosing the best entry point',
    replyText: 'The wiki now includes research pages, concept pages, company pages, and an operations layer. I opened the index so you can see the whole structure in one place.',
    toolCalls: [
      {
        id: 'list-pages',
        type: 'commandExecution',
        label: 'Listing generated robotics wiki pages',
      },
    ],
  },
  'compare-wiki-ops': {
    id: 'compare-wiki-ops',
    label: 'Draft the ingest checklist',
    prompt: `Using @[AGENTS.md](${demoPath('AGENTS.md')}) and @[generalist-robotics-landscape.md](${demoPath(MARKETING_DEMO_RAW_SOURCE_RELATIVE_PATH)}), tighten @[ingest-playbook.md](${demoPath(MARKETING_DEMO_WIKI_OPS_RELATIVE_PATH)}) for a robotics research workspace.`,
    aliases: ['Tighten the ingest checklist for this robotics workspace.'],
    skillNames: ['robotics-ingest-playbook'],
    introText: 'I’m turning the workspace rules and raw landscape note into a tighter ingest checklist.',
    planningLabel: 'Reviewing the workspace rules',
    completionLabel: 'Rewriting the ingest checklist',
    replyText: 'I tightened the ingest checklist so paper ingests, company ingests, and lint passes all line up with this robotics workspace.',
    toolCalls: [
      {
        id: 'read-agents',
        type: 'commandExecution',
        label: 'Reading AGENTS.md',
      },
      {
        id: 'read-landscape-note',
        type: 'commandExecution',
        label: 'Reading the landscape brief',
      },
      {
        id: 'write-ops-playbook',
        type: 'fileChange',
        label: 'Rewriting the ingest checklist',
      },
    ],
  },
};

const marketingDemoProjectSkills: SkillOption[] = [
  {
    id: 'demo-skill-robot-paper-ingest',
    name: 'robot-paper-ingest',
    title: 'Robot Paper Ingest',
    description: 'Pull a robotics paper into the durable research wiki.',
    source: 'project',
    scope: 'repo',
    dirPath: demoPath(`${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robot-paper-ingest`),
    filePath: demoPath(`${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robot-paper-ingest/SKILL.md`),
    enabled: true,
  },
  {
    id: 'demo-skill-robotics-company-map',
    name: 'robotics-company-map',
    title: 'Robotics Company Map',
    description: 'Compare companies and keep the market map current.',
    source: 'project',
    scope: 'repo',
    dirPath: demoPath(`${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robotics-company-map`),
    filePath: demoPath(`${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robotics-company-map/SKILL.md`),
    enabled: true,
  },
  {
    id: 'demo-skill-robotics-ingest-playbook',
    name: 'robotics-ingest-playbook',
    title: 'Robotics Ingest Playbook',
    description: 'Tighten the workflow that keeps the robotics wiki current.',
    source: 'project',
    scope: 'repo',
    dirPath: demoPath(`${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robotics-ingest-playbook`),
    filePath: demoPath(`${MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH}/robotics-ingest-playbook/SKILL.md`),
    enabled: true,
  },
];

const marketingDemoProjectSkillTree: SkillTreeNode[] = [
  {
    name: MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH,
    path: demoPath(MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH),
    type: 'directory',
    children: marketingDemoProjectSkills.map((skill) => ({
      name: skill.name,
      path: skill.dirPath,
      type: 'directory',
      children: [
        {
          name: 'SKILL.md',
          path: skill.filePath,
          type: 'file',
        },
      ],
    })),
  },
];

interface MarketingDemoLayoutPresetTab {
  id: string;
  label: string;
  relativePath: string;
}

interface MarketingDemoLayoutPreset {
  tabs: MarketingDemoLayoutPresetTab[];
  activeTabId: string;
}

interface MarketingDemoAssistantReplySet {
  workspace: string;
  action: string;
  default: string;
}

interface MarketingDemoUseCaseOverride {
  seedFiles: MarketingDemoSeedFile[];
  promptOptions: MarketingDemoPromptOption[];
  scenarios: Record<string, MarketingDemoScenarioDefinition>;
  scenarioOpenedRelativePaths: Map<string, string>;
  seededThreads: Map<string, MarketingDemoTranscriptMessage[]>;
  bundledFileUrls: Map<string, string>;
  projectSkills: SkillOption[];
  projectSkillTree: SkillTreeNode[];
  layoutPreset: MarketingDemoLayoutPreset;
  assistantReplies: MarketingDemoAssistantReplySet;
}

interface MarketingDemoUseCaseContext {
  sidebarThreadId: string;
  workspaceRoot: string;
  filePath: (relativePath: string) => string;
  fileMention: (relativePath: string, label?: string) => string;
}

function createMarketingDemoFileMention(workspaceRoot: string, relativePath: string, label?: string): string {
  const fileLabel = label ?? relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return `@[${fileLabel}](${workspaceRoot}/${relativePath})`;
}

function createMarketingDemoUseCaseContext(
  useCaseId: MarketingDemoUseCaseId,
): MarketingDemoUseCaseContext {
  const workspaceRoot = getMarketingDemoWorkspaceRoot(useCaseId);
  return {
    sidebarThreadId: getMarketingDemoSidebarThreadId(useCaseId),
    workspaceRoot,
    filePath: (relativePath) => `${workspaceRoot}/${relativePath}`,
    fileMention: (relativePath, label) => createMarketingDemoFileMention(workspaceRoot, relativePath, label),
  };
}

function buildMarketingDemoTreeFromSeedFiles(seedFiles: MarketingDemoSeedFile[]): MarketingDemoFileTreeNode[] {
  const root: MarketingDemoFileTreeNode[] = [];

  const sortNodes = (nodes: MarketingDemoFileTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  };

  for (const seedFile of seedFiles) {
    const relativePath = seedFile.filePath.slice(`${DEMO_WORKSPACE_ROOT}/`.length);
    const segments = relativePath.split('/').filter(Boolean);
    let currentLevel = root;
    let currentPath = '';

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLast = index === segments.length - 1;

      if (isLast) {
        if (!currentLevel.some((node) => node.type === 'file' && node.path === currentPath)) {
          currentLevel.push({
            name: segment,
            path: currentPath,
            type: 'file',
          });
          sortNodes(currentLevel);
        }
        continue;
      }

      let directory = currentLevel.find(
        (node) => node.type === 'directory' && node.path === currentPath,
      );

      if (!directory) {
        directory = {
          name: segment,
          path: currentPath,
          type: 'directory',
          children: [],
        };
        currentLevel.push(directory);
        sortNodes(currentLevel);
      }

      directory.children ??= [];
      currentLevel = directory.children;
    }
  }

  return root;
}

function buildW4FormFillerUseCaseOverride(): MarketingDemoUseCaseOverride {
  const useCase = createMarketingDemoUseCaseContext('w4-form-filler');
  const offerLetterMention = useCase.fileMention('source/offer-letter.md', 'offer-letter.md');
  const employeeProfileMention = useCase.fileMention('source/employee-profile.md', 'employee-profile.md');
  const w4FormMention = useCase.fileMention('forms/W-4_blank.pdf', 'W-4_blank.pdf');
  const reviewMention = useCase.fileMention('results/w4-review.md', 'w4-review.md');

  const seedFiles: MarketingDemoSeedFile[] = [
    {
      filePath: useCase.filePath('README.md'),
      content: `# Employee Onboarding Packet

This workspace demonstrates how Interpreter turns source notes into a completed onboarding form review.

## Files

- source/offer-letter.md
- source/employee-profile.md
- forms/W-4_blank.pdf
- results/w4-review.md
`,
    },
    {
      filePath: useCase.filePath('source/offer-letter.md'),
      content: `# Offer Letter

- Employee: Maya Chen
- Start date: 07/08/2026
- Base salary: $148,000
- Work state: California
- Filing status discussed with HR: married filing jointly
- Dependents noted during onboarding: 2 qualifying children
- Extra withholding request: $150 each pay period
`,
    },
    {
      filePath: useCase.filePath('source/employee-profile.md'),
      content: `# Employee Profile

- Legal name: Maya Lin Chen
- Address: 842 Waller Street, San Francisco, CA 94117
- SSN (demo): 612-44-9081
- Date of birth: 03/14/1991
- Start date confirmed with recruiting: July 8, 2026
- Notes: Wants a short review sheet for anything payroll should confirm before filing.
`,
    },
    {
      filePath: useCase.filePath('forms/W-4_blank.pdf'),
      content: '[Bundled PDF asset: W-4_blank.pdf]',
      assetUrl: '/use-cases/w4/W-4_blank.pdf',
    },
    {
      filePath: useCase.filePath('results/w4-review.md'),
      content: `# W-4 Review

## Filled from source documents

- Filing status: Married filing jointly
- Qualifying children: 2
- Extra withholding per pay period: $150
- Work state: California
- Start date: 07/08/2026

## Human confirmation

- Confirm the employee wants the extra withholding to remain at $150 each pay period.
- Confirm the SSN before payroll submits the final packet.
`,
    },
  ];

  const promptOptions: MarketingDemoPromptOption[] = [
    {
      id: 'fill-w4-review',
      label: 'Fill the W-4',
      scenarioId: 'fill-w4-review',
      prompt: `Use ${offerLetterMention} and ${employeeProfileMention} to complete ${w4FormMention} and update ${reviewMention} with anything that still needs human confirmation.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Use ', stride: 1 },
        { kind: 'insert', content: offerLetterMention },
        { kind: 'type', content: ' and ', stride: 1 },
        { kind: 'insert', content: employeeProfileMention },
        { kind: 'type', content: ' to complete ', stride: 1 },
        { kind: 'insert', content: w4FormMention },
        { kind: 'type', content: ' and update ', stride: 1 },
        { kind: 'insert', content: reviewMention },
        { kind: 'type', content: ' with anything that still needs human confirmation.', stride: 2 },
      ]),
    },
    {
      id: 'audit-w4-review',
      label: 'Check missing values',
      scenarioId: 'audit-w4-review',
      prompt: `Review ${reviewMention} and flag any W-4 details that still need human confirmation.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Review ', stride: 1 },
        { kind: 'insert', content: reviewMention },
        { kind: 'type', content: ' and flag any W-4 details that still need human confirmation.', stride: 2 },
      ]),
    },
    {
      id: 'show-w4-review',
      label: 'Open the review sheet',
      scenarioId: 'show-w4-review',
      prompt: `Show me the completed review sheet and open ${reviewMention}.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Show me the completed review sheet and open ', stride: 2 },
        { kind: 'insert', content: reviewMention },
        { kind: 'type', content: '.', stride: 1 },
      ]),
    },
  ];

  const scenarios: Record<string, MarketingDemoScenarioDefinition> = {
    'fill-w4-review': {
      id: 'fill-w4-review',
      label: 'Fill the W-4',
      prompt: promptOptions[0].prompt,
      introText: 'I’m reading the source packet, mapping it into the W-4, and drafting a short review sheet for payroll.',
      planningLabel: 'Reviewing the onboarding packet',
      completionLabel: 'Drafting the W-4 review',
      replyText: 'I mapped the offer letter and employee profile into the W-4 workflow and opened the review sheet with the remaining human checks called out.',
      toolCalls: [
        { id: 'read-offer-letter', type: 'commandExecution', label: 'Reading the offer letter and employee profile' },
        { id: 'fill-w4', type: 'fileChange', label: 'Completing the W-4 fields in demo mode' },
        { id: 'write-review', type: 'fileChange', label: 'Updating the W-4 review sheet' },
      ],
    },
    'audit-w4-review': {
      id: 'audit-w4-review',
      label: 'Check missing values',
      prompt: promptOptions[1].prompt,
      introText: 'I’m checking the drafted review sheet for anything payroll should still confirm manually.',
      planningLabel: 'Reviewing the W-4 notes',
      completionLabel: 'Flagging human checks',
      replyText: 'I reviewed the draft and kept the human-confirmation items isolated in the review sheet so payroll can clear them quickly.',
      toolCalls: [
        { id: 'read-review', type: 'commandExecution', label: 'Reading the current W-4 review sheet' },
        { id: 'annotate-review', type: 'fileChange', label: 'Refreshing the human-confirmation checklist' },
      ],
    },
    'show-w4-review': {
      id: 'show-w4-review',
      label: 'Open the review sheet',
      prompt: promptOptions[2].prompt,
      introText: 'I’m opening the review sheet so you can inspect the completed form pass.',
      planningLabel: 'Opening the completed review',
      completionLabel: 'Showing the result',
      replyText: 'I opened the review sheet with the extracted tax details and the short list of follow-up checks.',
      toolCalls: [
        { id: 'open-review', type: 'commandExecution', label: 'Opening the W-4 review sheet' },
      ],
    },
  };

  return {
    seedFiles,
    promptOptions,
    scenarios,
    scenarioOpenedRelativePaths: new Map([
      ['fill-w4-review', 'results/w4-review.md'],
      ['audit-w4-review', 'results/w4-review.md'],
      ['show-w4-review', 'results/w4-review.md'],
    ]),
    seededThreads: new Map([
      [
        useCase.sidebarThreadId,
        [
          {
            id: 'marketing-demo-msg-1',
            role: 'user',
            text: 'Can you fill a W-4 from an offer letter?',
          },
          {
            id: 'marketing-demo-msg-2',
            role: 'assistant',
            text: 'Yes. This workspace includes the source onboarding notes, a blank W-4, and a review sheet that captures anything payroll should confirm before the packet is filed.',
          },
        ],
      ],
    ]),
    bundledFileUrls: new Map([
      [useCase.filePath('forms/W-4_blank.pdf'), '/use-cases/w4/W-4_blank.pdf'],
    ]),
    projectSkills: [],
    projectSkillTree: [],
    layoutPreset: {
      tabs: [
        { id: 'demo-w4-review', label: 'w4-review.md', relativePath: 'results/w4-review.md' },
        { id: 'demo-w4-offer', label: 'offer-letter.md', relativePath: 'source/offer-letter.md' },
        { id: 'demo-w4-profile', label: 'employee-profile.md', relativePath: 'source/employee-profile.md' },
        { id: 'demo-w4-pdf', label: 'W-4_blank.pdf', relativePath: 'forms/W-4_blank.pdf' },
      ],
      activeTabId: 'demo-w4-review',
    },
    assistantReplies: {
      workspace: 'This workspace shows a W-4 workflow: source onboarding notes, a blank tax form, and a review sheet that captures anything payroll should confirm manually.',
      action: 'In this browser demo I can walk the onboarding packet and show the review workflow, but the form execution itself stays scripted and read-only.',
      default: 'I can show how Interpreter maps source onboarding notes into a W-4 workflow and keeps a short human-review checklist alongside the form.',
    },
  };
}

function buildExpenseReportAutomationUseCaseOverride(): MarketingDemoUseCaseOverride {
  const useCase = createMarketingDemoUseCaseContext('expense-report-automation');
  const csvMention = useCase.fileMention('source/corporate_card_jan2026.csv', 'corporate_card_jan2026.csv');
  const receiptsMention = useCase.fileMention('source/receipt-notes.md', 'receipt-notes.md');
  const policyMention = useCase.fileMention('source/expense-policy.md', 'expense-policy.md');
  const reportMention = useCase.fileMention('results/expense-report.md', 'expense-report.md');

  const seedFiles: MarketingDemoSeedFile[] = [
    {
      filePath: useCase.filePath('README.md'),
      content: `# January Expense Close

This workspace demonstrates how Interpreter cleans up a card export, reconciles receipt notes, and drafts a clean expense report.
`,
    },
    {
      filePath: useCase.filePath('source/corporate_card_jan2026.csv'),
      content: `date,vendor,amount
2026-01-04,UBER *TRIP,-38.44
2026-01-06,AIRBNB H7Y3,-642.18
2026-01-06,AIRBNB H7Y3,-642.18
2026-01-11,AMAZON MKTPLACE,-83.20
2026-01-14,ZOOM.US 888-799-9666,-172.50
2026-01-21,STAPLES STORE 1445,-35.97
2026-01-24,OPENAI API,-214.88
`,
    },
    {
      filePath: useCase.filePath('source/receipt-notes.md'),
      content: `# Receipt Notes

- Airbnb booking: NYC product offsite, 3 nights
- Amazon order: HDMI adapter and USB-C hub for the demo booth
- Zoom invoice: annual webinar license renewal
- Staples: printouts and binding for board packet
- Uber: airport to hotel after delayed arrival
`,
    },
    {
      filePath: useCase.filePath('source/expense-policy.md'),
      content: `# Expense Policy

- Travel and lodging should be categorized separately from software.
- Duplicates should be flagged, not deleted silently.
- Office supplies are reimbursable for board and customer materials.
- Personal items should be escalated for manual review.
`,
    },
    {
      filePath: useCase.filePath('results/expense-report.md'),
      content: `# Expense Report

| Date | Vendor | Category | Amount | Notes |
| --- | --- | --- | ---: | --- |
| 2026-01-04 | Uber | Travel | $38.44 | Airport to hotel |
| 2026-01-06 | Airbnb | Lodging | $642.18 | NYC offsite stay |
| 2026-01-11 | Amazon Marketplace | Equipment | $83.20 | Demo booth adapters |
| 2026-01-14 | Zoom | Software | $172.50 | Webinar renewal |
| 2026-01-21 | Staples | Office supplies | $35.97 | Board packet materials |
| 2026-01-24 | OpenAI API | Software | $214.88 | Usage charge |

## Flags

- Duplicate detected: Airbnb charge appears twice on 2026-01-06.
- Missing attachment: OpenAI API charge still needs the invoice attached.
`,
    },
  ];

  const promptOptions: MarketingDemoPromptOption[] = [
    {
      id: 'reconcile-january-expenses',
      label: 'Reconcile January expenses',
      scenarioId: 'reconcile-january-expenses',
      prompt: `Use ${csvMention}, ${receiptsMention}, and ${policyMention} to clean up ${reportMention}. Normalize vendor names, categorize each line, and flag duplicates.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Use ', stride: 1 },
        { kind: 'insert', content: csvMention },
        { kind: 'type', content: ', ', stride: 1 },
        { kind: 'insert', content: receiptsMention },
        { kind: 'type', content: ', and ', stride: 1 },
        { kind: 'insert', content: policyMention },
        { kind: 'type', content: ' to clean up ', stride: 1 },
        { kind: 'insert', content: reportMention },
        { kind: 'type', content: '. Normalize vendor names, categorize each line, and flag duplicates.', stride: 2 },
      ]),
    },
    {
      id: 'flag-expense-issues',
      label: 'Flag duplicates',
      scenarioId: 'flag-expense-issues',
      prompt: `Review ${reportMention} and isolate the duplicate and missing-attachment issues for finance.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Review ', stride: 1 },
        { kind: 'insert', content: reportMention },
        { kind: 'type', content: ' and isolate the duplicate and missing-attachment issues for finance.', stride: 2 },
      ]),
    },
    {
      id: 'open-expense-report',
      label: 'Open the report',
      scenarioId: 'open-expense-report',
      prompt: `Show me the cleaned report and open ${reportMention}.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Show me the cleaned report and open ', stride: 2 },
        { kind: 'insert', content: reportMention },
        { kind: 'type', content: '.', stride: 1 },
      ]),
    },
  ];

  const scenarios: Record<string, MarketingDemoScenarioDefinition> = {
    'reconcile-january-expenses': {
      id: 'reconcile-january-expenses',
      label: 'Reconcile January expenses',
      prompt: promptOptions[0].prompt,
      introText: 'I’m reconciling the card export against the receipt notes and the expense policy.',
      planningLabel: 'Reviewing the expense inputs',
      completionLabel: 'Updating the expense report',
      replyText: 'I cleaned up the vendor names, categorized the report, flagged the duplicate Airbnb line, and opened the finished report for review.',
      toolCalls: [
        { id: 'read-card-export', type: 'commandExecution', label: 'Reading the January card export' },
        { id: 'cross-check-receipts', type: 'commandExecution', label: 'Cross-checking the receipt notes and policy' },
        { id: 'write-report', type: 'fileChange', label: 'Updating the expense report draft' },
      ],
    },
    'flag-expense-issues': {
      id: 'flag-expense-issues',
      label: 'Flag duplicates',
      prompt: promptOptions[1].prompt,
      introText: 'I’m isolating the issues finance needs to clear before close.',
      planningLabel: 'Scanning the report for issues',
      completionLabel: 'Flagging duplicate and missing-attachment items',
      replyText: 'I isolated the duplicate charge and the missing invoice follow-up so finance can clear them without reopening the whole report.',
      toolCalls: [
        { id: 'read-report', type: 'commandExecution', label: 'Reading the current expense report' },
        { id: 'annotate-issues', type: 'fileChange', label: 'Refreshing the finance follow-up notes' },
      ],
    },
    'open-expense-report': {
      id: 'open-expense-report',
      label: 'Open the report',
      prompt: promptOptions[2].prompt,
      introText: 'I’m opening the cleaned expense report.',
      planningLabel: 'Opening the report',
      completionLabel: 'Showing the reconciled report',
      replyText: 'I opened the cleaned report with normalized vendors, categories, and the finance follow-up items visible at the bottom.',
      toolCalls: [
        { id: 'open-report', type: 'commandExecution', label: 'Opening the reconciled expense report' },
      ],
    },
  };

  return {
    seedFiles,
    promptOptions,
    scenarios,
    scenarioOpenedRelativePaths: new Map([
      ['reconcile-january-expenses', 'results/expense-report.md'],
      ['flag-expense-issues', 'results/expense-report.md'],
      ['open-expense-report', 'results/expense-report.md'],
    ]),
    seededThreads: new Map([
      [
        useCase.sidebarThreadId,
        [
          {
            id: 'marketing-demo-msg-1',
            role: 'user',
            text: 'Can this clean up a card statement into an expense report?',
          },
          {
            id: 'marketing-demo-msg-2',
            role: 'assistant',
            text: 'Yes. This workspace includes the raw card export, receipt notes, expense policy, and a cleaned report that calls out duplicates and missing attachments.',
          },
        ],
      ],
    ]),
    bundledFileUrls: new Map(),
    projectSkills: [],
    projectSkillTree: [],
    layoutPreset: {
      tabs: [
        { id: 'demo-expense-report', label: 'expense-report.md', relativePath: 'results/expense-report.md' },
        { id: 'demo-expense-csv', label: 'corporate_card_jan2026.csv', relativePath: 'source/corporate_card_jan2026.csv' },
        { id: 'demo-expense-receipts', label: 'receipt-notes.md', relativePath: 'source/receipt-notes.md' },
        { id: 'demo-expense-policy', label: 'expense-policy.md', relativePath: 'source/expense-policy.md' },
      ],
      activeTabId: 'demo-expense-report',
    },
    assistantReplies: {
      workspace: 'This workspace shows a finance ops flow: a raw card export, supporting receipt notes, a short policy file, and the cleaned expense report.',
      action: 'In this browser demo I can walk the reconciliation flow and show the cleaned report, but the spreadsheet execution itself stays scripted and read-only.',
      default: 'I can show how Interpreter turns a card export plus receipt notes into a categorized expense report with duplicate flags and finance follow-ups.',
    },
  };
}

function buildNdaRedliningUseCaseOverride(): MarketingDemoUseCaseOverride {
  const useCase = createMarketingDemoUseCaseContext('nda-redlining');
  const reviewCallMention = useCase.fileMention('source/nda-review-call.md', 'nda-review-call.md');
  const ndaDraftMention = useCase.fileMention('source/meridian-partners-nda-v1.md', 'meridian-partners-nda-v1.md');
  const kickoffMention = useCase.fileMention('source/kickoff-notes.md', 'kickoff-notes.md');
  const redlinesMention = useCase.fileMention('results/nda-redlines.md', 'nda-redlines.md');
  const summaryMention = useCase.fileMention('results/negotiation-summary.md', 'negotiation-summary.md');

  const seedFiles: MarketingDemoSeedFile[] = [
    {
      filePath: useCase.filePath('README.md'),
      content: `# Meridian NDA Review

This workspace demonstrates how Interpreter turns call notes and a draft contract into a negotiation-ready redline package.
`,
    },
    {
      filePath: useCase.filePath('source/nda-review-call.md'),
      content: `# NDA Review Call

- Make the agreement mutual instead of one-way.
- Fill in Meridian's full address: 2100 Glenwood Avenue, Suite 300, Raleigh, NC 27608.
- Narrow the residuals clause and remove the broad reverse-engineering carve-out.
- Keep the term at 3 years, not 5.
`,
    },
    {
      filePath: useCase.filePath('source/meridian-partners-nda-v1.md'),
      content: `# Meridian Partners NDA v1

## 1. Parties

This Agreement is between Meridian Partners ("Disclosing Party") and ModPrefab Solutions ("Receiving Party").

## 4. Residuals

Receiving Party may use residual knowledge retained by its personnel without restriction.

## 8. Term

This Agreement remains in effect for five (5) years.
`,
    },
    {
      filePath: useCase.filePath('source/kickoff-notes.md'),
      content: `# Kickoff Notes

- Meridian wants a fast turnaround before the pilot SOW discussion.
- ModPrefab is fine with confidentiality but does not want a one-way structure.
- Legal prefers a concise negotiation memo alongside the marked changes.
`,
    },
    {
      filePath: useCase.filePath('results/nda-redlines.md'),
      content: `# NDA Redlines

## Structural edits

- Change the parties section so both sides are disclosing and receiving parties.
- Insert Meridian's full address in the notice block.

## Risk edits

- Narrow the residuals clause so retained know-how does not override confidentiality.
- Remove the reverse-engineering carve-out.
- Reduce the term from five years to three years.
`,
    },
    {
      filePath: useCase.filePath('results/negotiation-summary.md'),
      content: `# Negotiation Summary

## Highest-priority asks

1. Make the NDA mutual.
2. Tighten the residuals language.
3. Shorten the term to three years.

## Talking points

- The current structure reads one-way and does not match the pilot relationship.
- Meridian's address was left as a blank and should be completed before signing.
- The residuals language is broader than ModPrefab normally accepts.
`,
    },
  ];

  const promptOptions: MarketingDemoPromptOption[] = [
    {
      id: 'redline-nda',
      label: 'Redline the NDA',
      scenarioId: 'redline-nda',
      prompt: `Use ${reviewCallMention}, ${kickoffMention}, and ${ndaDraftMention} to refresh ${redlinesMention} and ${summaryMention}.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Use ', stride: 1 },
        { kind: 'insert', content: reviewCallMention },
        { kind: 'type', content: ', ', stride: 1 },
        { kind: 'insert', content: kickoffMention },
        { kind: 'type', content: ', and ', stride: 1 },
        { kind: 'insert', content: ndaDraftMention },
        { kind: 'type', content: ' to refresh ', stride: 1 },
        { kind: 'insert', content: redlinesMention },
        { kind: 'type', content: ' and ', stride: 1 },
        { kind: 'insert', content: summaryMention },
        { kind: 'type', content: '.', stride: 1 },
      ]),
    },
    {
      id: 'summarize-nda-open-issues',
      label: 'Summarize open issues',
      scenarioId: 'summarize-nda-open-issues',
      prompt: `Review ${summaryMention} and isolate the negotiation points Meridian should expect in the next turn.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Review ', stride: 1 },
        { kind: 'insert', content: summaryMention },
        { kind: 'type', content: ' and isolate the negotiation points Meridian should expect in the next turn.', stride: 2 },
      ]),
    },
    {
      id: 'open-nda-summary',
      label: 'Open the negotiation memo',
      scenarioId: 'open-nda-summary',
      prompt: `Show me the negotiation memo and open ${summaryMention}.`,
      composeFrames: buildMarketingDemoComposeFrames([
        { kind: 'type', content: 'Show me the negotiation memo and open ', stride: 2 },
        { kind: 'insert', content: summaryMention },
        { kind: 'type', content: '.', stride: 1 },
      ]),
    },
  ];

  const scenarios: Record<string, MarketingDemoScenarioDefinition> = {
    'redline-nda': {
      id: 'redline-nda',
      label: 'Redline the NDA',
      prompt: promptOptions[0].prompt,
      introText: 'I’m comparing the review call notes against the current NDA draft and refreshing the redline package.',
      planningLabel: 'Reviewing the draft and call notes',
      completionLabel: 'Refreshing the redline package',
      replyText: 'I refreshed the redline summary, isolated the negotiation points, and opened the memo so you can see the asks in one place.',
      toolCalls: [
        { id: 'read-call-notes', type: 'commandExecution', label: 'Reading the call notes and kickoff notes' },
        { id: 'review-draft', type: 'commandExecution', label: 'Reviewing the current NDA draft' },
        { id: 'write-redlines', type: 'fileChange', label: 'Updating the redline summary and negotiation memo' },
      ],
    },
    'summarize-nda-open-issues': {
      id: 'summarize-nda-open-issues',
      label: 'Summarize open issues',
      prompt: promptOptions[1].prompt,
      introText: 'I’m isolating the next-turn negotiation points from the memo.',
      planningLabel: 'Scanning the negotiation memo',
      completionLabel: 'Tightening the open issues list',
      replyText: 'I tightened the memo so the next-turn negotiation points are easy to scan before the next legal pass.',
      toolCalls: [
        { id: 'read-summary', type: 'commandExecution', label: 'Reading the current negotiation memo' },
        { id: 'refresh-summary', type: 'fileChange', label: 'Refreshing the open-issues summary' },
      ],
    },
    'open-nda-summary': {
      id: 'open-nda-summary',
      label: 'Open the negotiation memo',
      prompt: promptOptions[2].prompt,
      introText: 'I’m opening the negotiation memo.',
      planningLabel: 'Opening the memo',
      completionLabel: 'Showing the negotiation summary',
      replyText: 'I opened the negotiation memo with the redline priorities and talking points visible at the top.',
      toolCalls: [
        { id: 'open-memo', type: 'commandExecution', label: 'Opening the negotiation memo' },
      ],
    },
  };

  return {
    seedFiles,
    promptOptions,
    scenarios,
    scenarioOpenedRelativePaths: new Map([
      ['redline-nda', 'results/negotiation-summary.md'],
      ['summarize-nda-open-issues', 'results/negotiation-summary.md'],
      ['open-nda-summary', 'results/negotiation-summary.md'],
    ]),
    seededThreads: new Map([
      [
        useCase.sidebarThreadId,
        [
          {
            id: 'marketing-demo-msg-1',
            role: 'user',
            text: 'Can this prep NDA redlines from call notes?',
          },
          {
            id: 'marketing-demo-msg-2',
            role: 'assistant',
            text: 'Yes. This workspace includes the draft NDA, the review call notes, and the redline package that turns those notes into negotiation-ready edits.',
          },
        ],
      ],
    ]),
    bundledFileUrls: new Map(),
    projectSkills: [],
    projectSkillTree: [],
    layoutPreset: {
      tabs: [
        { id: 'demo-nda-summary', label: 'negotiation-summary.md', relativePath: 'results/negotiation-summary.md' },
        { id: 'demo-nda-redlines', label: 'nda-redlines.md', relativePath: 'results/nda-redlines.md' },
        { id: 'demo-nda-draft', label: 'meridian-partners-nda-v1.md', relativePath: 'source/meridian-partners-nda-v1.md' },
        { id: 'demo-nda-call', label: 'nda-review-call.md', relativePath: 'source/nda-review-call.md' },
      ],
      activeTabId: 'demo-nda-summary',
    },
    assistantReplies: {
      workspace: 'This workspace shows a legal review flow: the call notes, the current NDA draft, and the memo that turns those notes into a concise redline package.',
      action: 'In this browser demo I can show the review workflow and the memo output, but the underlying document editing stays scripted and read-only.',
      default: 'I can show how Interpreter turns review-call notes plus the current NDA draft into a redline summary and negotiation memo.',
    },
  };
}

function getMarketingDemoUseCaseOverride(useCaseId: MarketingDemoUseCaseId): MarketingDemoUseCaseOverride | null {
  switch (useCaseId) {
    case 'w4-form-filler':
      return buildW4FormFillerUseCaseOverride();
    case 'expense-report-automation':
      return buildExpenseReportAutomationUseCaseOverride();
    case 'nda-redlining':
      return buildNdaRedliningUseCaseOverride();
    default:
      return null;
  }
}

const marketingDemoBundledFileUrls = new Map<string, string>([
  [demoPath(MARKETING_DEMO_RESEARCH_PAPER_RELATIVE_PATH), MARKETING_DEMO_RESEARCH_PAPER_URL],
]);

let marketingDemoLayoutPreset: MarketingDemoLayoutPreset = {
  tabs: [
    { id: 'demo-index', label: 'index.md', relativePath: MARKETING_DEMO_WIKI_INDEX_RELATIVE_PATH },
    { id: 'demo-map', label: 'company-map.md', relativePath: MARKETING_DEMO_WIKI_COMPANY_MAP_RELATIVE_PATH },
    { id: 'demo-paper', label: 'pi0-general-robot-control.pdf', relativePath: MARKETING_DEMO_RESEARCH_PAPER_RELATIVE_PATH },
    { id: 'demo-source', label: 'generalist-robotics-landscape.md', relativePath: MARKETING_DEMO_RAW_SOURCE_RELATIVE_PATH },
    { id: 'demo-ops', label: 'ingest-playbook.md', relativePath: MARKETING_DEMO_WIKI_OPS_RELATIVE_PATH },
    { id: 'demo-agents', label: 'AGENTS.md', relativePath: 'AGENTS.md' },
  ],
  activeTabId: 'demo-index',
};

let marketingDemoAssistantReplies: MarketingDemoAssistantReplySet = {
  workspace: 'This workspace is a generalist-robotics wiki: AGENTS.md defines the maintainer rules, raw/ holds papers and company notes, wiki/index.md tracks the durable pages, and wiki/companies/company-map.md captures the current thesis.',
  action: 'This browser workspace is intentionally read-only. You can explore the UI, switch tabs, and send messages, but edits, command execution, approvals, and real workspace mutations are disabled.',
  default: 'I can walk the robotics wiki, open the raw paper and company notes, and show how ingest updates the durable markdown layer. Tool execution and filesystem writes stay disabled in this browser workspace.',
};

const marketingDemoScenarioOpenedRelativePaths = new Map<string, string>([
  ['ingest-source-url', MARKETING_DEMO_WIKI_SOURCE_RELATIVE_PATH],
  ['draft-ingest-playbook', MARKETING_DEMO_WIKI_COMPANY_MAP_RELATIVE_PATH],
  ['show-generated-pages', MARKETING_DEMO_WIKI_INDEX_RELATIVE_PATH],
  ['compare-wiki-ops', MARKETING_DEMO_WIKI_OPS_RELATIVE_PATH],
]);

function applyMarketingDemoUseCaseOverride(override: MarketingDemoUseCaseOverride): void {
  marketingDemoFiles.clear();
  marketingDemoSeedFilePaths.clear();
  marketingDemoFileMtims.clear();
  marketingDemoDirectories.clear();
  marketingDemoDirectories.add(DEMO_WORKSPACE_ROOT);

  override.seedFiles.forEach((seedFile, index) => {
    marketingDemoFiles.set(seedFile.filePath, seedFile.content);
    marketingDemoSeedFilePaths.add(seedFile.filePath);
    marketingDemoFileMtims.set(seedFile.filePath, MARKETING_DEMO_VAULT_BUILT_AT + index);

    const relativePath = seedFile.filePath.slice(`${DEMO_WORKSPACE_ROOT}/`.length);
    const segments = relativePath.split('/').filter(Boolean);
    let currentPath = '';
    for (let segmentIndex = 0; segmentIndex < segments.length - 1; segmentIndex += 1) {
      currentPath = currentPath ? `${currentPath}/${segments[segmentIndex]}` : segments[segmentIndex];
      marketingDemoDirectories.add(demoPath(currentPath));
    }
  });

  marketingDemoTree.splice(
    0,
    marketingDemoTree.length,
    ...buildMarketingDemoTreeFromSeedFiles(override.seedFiles),
  );

  marketingDemoBundledFileUrls.clear();
  override.bundledFileUrls.forEach((assetUrl, filePath) => {
    marketingDemoBundledFileUrls.set(filePath, assetUrl);
  });

  marketingDemoPromptOptions.splice(0, marketingDemoPromptOptions.length, ...override.promptOptions);

  Object.keys(marketingDemoScenarios).forEach((scenarioId) => {
    delete marketingDemoScenarios[scenarioId];
  });
  Object.assign(marketingDemoScenarios, override.scenarios);

  marketingDemoProjectSkills.splice(0, marketingDemoProjectSkills.length, ...override.projectSkills);
  marketingDemoProjectSkillTree.splice(0, marketingDemoProjectSkillTree.length, ...override.projectSkillTree);

  marketingDemoScenarioOpenedRelativePaths.clear();
  override.scenarioOpenedRelativePaths.forEach((relativePath, scenarioId) => {
    marketingDemoScenarioOpenedRelativePaths.set(scenarioId, relativePath);
  });

  marketingDemoSeededThreads.clear();
  override.seededThreads.forEach((messages, threadId) => {
    marketingDemoSeededThreads.set(threadId, structuredClone(messages));
  });

  marketingDemoThreads.clear();
  marketingDemoSeededThreads.forEach((messages, threadId) => {
    marketingDemoThreads.set(
      threadId,
      messages.map((message) => ({ ...message })),
    );
  });

  marketingDemoLayoutPreset = structuredClone(override.layoutPreset);
  marketingDemoAssistantReplies = structuredClone(override.assistantReplies);
}

function findNodeChildren(
  nodes: MarketingDemoFileTreeNode[],
  relativePath: string,
): MarketingDemoFileTreeNode[] | null {
  if (!relativePath) {
    return nodes;
  }

  for (const node of nodes) {
    if (node.path === relativePath && node.type === 'directory') {
      return node.children ?? [];
    }
    if (node.children) {
      const nested = findNodeChildren(node.children, relativePath);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

export function getMarketingDemoWorkspace(): { workspace: string } {
  return { workspace: DEMO_WORKSPACE_ROOT };
}

export function getMarketingDemoPromptOptions(): MarketingDemoPromptOption[] {
  return marketingDemoPromptOptions.map((option) => ({
    ...option,
    composeFrames: [...option.composeFrames],
  }));
}

export function getMarketingDemoScenario(
  prompt: string,
  skillNames: string[] = [],
): MarketingDemoScenarioDefinition | null {
  const normalizedPrompt = prompt.trim();
  if (skillNames.length > 0) {
    const matchBySkill = Object.values(marketingDemoScenarios).find((scenario) =>
      scenario.skillNames?.some((skillName) => skillNames.includes(skillName)),
    );
    if (matchBySkill) {
      return matchBySkill;
    }
  }

  return Object.values(marketingDemoScenarios).find((scenario) =>
    scenario.prompt === normalizedPrompt
    || scenario.aliases?.includes(normalizedPrompt),
  ) ?? null;
}

export function applyMarketingDemoScenario(
  scenarioId: MarketingDemoScenarioId,
): MarketingDemoScenarioMutationResult {
  const relativePath = marketingDemoScenarioOpenedRelativePaths.get(scenarioId);
  return {
    openedFilePath: relativePath ? demoPath(relativePath) : null,
  };
}

function cloneMarketingDemoTranscript(messages: MarketingDemoTranscriptMessage[]): MarketingDemoTranscriptMessage[] {
  return structuredClone(messages);
}

export function getMarketingDemoTranscript(threadId: string | null | undefined): MarketingDemoTranscriptMessage[] {
  if (!threadId) {
    return [];
  }

  const existing = marketingDemoThreads.get(threadId);
  if (existing) {
    return cloneMarketingDemoTranscript(existing);
  }

  const seeded = marketingDemoSeededThreads.get(threadId);
  if (!seeded) {
    return [];
  }

  const cloned = cloneMarketingDemoTranscript(seeded);
  marketingDemoThreads.set(threadId, cloned);
  return cloneMarketingDemoTranscript(cloned);
}

export function createMarketingDemoThread(seedMessages?: MarketingDemoTranscriptMessage[]): string {
  marketingDemoThreadCounter += 1;
  const threadId = `marketing-demo-thread-${marketingDemoThreadCounter}`;
  marketingDemoThreads.set(threadId, cloneMarketingDemoTranscript(seedMessages ?? []));
  return threadId;
}

export function saveMarketingDemoTranscript(
  threadId: string,
  messages: MarketingDemoTranscriptMessage[],
): void {
  marketingDemoThreads.set(threadId, cloneMarketingDemoTranscript(messages));
}

export function buildMarketingDemoAssistantReply(params: {
  message: string;
  workspacePath?: string | null;
  attachmentCount?: number;
}): string {
  const normalized = params.message.trim().toLowerCase();
  const attachmentText = params.attachmentCount && params.attachmentCount > 0
    ? ` I can still acknowledge ${params.attachmentCount} attached image${params.attachmentCount === 1 ? '' : 's'}, but this browser workspace will not run a real analysis pipeline.`
    : '';
  const workspaceText = params.workspacePath
    ? ` The workspace is pinned to ${params.workspacePath}.`
    : '';

  if (
    normalized.includes('file')
    || normalized.includes('workspace')
    || normalized.includes('readme')
    || normalized.includes('agents')
    || normalized.includes('index')
    || normalized.includes('wiki')
    || normalized.includes('robot')
    || normalized.includes('paper')
    || normalized.includes('company')
  ) {
    return `${marketingDemoAssistantReplies.workspace}${workspaceText}`;
  }

  if (normalized.includes('agent') || normalized.includes('tab') || normalized.includes('sidebar')) {
    return `The multi-agent shell works normally here, so new agent tabs and the pinned right sidebar behave like the desktop app. In this browser workspace, tool execution and filesystem writes stay disabled.${workspaceText}`;
  }

  if (
    normalized.includes('edit')
    || normalized.includes('write')
    || normalized.includes('save')
    || normalized.includes('delete')
    || normalized.includes('run')
  ) {
    return `${marketingDemoAssistantReplies.action}${workspaceText}${attachmentText}`;
  }

  return `${marketingDemoAssistantReplies.default}${workspaceText}${attachmentText}`;
}

export function getMarketingDemoWorkspaceFiles(): { files: MarketingDemoFileTreeNode[] } {
  return { files: cloneMarketingDemoTreeNodes(marketingDemoTree) };
}

export function getMarketingDemoFolderChildren(folderPath: string): { children: MarketingDemoFileTreeNode[] } {
  const normalizedPath = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const children = findNodeChildren(marketingDemoTree, normalizedPath);
  if (!children) {
    throw new Error(`Demo folder not found: ${folderPath}`);
  }
  return { children: cloneMarketingDemoTreeNodes(children) };
}

export function getMarketingDemoProfilesResponse(): {
  profiles: Profile[];
  defaultProfileId: string | null;
  fastProfileId: string | null;
} {
  return {
    profiles: structuredClone(marketingDemoProfiles),
    defaultProfileId: marketingDemoProfiles[0]?.id ?? null,
    fastProfileId: marketingDemoProfiles[0]?.id ?? null,
  };
}

export function getMarketingDemoUserName(): { userName: string } {
  return { userName: 'Interpreter Team' };
}

export function readMarketingDemoFile(filePath: string): { content: string } {
  const content = marketingDemoFiles.get(filePath);
  if (content === undefined) {
    throw new Error(`Demo file not found: ${filePath}`);
  }
  return { content };
}

export function getMarketingDemoFileUrl(filePath: string): string | null {
  return marketingDemoBundledFileUrls.get(filePath) ?? null;
}

function getMarketingDemoPathParts(filePath: string): { workspaceName: string; relativePath: string } {
  const normalized = filePath.replace(/^\/+/, '');
  const slashIndex = normalized.indexOf('/');

  if (slashIndex <= 0) {
    return {
      workspaceName: 'demo-workspace',
      relativePath: normalized,
    };
  }

  return {
    workspaceName: normalized.slice(0, slashIndex),
    relativePath: normalized.slice(slashIndex + 1),
  };
}

function getMarketingDemoThumbnailAssetName(filePath: string): string {
  const { workspaceName, relativePath } = getMarketingDemoPathParts(filePath);
  const assetPath = relativePath ? `${workspaceName}/${relativePath}` : workspaceName;
  return assetPath.split('/').join('__');
}

export function getMarketingDemoThumbnailAssetUrl(filePath: string): string {
  return `/thumbnails/${encodeURIComponent(getMarketingDemoThumbnailAssetName(filePath))}.png`;
}

function getMarketingDemoFileIconAssetName(filePath: string): string {
  if (filePath.toLowerCase().endsWith('.pdf')) {
    return 'pdf';
  }
  if (filePath.toLowerCase().endsWith('.md')) {
    return 'md';
  }
  return 'generic';
}

export function getMarketingDemoFileIconAssetUrl(filePath: string): string {
  return `/file-icons/${encodeURIComponent(getMarketingDemoFileIconAssetName(filePath))}.png`;
}

export function getMarketingDemoSeedFiles(): MarketingDemoSeedFile[] {
  return Array.from(marketingDemoFiles.entries()).map(([filePath, content]) => ({
    filePath,
    content,
    assetUrl: marketingDemoBundledFileUrls.get(filePath),
  }));
}

export function getAllMarketingDemoSeedFiles(): MarketingDemoSeedFile[] {
  const allSeedFiles = new Map<string, MarketingDemoSeedFile>();

  for (const seedFile of getMarketingDemoSeedFiles()) {
    allSeedFiles.set(seedFile.filePath, seedFile);
  }

  (
    ['w4-form-filler', 'expense-report-automation', 'nda-redlining'] as const
  ).forEach((useCaseId) => {
    const override = getMarketingDemoUseCaseOverride(useCaseId);
    if (!override) {
      return;
    }

    override.seedFiles.forEach((seedFile) => {
      allSeedFiles.set(seedFile.filePath, seedFile);
    });
  });

  return Array.from(allSeedFiles.values());
}

export function getMarketingDemoThumbnails(
  filePaths: string[],
  size: number = 256,
): { thumbnails: Record<string, FileThumbnailData> } {
  const thumbnails: Record<string, FileThumbnailData> = {};

  for (const filePath of filePaths) {
    if (isMarketingDemoDirectory(filePath)) {
      continue;
    }
    if (!marketingDemoSeedFilePaths.has(filePath)) {
      continue;
    }
    thumbnails[filePath] = {
      kind: 'preview',
      dataUrl: getMarketingDemoThumbnailAssetUrl(filePath),
      width: Math.min(Math.max(size, 64), MARKETING_DEMO_THUMBNAIL_SIZE),
      height: Math.min(Math.max(size, 64), MARKETING_DEMO_THUMBNAIL_SIZE),
    };
  }

  return { thumbnails };
}

export function writeMarketingDemoFile(filePath: string, content: string): { success: boolean } {
  if (!marketingDemoFiles.has(filePath)) {
    throw new Error(`Demo file not found: ${filePath}`);
  }
  const mtime = Date.now();
  marketingDemoFiles.set(filePath, content);
  marketingDemoFileMtims.set(filePath, mtime);
  const relativePath = filePath.startsWith(`${DEMO_WORKSPACE_ROOT}/`)
    ? filePath.slice(`${DEMO_WORKSPACE_ROOT}/`.length)
    : filePath;
  emitMarketingDemoWorkspaceFilesChanged({
    eventType: 'change',
    path: relativePath,
    mtime,
  });
  emitMarketingDemoFileRefreshed({ filePath });
  return { success: true };
}

export function isMarketingDemoDirectory(filePath: string): boolean {
  return marketingDemoDirectories.has(filePath);
}

export function getMarketingDemoFileStats(filePath: string): {
  size: number | null;
  lineCount: number | null;
  itemCount: number | null;
  isDirectory: boolean;
} {
  if (isMarketingDemoDirectory(filePath)) {
    const relativePath = filePath === DEMO_WORKSPACE_ROOT
      ? ''
      : filePath.slice(`${DEMO_WORKSPACE_ROOT}/`.length);
    const children = findNodeChildren(marketingDemoTree, relativePath) ?? [];
    return {
      size: null,
      lineCount: null,
      itemCount: children.length,
      isDirectory: true,
    };
  }

  const content = marketingDemoFiles.get(filePath);
  if (content === undefined) {
    return {
      size: null,
      lineCount: null,
      itemCount: null,
      isDirectory: false,
    };
  }

  return {
    size: content.length,
    lineCount: content.split('\n').length,
    itemCount: null,
    isDirectory: false,
  };
}

export function getMarketingDemoLayoutState(): LayoutState {
  const sidebarAgentModelConfig = profileToModelConfig(marketingDemoProfiles[0]);
  if (isRemoteWorkstationMode()) {
    return getRemoteWorkstationLayoutState(sidebarAgentModelConfig);
  }
  const tabIds = marketingDemoLayoutPreset.tabs.map((tab) => tab.id);
  const tabs = marketingDemoLayoutPreset.tabs.reduce<LayoutState['tabs']>((accumulator, tab) => {
    const absolutePath = demoPath(tab.relativePath);
    accumulator[tab.id] = {
      id: tab.id,
      type: 'file',
      label: tab.label,
      path: absolutePath,
      thumbnail: getMarketingDemoThumbnailAssetUrl(absolutePath),
    };
    return accumulator;
  }, {});

  return {
    version: 6,
    tree: {
      kind: 'pane',
      id: 'marketing-demo-pane',
      tabIds,
      activeTabId: marketingDemoLayoutPreset.activeTabId,
    },
    tabs: {
      ...tabs,
      [MARKETING_DEMO_SIDEBAR_AGENT_TAB_ID]: {
        id: MARKETING_DEMO_SIDEBAR_AGENT_TAB_ID,
        type: 'agent',
        label: 'Agent',
        createdAt: MARKETING_DEMO_VAULT_BUILT_AT,
        agent: {
          runtime: {
            modelConfig: sidebarAgentModelConfig,
            workspacePath: DEMO_WORKSPACE_ROOT,
          },
          session: {
            conversationId: MARKETING_DEMO_SIDEBAR_THREAD_ID,
            codexThreadId: MARKETING_DEMO_SIDEBAR_THREAD_ID,
            callerToken: 'agtok_marketing_demo_sidebar',
          },
        },
      },
    },
    activePaneId: 'marketing-demo-pane',
    activeTabRegion: 'main',
    sidebarPane: {
      kind: 'pane',
      id: 'sidebar',
      tabIds: [MARKETING_DEMO_SIDEBAR_AGENT_TAB_ID],
      activeTabId: MARKETING_DEMO_SIDEBAR_AGENT_TAB_ID,
    },
    sidebarWidth: 360,
    sidebarOpen: true,
    leftSidebar: {
      isOpen: true,
      width: 360,
      activeTab: 'explorer',
    },
    rightSidebar: {
      isOpen: true,
      width: 360,
    },
  };
}

ensureMarketingDemoWikiBase();
ensureMarketingDemoSkillFiles();

const marketingDemoUseCaseOverride = getMarketingDemoUseCaseOverride(ACTIVE_MARKETING_DEMO_USE_CASE_ID);
if (marketingDemoUseCaseOverride) {
  applyMarketingDemoUseCaseOverride(marketingDemoUseCaseOverride);
}

export const marketingDemoWorkspaceIpc = {
  get: async () => getMarketingDemoWorkspace(),
  createSample: async () => ({ success: true, workspacePath: DEMO_WORKSPACE_ROOT }),
  set: async () => ({ success: false }),
  addWatch: async () => ({ success: true }),
  removeWatch: async () => ({ success: true }),
  onChanged: (callback: (event: { workspacePath: string | null }) => void) => {
    queueMicrotask(() => callback({ workspacePath: DEMO_WORKSPACE_ROOT }));
    return subscribeMarketingDemoListener(marketingDemoWorkspaceChangedListeners, callback);
  },
  onFilesChanged: (callback: (event: unknown) => void) =>
    subscribeMarketingDemoListener(
      marketingDemoWorkspaceFilesChangedListeners,
      callback as (event: { eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change'; path?: string; mtime?: number }) => void,
    ),
};

export const marketingDemoFilesIpc = {
  isDirectory: async (filePath: string) => ({ isDirectory: isMarketingDemoDirectory(filePath) }),
  getStats: async (filePath: string) => getMarketingDemoFileStats(filePath),
  read: async (filePath: string) => readMarketingDemoFile(filePath),
  write: async (filePath: string, content: string) => writeMarketingDemoFile(filePath, content),
  getThumbnails: async (filePaths: string[], size?: number) => getMarketingDemoThumbnails(filePaths, size),
  listDirectory: async (filePath: string) => {
    if (!isMarketingDemoDirectory(filePath)) {
      return { success: false, error: `Demo folder not found: ${filePath}` };
    }

    const relativePath = filePath === DEMO_WORKSPACE_ROOT
      ? ''
      : filePath.slice(`${DEMO_WORKSPACE_ROOT}/`.length);
    return {
      success: true,
      entries: structuredClone(findNodeChildren(marketingDemoTree, relativePath) ?? []),
    };
  },
  create: async () => ({ success: false, error: 'Demo mode is read-only' }),
  createFolder: async () => ({ success: false, error: 'Demo mode is read-only' }),
  rename: async () => ({ success: false, error: 'Demo mode is read-only' }),
  move: async () => ({ success: false, error: 'Demo mode is read-only' }),
  delete: async () => ({ success: false, error: 'Demo mode is read-only' }),
  copyExternal: async () => ({ success: false, error: 'Demo mode is read-only' }),
  createBookmark: async () => ({ success: false, error: 'Demo mode is read-only' }),
  onRefreshed: (callback: (event: unknown) => void) =>
    subscribeMarketingDemoListener(
      marketingDemoFilesRefreshedListeners,
      callback as (event: { filePath: string }) => void,
    ),
};

export const marketingDemoVaultIpc = {
  getSnapshot: async () => structuredClone(MARKETING_DEMO_EMPTY_VAULT_SNAPSHOT),
  getNoteContext: async () => structuredClone(MARKETING_DEMO_EMPTY_VAULT_CONTEXT),
  getTags: async () => ({ tags: [] }),
  searchNotes: async () => structuredClone(MARKETING_DEMO_EMPTY_VAULT_SEARCH_RESULTS),
};

export const marketingDemoPdfIpc = {
  readStructure: async () => null,
  updateFormData: async () => ({ success: true }),
  onFillField: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoProfilesIpc = {
  list: async () => getMarketingDemoProfilesResponse(),
  get: async (profileId: string) => {
    const profile = marketingDemoProfiles.find((entry) => entry.id === profileId);
    if (!profile) {
      throw new Error(`Demo profile not found: ${profileId}`);
    }
    return structuredClone(profile);
  },
  create: async () => ({ success: false }),
  update: async () => ({ success: false }),
  delete: async () => ({ success: false }),
  setDefault: async () => ({
    success: true,
    defaultProfileId: marketingDemoProfiles[0]?.id ?? null,
    fastProfileId: marketingDemoProfiles[0]?.id ?? null,
  }),
  setFast: async () => ({
    success: true,
    defaultProfileId: marketingDemoProfiles[0]?.id ?? null,
    fastProfileId: marketingDemoProfiles[0]?.id ?? null,
  }),
  reset: async () => ({ success: false }),
  onChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  onDefaultChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  onConfigRecovered: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoUserNameIpc = {
  get: async () => getMarketingDemoUserName(),
  set: async (name: string) => ({ success: true, userName: name }),
  clear: async () => ({ success: true }),
};

export const marketingDemoWindowIpc = {
  create: async () => ({ success: false, error: 'Window creation is unavailable in this browser workspace.' }),
  detachTab: async () => ({ success: false, error: 'Detached windows are unavailable in this browser workspace.' }),
  transferTabOut: async () => ({ success: false, error: 'Detached windows are unavailable in this browser workspace.' }),
  onFullscreenChanged: (callback: (event: WindowFullscreenChangedEvent) => void) => {
    queueMicrotask(() => callback(
      isMarketingDemoWindowChromeEnabled()
        ? MARKETING_DEMO_WINDOWED_EVENT
        : MARKETING_DEMO_FULLSCREEN_EVENT,
    ));
    return NOOP_UNSUBSCRIBE;
  },
};

export const marketingDemoLocaleIpc = {
  get: async () => ({ language: MARKETING_DEMO_LOCALE }),
  set: async (language: string) => ({ success: true, language }),
  onChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoBackgroundOpacityIpc = {
  get: async () => ({ opacity: MARKETING_DEMO_BACKGROUND_OPACITY }),
  set: async (opacity: number) => ({ success: true, opacity }),
  onChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoZoomFactorIpc = {
  get: async () => ({ zoomFactor: MARKETING_DEMO_ZOOM_FACTOR }),
  set: async (zoomFactor: number) => ({ success: true, zoomFactor }),
  onChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoThemeIpc = {
  get: async () => ({ theme: getMarketingDemoTheme() }),
  set: async (theme: string) => ({ success: true, theme }),
  onChanged: (callback: (event: { theme: string }) => void) => {
    queueMicrotask(() => callback({ theme: getMarketingDemoTheme() }));
    const themeParam = getSearchParams().get(DEMO_THEME_PARAM);
    if (!hasWindow() || themeParam === 'light' || themeParam === 'dark') {
      return NOOP_UNSUBSCRIBE;
    }
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => callback({ theme: getMarketingDemoTheme() });
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  },
};

export const marketingDemoPrimaryColorIpc = {
  get: async () => ({ color: MARKETING_DEMO_PRIMARY_COLOR }),
  set: async (color: string) => ({ success: true, color }),
  onChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoUiSettingsIpc = {
  getReviewMarkdownEdits: async () => ({ enabled: true }),
  setReviewMarkdownEdits: async (enabled: boolean) => ({ success: true, enabled }),
  onReviewMarkdownEditsChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  getShowHelpPanelPreview: async () => ({ enabled: true }),
  setShowHelpPanelPreview: async (enabled: boolean) => ({ success: true, enabled }),
  onShowHelpPanelPreviewChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  getLaunchAtLogin: async () => ({ enabled: false }),
  setLaunchAtLogin: async (enabled: boolean) => ({ success: true, enabled }),
  onLaunchAtLoginChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoToolServersIpc = {
  getSnapshot: async () => ({ servers: cloneMarketingDemoToolServers() }),
  list: async () => ({ servers: cloneMarketingDemoToolServers() }),
  onChanged: (callback: (event: { servers: MarketingDemoToolServer[] }) => void) => {
    queueMicrotask(() => callback({ servers: cloneMarketingDemoToolServers() }));
    return subscribeMarketingDemoListener(marketingDemoToolServersChangedListeners, callback);
  },
};

export const marketingDemoServersIpc = {
  list: async () => ({ servers: cloneMarketingDemoToolServers() }),
  add: async (config: MarketingDemoToolServerConfig) => {
    const serverId = toMarketingDemoServerId(config.name || 'tool-server');
    marketingDemoServers.set(serverId, {
      id: serverId,
      name: config.name || 'Tool Server',
      config: structuredClone(config),
      state: { status: 'connected' },
    });
    emitMarketingDemoToolServersChanged();
    return { success: true, serverId };
  },
  get: async (serverId: string) => {
    const server = marketingDemoServers.get(serverId);
    if (!server) {
      throw new Error(`Demo tool server not found: ${serverId}`);
    }
    return structuredClone(server);
  },
  startOAuth: async (_serverId: string, _scopes?: string[]) => ({
    authorizationUrl: 'about:blank',
  }),
  update: async (serverId: string, updates: Partial<MarketingDemoToolServerConfig>) => {
    const server = marketingDemoServers.get(serverId);
    if (!server) {
      return { success: false, error: 'Server not found' };
    }
    marketingDemoServers.set(serverId, {
      ...server,
      config: {
        ...(server.config || {}),
        ...structuredClone(updates),
      },
    });
    emitMarketingDemoToolServersChanged();
    return { success: true };
  },
  delete: async (serverId: string) => {
    marketingDemoServers.delete(serverId);
    emitMarketingDemoToolServersChanged();
    return { success: true };
  },
  toggle: async (serverId: string, enabled: boolean) => {
    const server = marketingDemoServers.get(serverId);
    if (!server) {
      return { success: false, error: 'Server not found' };
    }
    marketingDemoServers.set(serverId, {
      ...server,
      config: {
        ...(server.config || {}),
        enabled,
      },
      state: { status: enabled ? 'connected' : 'disconnected' },
    });
    emitMarketingDemoToolServersChanged();
    return { success: true };
  },
  callTool: async () => ({ success: false, error: 'Tool execution is unavailable in this browser workspace.' }),
};

export const marketingDemoMcpDiscoveryIpc = {
  importedSetup: async () => ({
    generatedAt: new Date(0).toISOString(),
    candidates: structuredClone(MARKETING_DEMO_DISCOVERED_MCPS).map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      source: mcp.source,
      transport: mcp.transport,
      installable: true,
    })),
    summary: {
      generatedAt: new Date(0).toISOString(),
      sources: ['discovered-mcp-configs'],
      summary: 'Importable MCP servers: GitHub (Cursor, http), Notion (Claude Code, http).',
    },
  }),
  installImportedCandidate: async (candidateId: string) => {
    const mcp = MARKETING_DEMO_DISCOVERED_MCPS.find((candidate) => candidate.id === candidateId);
    if (!mcp) {
      throw new Error(`Imported MCP candidate not found: ${candidateId}`);
    }
    return marketingDemoServersIpc.add({
      name: mcp.name,
      transport: mcp.transport,
      enabled: true,
      url: mcp.url,
      headers: mcp.headers,
    });
  },
  discover: async () => ({
    discovered: structuredClone(MARKETING_DEMO_DISCOVERED_MCPS),
    sources: {
      claudeCode: { found: true, path: '/Users/demo/.claude/mcp.json' },
      cursor: { found: true, path: '/Users/demo/.cursor/mcp.json' },
    },
  }),
  deepScan: async () => ({
    discovered: structuredClone(MARKETING_DEMO_DEEP_SCAN_MCPS),
  }),
};

export const marketingDemoProvidersIpc = {
  initiateOAuth: async (providerType: 'openai' | 'claude') => ({
    authUrl: 'about:blank',
    flowId: `marketing-demo-${providerType}`,
  }),
  completeOAuth: async (providerType: 'openai' | 'claude') => ({
    success: true,
    email: getMarketingDemoOAuthStatus(providerType).email,
  }),
  getOAuthStatus: async (providerType: 'openai' | 'claude') =>
    structuredClone(getMarketingDemoOAuthStatus(providerType)),
  getAllProfileStatuses: async () => structuredClone(marketingDemoProfileStatuses),
  listOpenAIOAuthModels: async () => ({
    models: structuredClone(MARKETING_DEMO_OAUTH_MODELS),
  }),
  listOpenRouterModels: async () => structuredClone(MARKETING_DEMO_OPENROUTER_CATALOG),
  listDeepSeekModels: async () => ({ models: [] }),
  listInterpreterProviders: async (_includeUnconfigured?: boolean) => ({
    providers: structuredClone(MARKETING_DEMO_INTERPRETER_PROVIDERS),
  }),
  setInterpreterProvider: async () => ({ success: true as const }),
  listInterpreterModels: async (providerId?: string) => ({
    models:
      providerId === 'openrouter'
        ? MARKETING_DEMO_OPENROUTER_CATALOG.models.map((model) => ({
            id: model.id,
            name: model.name,
            isDefault: false,
          }))
        : [],
  }),
  setInterpreterModel: async () => ({ success: true as const }),
  listInterpreterHarnesses: async () => ({ harnesses: [] }),
  setInterpreterHarness: async () => ({ success: true as const }),
  disconnectOAuth: async () => ({ success: true }),
  probeResponsesApiSupport: async () => ({ supported: true, reachable: true }),
  getOllamaStatus: async () => structuredClone(MARKETING_DEMO_OLLAMA_STATUS),
  getLmStudioStatus: async () => structuredClone(MARKETING_DEMO_LM_STUDIO_STATUS),
  getEnvApiKeys: async () => structuredClone(MARKETING_DEMO_ENV_API_KEYS),
  getEnvApiKey: async () => ({ key: null }),
  getClaudeCodeStatus: async () => structuredClone(MARKETING_DEMO_CLAUDE_CODE_STATUS),
  runClaudeLogin: async () => getMarketingDemoClaudeLoginResult(),
  setClaudeCodePath: async () => ({
    success: false,
    error: 'CLI path changes are unavailable in this browser workspace.',
  }),
  setCodexPath: async () => ({
    success: false,
    error: 'CLI path changes are unavailable in this browser workspace.',
  }),
  getCodexStatus: async () => structuredClone(MARKETING_DEMO_CODEX_STATUS),
  getGitHubCliAuth: async () => ({
    installed: false,
    loggedIn: false,
    error: 'CLI auth is unavailable in this browser workspace.',
  }),
  addGitHubMcpServerFromCliAuth: async () => ({
    success: false,
    installed: false,
    loggedIn: false,
    error: 'Tool setup is unavailable in this browser workspace.',
  }),
  rescanBinaryPaths: async () => ({
    claude: { found: false },
    codex: { found: false },
  }),
};

export const marketingDemoGlobalToolsIpc = {
  get: async () => ({ enabled: true }),
  set: async (serverId: string, enabled: boolean) => ({ success: true, serverId, enabled }),
  onChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoSkillsIpc = {
  list: async () => ({
    success: true,
    data: {
      global: {
        rootPath: '',
        skills: [],
        tree: [],
      },
      project: {
        rootPath: demoPath(MARKETING_DEMO_SKILLS_ROOT_RELATIVE_PATH),
        skills: structuredClone(marketingDemoProjectSkills),
        tree: structuredClone(marketingDemoProjectSkillTree),
      },
    },
  }),
  onChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoApprovalsIpc = {
  get: async () => ({ approvals: [] }),
  onCreated: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  onListChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoProgrammaticTasksIpc = {
  onStarted: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoDesktopNotificationIpc = {
  show: async () => ({ success: true }),
  onClicked: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoTopNoticesIpc = {
  list: async () => ({ notices: [] }),
  dismiss: async () => ({ success: true }),
};

export const marketingDemoInterviewInviteIpc = {
  getStatus: async () => ({
    currentVersion: '',
    show: false,
    bookingUrl: '',
  }),
  dismissCurrent: async () => ({ success: true }),
};

export const marketingDemoTelemetryIpc = {
  get: async () => ({ enabled: false }),
  set: async (enabled: boolean) => ({ success: true, enabled }),
  track: async () => ({ success: true }),
  trackError: async () => ({ success: true }),
  trackOnboarding: async () => ({ success: true }),
};

export const marketingDemoAgentTabsIpc = {
  onCreateRequested: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  onSendRequested: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  onStopRequested: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  getPending: async () => ({ requests: [] }),
  created: async () => ({ success: true }),
  completed: async () => ({ success: true }),
  registerThread: async () => ({ success: true }),
  reportActivity: async () => ({ success: true }),
  disposeBinding: async () => ({ success: true }),
  consumeStartup: async () => ({ success: true, startup: null }),
};

export const marketingDemoTtsIpc = {
  getSettings: async () => ({
    settings: structuredClone(DEFAULT_TTS_SETTINGS),
    installRoot: '',
  }),
  setSettings: async (request: { settings: Partial<typeof DEFAULT_TTS_SETTINGS> }) => ({
    success: true,
    settings: { ...DEFAULT_TTS_SETTINGS, ...request.settings },
  }),
  listModels: async () => ({
    models: [],
    installRoot: '',
  }),
  speak: async () => ({ success: false }),
  getVoices: async () => ({
    modelId: DEFAULT_TTS_SETTINGS.modelId,
    installed: false,
    voices: [],
  }),
  installModel: async (request: { modelId: string }) => ({
    success: false,
    modelId: request.modelId,
    error: 'Model installation is unavailable in this browser workspace.',
  }),
  onSettingsChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  onPlaybackRequested: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
  onInstallProgress: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};

export const marketingDemoSttIpc = {
  getSettings: async () => ({
    settings: structuredClone(DEFAULT_STT_SETTINGS),
  }),
  setSettings: async (request: { settings: Partial<typeof DEFAULT_STT_SETTINGS> }) => ({
    success: true,
    settings: { ...DEFAULT_STT_SETTINGS, ...request.settings },
  }),
  onSettingsChanged: (_callback: (event: unknown) => void) => NOOP_UNSUBSCRIBE,
};
