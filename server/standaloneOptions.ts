import type { CodexApprovalPolicy, CodexSandboxMode } from './configStore';
import {
  createOpenAiApiProgrammaticProfile,
  type ProgrammaticTaskRuntimeConfig,
} from './programmaticTaskRuntimeConfig';

const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5177;

export type CliOptions = {
  help: boolean;
  message?: string;
  messageFile?: string;
  system?: string;
  systemFile?: string;
  threadId?: string;
  timeoutMs?: number;
  workspace?: string;
  home?: string;
  port?: number | 'auto';
  shutdownAfterTask: boolean;
  streamJsonl: boolean;
  quietStartup: boolean;
  devAutoApproveTools: boolean;
  resultFile?: string;
  skills?: string[];
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexSandboxMode?: CodexSandboxMode;
  codexNetworkAccess?: boolean;
  profileId?: string;
  profileName?: string;
  modelId?: string;
  openAIApiKey?: string;
  openAIApiKeyEnv?: string;
  baseURL?: string;
};

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    shutdownAfterTask: false,
    streamJsonl: false,
    quietStartup: false,
    devAutoApproveTools: false,
    port: DEFAULT_PORT,
  };

  const nextValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--headless':
      case '--':
        break;
      case '--message':
        options.message = nextValue(index, arg);
        index += 1;
        break;
      case '--message-file':
        options.messageFile = nextValue(index, arg);
        index += 1;
        break;
      case '--system':
        options.system = nextValue(index, arg);
        index += 1;
        break;
      case '--system-file':
        options.systemFile = nextValue(index, arg);
        index += 1;
        break;
      case '--thread-id':
        options.threadId = nextValue(index, arg);
        index += 1;
        break;
      case '--profile-id':
        options.profileId = nextValue(index, arg);
        index += 1;
        break;
      case '--profile-name':
        options.profileName = nextValue(index, arg);
        index += 1;
        break;
      case '--model':
        options.modelId = nextValue(index, arg);
        index += 1;
        break;
      case '--openai-api-key':
        options.openAIApiKey = nextValue(index, arg);
        index += 1;
        break;
      case '--openai-api-key-env':
        options.openAIApiKeyEnv = nextValue(index, arg);
        index += 1;
        break;
      case '--base-url':
        options.baseURL = nextValue(index, arg);
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(nextValue(index, arg));
        index += 1;
        break;
      case '--home':
        options.home = nextValue(index, arg);
        index += 1;
        break;
      case '--workspace':
        options.workspace = nextValue(index, arg);
        index += 1;
        break;
      case '--port': {
        const rawPort = nextValue(index, arg);
        if (rawPort === 'auto') {
          options.port = 'auto';
        } else {
          const parsedPort = Number(rawPort);
          if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
            throw new Error(`Invalid port: ${rawPort}`);
          }
          options.port = parsedPort;
        }
        index += 1;
        break;
      }
      case '--shutdown-after-task':
      case '--shutdown-after-first-task':
        options.shutdownAfterTask = true;
        break;
      case '--stream-jsonl':
        options.streamJsonl = true;
        break;
      case '--quiet-startup':
        options.quietStartup = true;
        break;
      case '--dev-auto-approve-tools':
        options.devAutoApproveTools = true;
        break;
      case '--result-file':
        options.resultFile = nextValue(index, arg);
        index += 1;
        break;
      case '--skill':
      case '--skill-name':
      case '--skill-path': {
        const skill = nextValue(index, arg);
        options.skills = [...(options.skills ?? []), skill];
        index += 1;
        break;
      }
      case '--approval-policy': {
        const policy = nextValue(index, arg);
        if (policy !== 'never' && policy !== 'on-failure' && policy !== 'on-request' && policy !== 'untrusted') {
          throw new Error(`Invalid approval policy: ${policy}`);
        }
        options.codexApprovalPolicy = policy;
        index += 1;
        break;
      }
      case '--sandbox': {
        const sandbox = nextValue(index, arg);
        if (sandbox !== 'read-only' && sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') {
          throw new Error(`Invalid sandbox mode: ${sandbox}`);
        }
        options.codexSandboxMode = sandbox;
        index += 1;
        break;
      }
      case '--network-access':
        options.codexNetworkAccess = true;
        break;
      case '--no-network-access':
        options.codexNetworkAccess = false;
        break;
      case '--full-access':
        options.codexSandboxMode = 'danger-full-access';
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('--timeout-ms must be a positive number');
  }

  return options;
}

function shouldOverrideDefaultProfile(cliOptions: CliOptions): boolean {
  return (
    cliOptions.profileId !== undefined
    || cliOptions.profileName !== undefined
    || cliOptions.modelId !== undefined
    || cliOptions.openAIApiKey !== undefined
    || cliOptions.openAIApiKeyEnv !== undefined
    || cliOptions.baseURL !== undefined
  );
}

function resolveDefaultProfileForCliTask(cliOptions: CliOptions) {
  if (!shouldOverrideDefaultProfile(cliOptions)) {
    return undefined;
  }

  const envName = cliOptions.openAIApiKeyEnv ?? 'OPENAI_API_KEY';
  const apiKey = cliOptions.openAIApiKey ?? process.env[envName] ?? undefined;

  if (!apiKey) {
    throw new Error(`Missing OpenAI API key. Set ${envName} or pass --openai-api-key.`);
  }

  return createOpenAiApiProgrammaticProfile({
    id: cliOptions.profileId,
    name: cliOptions.profileName,
    modelId: cliOptions.modelId,
    apiKey,
    baseURL: cliOptions.baseURL,
  });
}

export function buildProgrammaticTaskRuntimeConfig(
  cliOptions: CliOptions,
): ProgrammaticTaskRuntimeConfig {
  const defaultProfile = resolveDefaultProfileForCliTask(cliOptions);

  return {
    codexApprovalPolicy: cliOptions.codexApprovalPolicy,
    codexSandboxMode: cliOptions.codexSandboxMode,
    codexNetworkAccess: cliOptions.codexNetworkAccess,
    defaultProfile,
  };
}
