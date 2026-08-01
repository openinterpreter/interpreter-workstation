import type { ProfileId } from "./profile-options";
import type { ReasoningEffort } from "../../../shared/types/reasoning";
import type { McpServerConfig } from "./protocol";

export type StreamImageAttachment = {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type StreamSkillReference = {
  id: string;
  label: string;
  name: string;
  path: string;
};

export type StreamRequestBody = {
  agentId?: string;
  callerToken?: string;
  message?: string;
  system?: string;
  threadId?: string | null;
  workspacePath?: string | null;
  model?: string;
  profileId?: ProfileId | string;
  codexProfileId?: string;
  customEndpoint?: string;
  customApiKey?: string;
  reasoningEffort?: ReasoningEffort;
  attachments?: StreamImageAttachment[];
  skills?: StreamSkillReference[];
};

export type StopRequestBody = {
  threadId?: string;
  turnId?: string;
};

export type SteerRequestBody = {
  threadId?: string;
  turnId?: string;
  message?: string;
  attachments?: StreamImageAttachment[];
  skills?: StreamSkillReference[];
};

export type BackgroundTerminalStopRequestBody = {
  threadId?: string;
};

export type CreateMcpServerBody = {
  name: string;
  config: McpServerConfig;
};

export type UpdateMcpServerBody = McpServerConfig;

export type OAuthLoginBody = {
  scopes?: string[];
};
