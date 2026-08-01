import {
  loadConfig,
  saveConfig,
  setCodexApprovalPolicy,
  setCodexNetworkAccess,
  setCodexSandboxMode,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from './configStore';
import type { Profile } from '../shared/types/profile';
import type { ApiFormat, WireApi } from '../shared/types/model';
import type { ReasoningEffort } from '../shared/types/reasoning';
import { restartCodexRuntime } from '../src/lib/codex/service';

export interface ProgrammaticTaskDefaultProfileConfig {
  id?: string;
  name?: string;
  provider: Profile['provider'];
  modelId: string;
  providerId?: string;
  apiKey?: string;
  baseURL?: string;
  apiFormat?: ApiFormat;
  wireApi?: WireApi;
  codexProfileId?: string;
  useResponsesApi?: boolean;
  reasoningEffort?: ReasoningEffort;
}

export interface ProgrammaticTaskRuntimeConfig {
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexSandboxMode?: CodexSandboxMode;
  codexNetworkAccess?: boolean;
  defaultProfile?: ProgrammaticTaskDefaultProfileConfig;
}

export function createOpenAiApiProgrammaticProfile(config?: {
  id?: string;
  name?: string;
  modelId?: string;
  apiKey?: string;
  baseURL?: string;
}): ProgrammaticTaskDefaultProfileConfig {
  return {
    id: config?.id ?? 'programmatic:headless-openai-api',
    name: config?.name ?? 'Headless OpenAI API',
    provider: 'api',
    modelId: config?.modelId ?? 'gpt-5.4-mini',
    apiKey: config?.apiKey,
    baseURL: config?.baseURL ?? 'https://api.openai.com/v1',
    apiFormat: 'openai',
    codexProfileId: 'openai-api',
    wireApi: 'responses',
    useResponsesApi: true,
  };
}

async function upsertDefaultProfile(
  profileConfig: ProgrammaticTaskDefaultProfileConfig,
): Promise<void> {
  const config = await loadConfig();
  const profileId = profileConfig.id?.trim() || 'programmatic:default';
  const profileName = profileConfig.name?.trim() || 'Programmatic Default';

  const profile: Profile = {
    id: profileId,
    name: profileName,
    modelId: profileConfig.modelId,
    isBuiltin: false,
    provider: profileConfig.provider,
    providerId: profileConfig.providerId,
    apiKey: profileConfig.apiKey,
    baseURL: profileConfig.baseURL,
    apiFormat: profileConfig.apiFormat,
    wireApi: profileConfig.provider === 'api' ? profileConfig.wireApi : undefined,
    codexProfileId: profileConfig.codexProfileId,
    useResponsesApi: profileConfig.useResponsesApi,
    reasoningEffort: profileConfig.reasoningEffort,
  };

  config.profiles = config.profiles ?? [];
  const existingIndex = config.profiles.findIndex((existing) => existing.id === profile.id);
  if (existingIndex >= 0) {
    config.profiles[existingIndex] = profile;
  } else {
    config.profiles.push(profile);
  }

  config.defaultProfileId = profile.id;
  await saveConfig(config);
}

export async function applyProgrammaticTaskRuntimeConfig(
  config: ProgrammaticTaskRuntimeConfig,
): Promise<void> {
  let changedRuntimeConfig = false;

  if (typeof config.codexNetworkAccess === 'boolean') {
    await setCodexNetworkAccess(config.codexNetworkAccess);
    changedRuntimeConfig = true;
  }

  if (config.codexApprovalPolicy) {
    await setCodexApprovalPolicy(config.codexApprovalPolicy);
    changedRuntimeConfig = true;
  }

  if (config.codexSandboxMode) {
    await setCodexSandboxMode(config.codexSandboxMode);
    changedRuntimeConfig = true;
  }

  if (config.defaultProfile) {
    await upsertDefaultProfile(config.defaultProfile);
    changedRuntimeConfig = true;
  }

  if (changedRuntimeConfig) {
    restartCodexRuntime();
  }
}
