import type {
  StreamImageAttachment,
  StreamSkillReference,
  StreamRequestBody,
} from '../../src/lib/codex/api-types';
import type { ReasoningEffort } from '../../shared/types/reasoning';

type StreamRequestCommon = {
  agentId?: string;
  callerToken?: string;
  message?: string;
  system?: string;
  threadId?: string | null;
  workspacePath?: string | null;
  reasoningEffort?: ReasoningEffort;
  attachments: StreamImageAttachment[];
  skills: StreamSkillReference[];
};

type RuntimeSelectionOverrides = {
  model?: string;
  codexProfileId?: string;
  customEndpoint?: string;
  customApiKey?: string;
};

export type StoredProfileStreamRequest = StreamRequestCommon &
  RuntimeSelectionOverrides & {
    selection: 'stored-profile';
    profileId: string;
  };

export type ExplicitStreamRequest = StreamRequestCommon &
  RuntimeSelectionOverrides & {
    selection: 'explicit';
  };

export type NormalizedStreamRequest =
  | StoredProfileStreamRequest
  | ExplicitStreamRequest;

function buildCommonRequestFields(body: StreamRequestBody): StreamRequestCommon {
  return {
    agentId: body.agentId,
    callerToken: body.callerToken,
    message: body.message,
    system: body.system,
    threadId: body.threadId,
    workspacePath: body.workspacePath,
    reasoningEffort: body.reasoningEffort,
    attachments: body.attachments ?? [],
    skills: body.skills ?? [],
  };
}

export function normalizeStreamRequestBody(
  body: StreamRequestBody,
): NormalizedStreamRequest {
  const common = buildCommonRequestFields(body);

  if (body.profileId) {
    return {
      ...common,
      selection: 'stored-profile',
      profileId: body.profileId,
      model: body.model,
      codexProfileId: body.codexProfileId,
      customEndpoint: body.customEndpoint,
      customApiKey: body.customApiKey,
    };
  }

  return {
    ...common,
    selection: 'explicit',
    model: body.model,
    codexProfileId: body.codexProfileId,
    customEndpoint: body.customEndpoint,
    customApiKey: body.customApiKey,
  };
}

export function selectRequestedRuntimeModel(
  request: NormalizedStreamRequest,
  fallbackModel?: string,
): string | undefined {
  return request.model ?? fallbackModel;
}
