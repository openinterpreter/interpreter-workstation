import path from 'node:path';
import { approvalManager } from '../approvalManager';
import { SERVER_REQUEST_METHOD, type ServerRequest } from '../../src/lib/codex/protocol';
import { prefixToolName } from '../../shared/utils/mcpToolName';
import {
  checkFileAccessPermissionAsync,
  resolvePathWithWorkspace,
} from './permissions';
import { getCurrentWorkspace } from './workspace';
import { isOutsideWorkspace, isTrustedGlobalSkillReadPath } from '../tools/filesystemGuard';
import { agentTabManager } from '../agentTabManager';
import type { Question, QuestionResult } from '../../shared/types/approval';
import {
  getCodexMacosScreenshotAccessSync,
  getCodexMacosTempAccessSync,
} from '../configStore';
import { isPathInCodexMacosTrustedReadZone } from './codexTrustedPaths';
import { shouldPromptForWorkspaceWriteSync } from './agentFilePermissions';
import { getGlobalSkillsRoot } from './skillsPaths';
import type { CommandExecutionApprovalDecision } from '../handlers/codex-generated-types/v2/CommandExecutionApprovalDecision';
import type { CommandExecutionRequestApprovalParams } from '../handlers/codex-generated-types/v2/CommandExecutionRequestApprovalParams';
import type { FileChangeApprovalDecision } from '../handlers/codex-generated-types/v2/FileChangeApprovalDecision';
import type { FileChangeRequestApprovalParams } from '../handlers/codex-generated-types/v2/FileChangeRequestApprovalParams';
import type { McpElicitationLegacyTitledEnumSchema } from '../handlers/codex-generated-types/v2/McpElicitationLegacyTitledEnumSchema';
import type { McpElicitationMultiSelectEnumSchema } from '../handlers/codex-generated-types/v2/McpElicitationMultiSelectEnumSchema';
import type { McpElicitationPrimitiveSchema } from '../handlers/codex-generated-types/v2/McpElicitationPrimitiveSchema';
import type { McpElicitationSchema } from '../handlers/codex-generated-types/v2/McpElicitationSchema';
import type { McpElicitationSingleSelectEnumSchema } from '../handlers/codex-generated-types/v2/McpElicitationSingleSelectEnumSchema';
import type { McpServerElicitationRequestParams } from '../handlers/codex-generated-types/v2/McpServerElicitationRequestParams';
import type { McpServerElicitationRequestResponse } from '../handlers/codex-generated-types/v2/McpServerElicitationRequestResponse';
import type { JsonValue } from '../handlers/codex-generated-types/serde_json/JsonValue';

type ServerRequestResponder = (result: unknown) => void;
type McpServerElicitationRequest = Extract<ServerRequest, { method: 'mcpServer/elicitation/request' }>;
type McpToolApprovalElicitationRequest = McpServerElicitationRequest & {
  params: Extract<McpServerElicitationRequestParams, { mode: 'form' }>;
};

type CodexServerRequestClient = {
  subscribeServerRequests(
    handler: (request: ServerRequest, respond: ServerRequestResponder) => void,
  ): () => void;
};

type McpElicitationFieldSpec =
  | {
    id: string;
    kind: 'string';
    required: boolean;
  }
  | {
    id: string;
    kind: 'number';
    required: boolean;
  }
  | {
    id: string;
    kind: 'boolean';
    required: boolean;
  }
  | {
    id: string;
    kind: 'single-select';
    required: boolean;
  }
  | {
    id: string;
    kind: 'multi-select';
    required: boolean;
  };

type ParsedMcpElicitationQuestionFlow =
  | {
    toolName: string;
    context: Record<string, unknown>;
    questions: Question[];
    resolveResult: (result: QuestionResult) => McpServerElicitationRequestResponse;
  }
  | null;

export type CodexServerRequestApprovalDeps = {
  createApproval: (
    toolName: string,
    serverId: string,
    args: unknown,
    timeout: number,
    toolCallId?: string,
    agentId?: string,
  ) => Promise<boolean>;
  createSessionAwareApproval: (
    toolName: string,
    serverId: string,
    args: unknown,
    warningMessage: string,
    timeout: number,
    toolCallId?: string,
    agentId?: string,
  ) => Promise<{ approved: boolean; mode?: 'once' | 'session' }>;
  createQuestion: (
    toolName: string,
    serverId: string,
    questions: Question[],
    context: unknown,
    timeout: number,
    toolCallId?: string,
    agentId?: string,
  ) => Promise<QuestionResult>;
  onError: (error: unknown) => void;
  shouldAutoApproveViewImagePath?: (filePath: string) => boolean | Promise<boolean>;
};

const attachedClients = new WeakSet<object>();

const MCP_APPROVAL_ACCEPT_ONCE_VALUE = 'accept';
const MCP_APPROVAL_ACCEPT_SESSION_VALUE = 'accept_session';
const MCP_APPROVAL_ACCEPT_ALWAYS_VALUE = 'accept_always';
const MCP_APPROVAL_DECLINE_VALUE = 'decline';
const MCP_APPROVAL_CANCEL_VALUE = 'cancel';
const MCP_APPROVAL_META_KIND_KEY = 'codex_approval_kind';
const MCP_APPROVAL_META_KIND_MCP_TOOL_CALL = 'mcp_tool_call';
const MCP_APPROVAL_META_KIND_TOOL_SUGGESTION = 'tool_suggestion';
const MCP_APPROVAL_PERSIST_KEY = 'persist';
const MCP_APPROVAL_PERSIST_SESSION_VALUE = 'session';
const MCP_APPROVAL_PERSIST_ALWAYS_VALUE = 'always';
const MCP_APPROVAL_TOOL_PARAMS_KEY = 'tool_params';
const MCP_APPROVAL_TOOL_PARAMS_DISPLAY_KEY = 'tool_params_display';

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizeValueForDisplay(value: unknown): string {
  if (typeof value === 'string') {
    return value.split(/\s+/).filter(Boolean).join(' ');
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => summarizeValueForDisplay(entry)).filter(Boolean).join(', ');
  }
  if (isJsonObject(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return '';
}

function parseMcpToolApprovalDisplayLines(meta: unknown): string[] {
  if (!isJsonObject(meta)) {
    return [];
  }

  const displayEntries = Array.isArray(meta[MCP_APPROVAL_TOOL_PARAMS_DISPLAY_KEY])
    ? meta[MCP_APPROVAL_TOOL_PARAMS_DISPLAY_KEY]
    : [];
  const displayLines = displayEntries
    .filter(isJsonObject)
    .map((entry) => {
      const name = typeof entry.display_name === 'string'
        ? entry.display_name.trim()
        : typeof entry.name === 'string'
          ? entry.name.trim()
          : '';
      if (!name || !('value' in entry)) {
        return null;
      }

      const value = summarizeValueForDisplay(entry.value);
      return value ? `${name}: ${value}` : null;
    })
    .filter((line): line is string => typeof line === 'string' && line.length > 0);
  if (displayLines.length > 0) {
    return displayLines;
  }

  const fallbackParams = meta[MCP_APPROVAL_TOOL_PARAMS_KEY];
  if (!isJsonObject(fallbackParams)) {
    return [];
  }

  return Object.entries(fallbackParams)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const formatted = summarizeValueForDisplay(value);
      return formatted ? `${name}: ${formatted}` : null;
    })
    .filter((line): line is string => typeof line === 'string' && line.length > 0);
}

function mcpApprovalSupportsPersistMode(meta: unknown, expectedMode: string): boolean {
  if (!isJsonObject(meta)) {
    return false;
  }

  const persist = meta[MCP_APPROVAL_PERSIST_KEY];
  if (typeof persist === 'string') {
    return persist === expectedMode;
  }

  return Array.isArray(persist)
    && persist.some((value) => typeof value === 'string' && value === expectedMode);
}

function isMessageOnlyMcpSchema(schema: McpElicitationSchema | null): boolean {
  if (!schema) {
    return true;
  }

  return schema.type === 'object' && Object.keys(schema.properties ?? {}).length === 0;
}

function buildMcpApprovalActionQuestion(
  params: Extract<McpServerElicitationRequestParams, { mode: 'form' }>,
  meta: unknown,
): ParsedMcpElicitationQuestionFlow {
  const metaKind = isJsonObject(meta) && typeof meta[MCP_APPROVAL_META_KIND_KEY] === 'string'
    ? meta[MCP_APPROVAL_META_KIND_KEY]
    : null;
  const isToolApproval = metaKind === MCP_APPROVAL_META_KIND_MCP_TOOL_CALL;
  const isToolSuggestion = metaKind === MCP_APPROVAL_META_KIND_TOOL_SUGGESTION;
  const toolDetails = parseMcpToolApprovalDisplayLines(meta);

  const options: Question['options'] = [];
  if (isToolSuggestion) {
    options.push({
      label: 'Accept',
      value: MCP_APPROVAL_ACCEPT_ONCE_VALUE,
      description: 'Continue with this suggestion.',
      recommended: true,
    });
    options.push({
      label: 'Cancel',
      value: MCP_APPROVAL_CANCEL_VALUE,
      description: 'Cancel this request.',
    });
  } else {
    options.push({
      label: 'Allow',
      value: MCP_APPROVAL_ACCEPT_ONCE_VALUE,
      description: isToolApproval
        ? 'Run the tool and continue.'
        : 'Allow this request and continue.',
      recommended: true,
    });
    if (mcpApprovalSupportsPersistMode(meta, MCP_APPROVAL_PERSIST_SESSION_VALUE)) {
      options.push({
        label: 'Allow for this session',
        value: MCP_APPROVAL_ACCEPT_SESSION_VALUE,
        description: isToolApproval
          ? 'Run the tool and remember this choice for this session.'
          : 'Allow this request and remember this choice for this session.',
      });
    }
    if (mcpApprovalSupportsPersistMode(meta, MCP_APPROVAL_PERSIST_ALWAYS_VALUE)) {
      options.push({
        label: 'Always allow',
        value: MCP_APPROVAL_ACCEPT_ALWAYS_VALUE,
        description: isToolApproval
          ? 'Run the tool and remember this choice for future tool calls.'
          : 'Allow this request and remember this choice for future requests.',
      });
    }
    if (!isToolApproval) {
      options.push({
        label: "Don't allow",
        value: MCP_APPROVAL_DECLINE_VALUE,
        description: 'Decline this request and continue.',
      });
    }
    options.push({
      label: 'Cancel',
      value: MCP_APPROVAL_CANCEL_VALUE,
      description: isToolApproval ? 'Cancel this tool call.' : 'Cancel this request.',
    });
  }

  const toolName = isToolApproval ? 'MCP tool approval' : 'MCP request';
  return {
    toolName,
    context: {
      threadId: params.threadId,
      turnId: params.turnId,
      serverName: params.serverName,
      message: params.message,
      description: isToolApproval
        ? 'Review this tool request before continuing.'
        : 'Review this MCP request before continuing.',
      toolDetails,
      requestUrl: null,
    },
    questions: [{
      question: params.message.trim() || 'How should Interpreter handle this request?',
      header: params.serverName,
      options,
      allowOther: false,
      default: MCP_APPROVAL_ACCEPT_ONCE_VALUE,
    }],
    resolveResult: (result) => {
      const selected = typeof result.answers['0'] === 'string'
        ? result.answers['0']
        : MCP_APPROVAL_CANCEL_VALUE;
      switch (selected) {
        case MCP_APPROVAL_ACCEPT_ONCE_VALUE:
          return { action: 'accept', content: isToolSuggestion ? {} : null, _meta: null };
        case MCP_APPROVAL_ACCEPT_SESSION_VALUE:
          return {
            action: 'accept',
            content: null,
            _meta: {
              [MCP_APPROVAL_PERSIST_KEY]: MCP_APPROVAL_PERSIST_SESSION_VALUE,
            },
          };
        case MCP_APPROVAL_ACCEPT_ALWAYS_VALUE:
          return {
            action: 'accept',
            content: null,
            _meta: {
              [MCP_APPROVAL_PERSIST_KEY]: MCP_APPROVAL_PERSIST_ALWAYS_VALUE,
            },
          };
        case MCP_APPROVAL_DECLINE_VALUE:
          return { action: 'decline', content: null, _meta: null };
        default:
          return { action: 'cancel', content: null, _meta: null };
      }
    },
  };
}

function buildUrlMcpQuestion(
  params: Extract<McpServerElicitationRequestParams, { mode: 'url' }>,
): ParsedMcpElicitationQuestionFlow {
  return {
    toolName: 'MCP request',
    context: {
      threadId: params.threadId,
      turnId: params.turnId,
      serverName: params.serverName,
      message: params.message,
      description: 'Review this MCP request before continuing.',
      requestUrl: params.url,
    },
    questions: [{
      question: params.message.trim() || 'How should Interpreter handle this request?',
      header: params.serverName,
      options: [
        {
          label: 'Allow',
          value: MCP_APPROVAL_ACCEPT_ONCE_VALUE,
          description: 'Allow this request and continue.',
          recommended: true,
        },
        {
          label: "Don't allow",
          value: MCP_APPROVAL_DECLINE_VALUE,
          description: 'Decline this request and continue.',
        },
        {
          label: 'Cancel',
          value: MCP_APPROVAL_CANCEL_VALUE,
          description: 'Cancel this request.',
        },
      ],
      allowOther: false,
      default: MCP_APPROVAL_ACCEPT_ONCE_VALUE,
    }],
    resolveResult: (result) => {
      const selected = typeof result.answers['0'] === 'string'
        ? result.answers['0']
        : MCP_APPROVAL_CANCEL_VALUE;
      switch (selected) {
        case MCP_APPROVAL_ACCEPT_ONCE_VALUE:
          return { action: 'accept', content: null, _meta: null };
        case MCP_APPROVAL_DECLINE_VALUE:
          return { action: 'decline', content: null, _meta: null };
        default:
          return { action: 'cancel', content: null, _meta: null };
      }
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function extractTextAnswer(answer: string | string[] | undefined): string | undefined {
  if (typeof answer !== 'string') {
    return undefined;
  }

  return answer.startsWith('other:') ? answer.slice('other:'.length) : answer;
}

function buildSingleSelectQuestion(
  id: string,
  required: boolean,
  prompt: string,
  label: string,
  options: Array<{ label: string; value: string }>,
  defaultValue?: string,
): { field: McpElicitationFieldSpec; question: Question } {
  return {
    field: {
      id,
      kind: 'single-select',
      required,
    },
    question: {
      header: label,
      question: prompt,
      options: options.map((option) => ({
        label: option.label,
        value: option.value,
      })),
      allowOther: false,
      default: defaultValue,
      optional: !required,
    },
  };
}

function buildMultiSelectQuestion(
  id: string,
  required: boolean,
  prompt: string,
  label: string,
  options: Array<{ label: string; value: string }>,
  defaultValue?: string[],
): { field: McpElicitationFieldSpec; question: Question } {
  return {
    field: {
      id,
      kind: 'multi-select',
      required,
    },
    question: {
      header: label,
      question: prompt,
      options: options.map((option) => ({
        label: option.label,
        value: option.value,
      })),
      multiSelect: true,
      allowOther: false,
      default: defaultValue,
      optional: !required,
    },
  };
}

function buildTextEntryQuestion(
  id: string,
  kind: 'string' | 'number',
  required: boolean,
  prompt: string,
  label: string,
): { field: McpElicitationFieldSpec; question: Question } {
  return {
    field: {
      id,
      kind,
      required,
    },
    question: {
      header: label,
      question: prompt,
      options: [],
      allowOther: true,
      optional: !required,
    },
  };
}

function parseSingleSelectEnumOptions(
  schema: McpElicitationSingleSelectEnumSchema | McpElicitationLegacyTitledEnumSchema,
): { options: Array<{ label: string; value: string }>; defaultValue?: string } | null {
  if ('enum' in schema && isStringArray(schema.enum)) {
    const displayNames = 'enumNames' in schema && isStringArray(schema.enumNames)
      ? schema.enumNames
      : [];
    return {
      options: schema.enum.map((value, index) => ({
        label: displayNames[index] ?? value,
        value,
      })),
      defaultValue: typeof schema.default === 'string' ? schema.default : undefined,
    };
  }

  if ('oneOf' in schema && Array.isArray(schema.oneOf)) {
    return {
      options: schema.oneOf
        .filter((entry) => isJsonObject(entry) && typeof entry.const === 'string' && typeof entry.title === 'string')
        .map((entry) => ({
          label: entry.title,
          value: entry.const,
        })),
      defaultValue: typeof schema.default === 'string' ? schema.default : undefined,
    };
  }

  return null;
}

function parseMultiSelectEnumOptions(
  schema: McpElicitationMultiSelectEnumSchema,
): { options: Array<{ label: string; value: string }>; defaultValue?: string[] } | null {
  if ('items' in schema && isJsonObject(schema.items)) {
    const items = schema.items;
    if ('enum' in items && isStringArray(items.enum)) {
      return {
        options: items.enum.map((value: string) => ({
          label: value,
          value,
        })),
        defaultValue: Array.isArray(schema.default)
          ? schema.default.filter((value): value is string => typeof value === 'string')
          : undefined,
      };
    }

    if ('anyOf' in items && Array.isArray(items.anyOf)) {
      const options = items.anyOf
        .filter((entry: unknown) => isJsonObject(entry) && typeof entry.const === 'string' && typeof entry.title === 'string')
        .map((entry: Record<string, unknown>) => ({
          label: entry.title as string,
          value: entry.const as string,
        }));
      return {
        options,
        defaultValue: Array.isArray(schema.default)
          ? schema.default.filter((value): value is string => typeof value === 'string')
          : undefined,
      };
    }
  }

  return null;
}

function parseMcpFormField(
  id: string,
  property: McpElicitationPrimitiveSchema,
  required: boolean,
): { field: McpElicitationFieldSpec; question: Question } | null {
  if (
    'type' in property
    && property.type === 'string'
    && !('enum' in property)
    && !('oneOf' in property)
  ) {
    const label = typeof property.title === 'string' && property.title.trim()
      ? property.title.trim()
      : id;
    const prompt = typeof property.description === 'string' && property.description.trim()
      ? property.description.trim()
      : label;
    return buildTextEntryQuestion(id, 'string', required, prompt, label);
  }

  if ('type' in property && (property.type === 'number' || property.type === 'integer')) {
    const label = typeof property.title === 'string' && property.title.trim()
      ? property.title.trim()
      : id;
    const prompt = typeof property.description === 'string' && property.description.trim()
      ? property.description.trim()
      : label;
    return buildTextEntryQuestion(id, 'number', required, prompt, label);
  }

  if ('type' in property && property.type === 'boolean') {
    const label = typeof property.title === 'string' && property.title.trim()
      ? property.title.trim()
      : id;
    const prompt = typeof property.description === 'string' && property.description.trim()
      ? property.description.trim()
      : label;
    return {
      field: {
        id,
        kind: 'boolean',
        required,
      },
      question: {
        header: label,
        question: prompt,
        options: [
          { label: 'True', value: 'true' },
          { label: 'False', value: 'false' },
        ],
        allowOther: false,
        default: typeof property.default === 'boolean'
          ? (property.default ? 'true' : 'false')
          : undefined,
        optional: !required,
      },
    };
  }

  if ('enum' in property || 'oneOf' in property || 'enumNames' in property) {
    const label = typeof property.title === 'string' && property.title.trim()
      ? property.title.trim()
      : id;
    const prompt = typeof property.description === 'string' && property.description.trim()
      ? property.description.trim()
      : label;
    const parsed = parseSingleSelectEnumOptions(
      property as McpElicitationSingleSelectEnumSchema | McpElicitationLegacyTitledEnumSchema,
    );
    if (!parsed || parsed.options.length === 0) {
      return null;
    }
    return buildSingleSelectQuestion(id, required, prompt, label, parsed.options, parsed.defaultValue);
  }

  if ('type' in property && property.type === 'array') {
    const label = typeof property.title === 'string' && property.title.trim()
      ? property.title.trim()
      : id;
    const prompt = typeof property.description === 'string' && property.description.trim()
      ? property.description.trim()
      : label;
    const parsed = parseMultiSelectEnumOptions(property as McpElicitationMultiSelectEnumSchema);
    if (!parsed || parsed.options.length === 0) {
      return null;
    }
    return buildMultiSelectQuestion(id, required, prompt, label, parsed.options, parsed.defaultValue);
  }

  return null;
}

function buildMcpFormQuestions(
  params: Extract<McpServerElicitationRequestParams, { mode: 'form' }>,
): ParsedMcpElicitationQuestionFlow {
  const schema = params.requestedSchema;
  if (schema.type !== 'object') {
    return null;
  }

  const requiredIds = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  const questions: Question[] = [];
  const fields: McpElicitationFieldSpec[] = [];

  for (const [id, property] of Object.entries(schema.properties ?? {})) {
    if (!property) {
      return null;
    }

    const parsedField = parseMcpFormField(id, property, requiredIds.has(id));
    if (!parsedField) {
      return null;
    }

    fields.push(parsedField.field);
    questions.push(parsedField.question);
  }

  if (questions.length === 0) {
    return null;
  }

  return {
    toolName: 'MCP input request',
    context: {
      threadId: params.threadId,
      turnId: params.turnId,
      serverName: params.serverName,
      message: params.message,
      description: 'Provide the requested MCP input before continuing.',
      fieldCount: fields.length,
    },
    questions,
    resolveResult: (result) => {
      const content: Record<string, JsonValue> = {};

      for (const [index, field] of fields.entries()) {
        const answer = result.answers[String(index)];
        if (answer == null) {
          if (field.required) {
            return { action: 'cancel', content: null, _meta: null };
          }
          continue;
        }

        if (field.kind === 'string') {
          const value = extractTextAnswer(answer);
          if (!value) {
            if (field.required) {
              return { action: 'cancel', content: null, _meta: null };
            }
            continue;
          }
          content[field.id] = value;
          continue;
        }

        if (field.kind === 'number') {
          const rawValue = extractTextAnswer(answer);
          if (!rawValue) {
            if (field.required) {
              return { action: 'cancel', content: null, _meta: null };
            }
            continue;
          }
          const parsedValue = Number(rawValue);
          if (!Number.isFinite(parsedValue)) {
            return { action: 'cancel', content: null, _meta: null };
          }
          content[field.id] = parsedValue;
          continue;
        }

        if (field.kind === 'boolean') {
          if (answer === 'true') {
            content[field.id] = true;
            continue;
          }
          if (answer === 'false') {
            content[field.id] = false;
            continue;
          }
          return { action: 'cancel', content: null, _meta: null };
        }

        if (field.kind === 'single-select') {
          if (typeof answer !== 'string') {
            return { action: 'cancel', content: null, _meta: null };
          }
          content[field.id] = extractTextAnswer(answer) ?? answer;
          continue;
        }

        if (!Array.isArray(answer) || answer.some((entry) => typeof entry !== 'string')) {
          return { action: 'cancel', content: null, _meta: null };
        }
        content[field.id] = answer
          .map((entry) => extractTextAnswer(entry) ?? entry)
          .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      }

      return { action: 'accept', content, _meta: null };
    },
  };
}

function buildMcpElicitationQuestionFlow(
  params: McpServerElicitationRequestParams,
): ParsedMcpElicitationQuestionFlow {
  if (params.mode === 'url') {
    return buildUrlMcpQuestion(params);
  }

  // Workstation does not advertise the OpenAI-specific extended-form
  // capability. If a server sends it anyway, cancel safely rather than treating
  // arbitrary JSON as the standard MCP form schema.
  if (params.mode === 'openai/form') {
    return null;
  }

  if (isMessageOnlyMcpSchema(params.requestedSchema)) {
    return buildMcpApprovalActionQuestion(params, params._meta);
  }

  return buildMcpFormQuestions(params);
}

async function defaultShouldAutoApproveViewImagePath(filePath: string): Promise<boolean> {
  const workspace = getCurrentWorkspace();

  try {
    if (workspace) {
      const resolved = resolvePathWithWorkspace(filePath, workspace);
      if (!(await isOutsideWorkspace(resolved, workspace))) {
        return true;
      }
    }

    return isPathInCodexMacosTrustedReadZone(filePath, {
      tempAccessEnabled: getCodexMacosTempAccessSync(),
      screenshotAccessEnabled: getCodexMacosScreenshotAccessSync(),
    });
  } catch {
    return false;
  }
}

function defaultDeps(): CodexServerRequestApprovalDeps {
  return {
    createApproval: (toolName, serverId, args, timeout, toolCallId, agentId) =>
      approvalManager.createApproval(toolName, serverId, args, timeout, toolCallId, agentId),
    createSessionAwareApproval: (toolName, serverId, args, warningMessage, timeout, toolCallId, agentId) =>
      approvalManager.createSessionAwareApproval(toolName, serverId, args, warningMessage, timeout, toolCallId, agentId),
    createQuestion: (toolName, serverId, questions, context, timeout, toolCallId, agentId) =>
      approvalManager.createQuestion(toolName, serverId, questions, context, timeout, toolCallId, false, agentId),
    onError: (error) => {
      console.error('[interpreter-server] failed to handle server request:', error);
    },
    shouldAutoApproveViewImagePath: defaultShouldAutoApproveViewImagePath,
  };
}

// NOTE(approval-flow): Native app-server approvals enter through this adapter,
// not directly through the UI. `src/lib/codex/app-server-client.ts` emits the
// JSON-RPC server request with a responder; this file creates a local
// `ApprovalManager` question/approval, then maps the user's answer back to the
// app-server decision so the original command/file/MCP request can resume.

function getBoundAgentId(threadId: string | null | undefined): string | undefined {
  if (!threadId) {
    return undefined;
  }
  return agentTabManager.getBindingForThread(threadId)?.agentId;
}

function getBoundWorkspacePath(threadId: string | null | undefined): string | null {
  if (!threadId) {
    return null;
  }
  return agentTabManager.getBindingForThread(threadId)?.workspacePath ?? null;
}

function getCommandExecutionUiToolCallId(
  request: Extract<ServerRequest, { method: 'item/commandExecution/requestApproval' }>,
): string {
  // `approvalId` is a callback identifier for a specific approval branch.
  // The parent command/tool item shown in chat is always `itemId`.
  return request.params.itemId;
}

function getLegacyExecUiToolCallId(
  request: Extract<ServerRequest, { method: 'execCommandApproval' }>,
): string {
  // `callId` is the tool/command item rendered in chat; `approvalId` is callback-only.
  return request.params.callId;
}

function isViewImageCommandApproval(request: ServerRequest): boolean {
  if (request.method !== SERVER_REQUEST_METHOD.commandExecutionApproval) {
    return false;
  }

  const reason = request.params.reason;
  return typeof reason === 'string' && reason.startsWith('view_image: ');
}

function isCommandExecutionApproval(
  request: ServerRequest,
): request is Extract<ServerRequest, { method: 'item/commandExecution/requestApproval' }> {
  return request.method === SERVER_REQUEST_METHOD.commandExecutionApproval;
}

function isLegacyExecCommandApproval(
  request: ServerRequest,
): request is Extract<ServerRequest, { method: 'execCommandApproval' }> {
  return request.method === SERVER_REQUEST_METHOD.execCommandApproval;
}

function isFileChangeApproval(
  request: ServerRequest,
): request is Extract<ServerRequest, { method: 'item/fileChange/requestApproval' }> {
  return request.method === SERVER_REQUEST_METHOD.fileChangeApproval;
}

function isMcpServerElicitationRequest(
  request: ServerRequest,
): request is Extract<ServerRequest, { method: 'mcpServer/elicitation/request' }> {
  return request.method === SERVER_REQUEST_METHOD.mcpServerElicitationRequest;
}

function isLegacyApplyPatchApproval(
  request: ServerRequest,
): request is Extract<ServerRequest, { method: 'applyPatchApproval' }> {
  return request.method === SERVER_REQUEST_METHOD.applyPatchApproval;
}

function deniedDecisionForRequest(request: ServerRequest): unknown {
  // Legacy applyPatchApproval uses ReviewDecision values (approved/denied/...),
  // while v2 fileChange approvals use accept/decline/cancel.
  if (isLegacyApplyPatchApproval(request)) {
    return { decision: 'denied' };
  }
  if (isMcpServerElicitationRequest(request)) {
    return {
      action: 'cancel',
      content: null,
      _meta: null,
    };
  }
  return { decision: 'decline' };
}

function cancelledElicitationResponse(): McpServerElicitationRequestResponse {
  return { action: 'cancel', content: null, _meta: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function isMcpToolApprovalElicitation(
  request: McpServerElicitationRequest,
): request is McpToolApprovalElicitationRequest {
  return (
    request.params.mode === 'form' &&
    isRecord(request.params._meta) &&
    request.params._meta.codex_approval_kind === 'mcp_tool_call'
  );
}

type McpApprovalDecision = 'accept' | 'accept_session' | 'accept_always' | 'decline' | 'cancel';

function mcpApprovalResponseFromDecision(decision: McpApprovalDecision): McpServerElicitationRequestResponse {
  if (decision === 'decline') {
    return { action: 'decline', content: null, _meta: null };
  }
  if (decision === 'cancel') {
    return cancelledElicitationResponse();
  }
  if (decision === 'accept_session') {
    return { action: 'accept', content: null, _meta: { persist: 'session' } };
  }
  if (decision === 'accept_always') {
    return { action: 'accept', content: null, _meta: { persist: 'always' } };
  }
  return { action: 'accept', content: null, _meta: null };
}

function extractQuotedToolNameFromMcpApprovalMessage(message: string): string | null {
  const marker = 'run tool "';
  const start = message.indexOf(marker);
  if (start < 0) {
    return null;
  }

  const valueStart = start + marker.length;
  const valueEnd = message.indexOf('"', valueStart);
  if (valueEnd <= valueStart) {
    return null;
  }

  const value = message.slice(valueStart, valueEnd).trim();
  return value.length > 0 ? value : null;
}

function resolveMcpToolApprovalToolName(
  params: Extract<McpServerElicitationRequestParams, { mode: 'form' }>,
  meta: Record<string, unknown>,
  fallbackToolTitle: string,
): string {
  return stringFromRecord(meta, 'tool_name')
    ?? extractQuotedToolNameFromMcpApprovalMessage(params.message)
    ?? fallbackToolTitle;
}

function isCleanupCancellationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const message = 'message' in error ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message === 'Request cleared during cleanup';
}

function isTransportDisconnectedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const message = 'message' in error ? (error as { message?: unknown }).message : undefined;
  if (typeof message !== 'string') {
    return false;
  }

  // Server-request responders write back over the same stdio session that
  // carried the original request. During shutdown that transport can disappear
  // before approval cleanup settles, and that teardown should be terminal.
  return (
    message.includes('codex app-server stdio is not writable')
    || message.includes('codex app-server exited')
    || message.includes('codex app-server connection closed unexpectedly')
  );
}

function isExecPolicyDecision(
  decision: CommandExecutionApprovalDecision,
): decision is Extract<CommandExecutionApprovalDecision, { acceptWithExecpolicyAmendment: unknown }> {
  return typeof decision === 'object' && decision !== null && 'acceptWithExecpolicyAmendment' in decision;
}

function normalizeShellApprovalDescription(reason: string | null | undefined): string {
  const trimmed = reason?.trim();
  if (!trimmed) {
    return 'Review this command before continuing.';
  }

  const normalized = trimmed.toLowerCase();
  if (
    normalized === 'codex shell execution requested approval.'
    || normalized === 'interpreter shell execution requested approval.'
  ) {
    return 'Review this command before continuing.';
  }

  return trimmed;
}

function quoteCommandSegment(segment: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(segment)) {
    return segment;
  }
  return `'${segment.replace(/'/g, `'\\''`)}'`;
}

function renderCommandPattern(command: string[]): string {
  if (command.length >= 3) {
    const executable = path.basename(command[0] ?? '').toLowerCase();
    const flag = command[1];
    if ((executable === 'bash' || executable === 'zsh' || executable === 'sh') && (flag === '-lc' || flag === '-c')) {
      return command.slice(2).join(' ').trim();
    }
  }

  return command.map(quoteCommandSegment).join(' ').trim();
}

function extractCommandPattern(command: string | null | undefined): string {
  const trimmed = command?.trim();
  if (!trimmed) {
    return '';
  }

  const shellMatch = trimmed.match(
    /^(?:[^\s]+\/)?(?:bash|zsh|sh)\s+-l?c\s+(?:"([\s\S]*)"|'([\s\S]*)'|(.+))$/,
  );
  const shellBody = shellMatch?.[1] ?? shellMatch?.[2] ?? shellMatch?.[3];
  if (shellBody) {
    return shellBody
      .replace(/\\"/g, '"')
      .replace(/\\'/g, '\'')
      .trim();
  }

  return trimmed;
}

function extractQuotedPath(match: RegExpMatchArray, indices: number[]): string | null {
  for (const index of indices) {
    const value = match[index];
    if (value) {
      return value;
    }
  }
  return null;
}

function isSafeInterpreterCliDiscoveryCommand(commandPattern: string): boolean {
  const normalized = commandPattern.trim();
  if (!normalized) {
    return false;
  }

  return (
    normalized === 'interpreter-app --help'
    || /^interpreter-app\s+tools\s+list(?:\s+\S+)?$/.test(normalized)
    || /^interpreter-app\s+tools\s+find\b/.test(normalized)
    || /^interpreter-app\s+tools\s+\S+\s+\S+\s+--help$/.test(normalized)
    || normalized === 'interpreter-app config --help'
  );
}

function normalizeCommandPathScanValue(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function commandMentionsInstalledRuntimeSkillPath(commandPattern: string): boolean {
  const normalizedPattern = normalizeCommandPathScanValue(commandPattern);
  if (!normalizedPattern) {
    return false;
  }

  const normalizedGlobalSkillsRoot = normalizeCommandPathScanValue(getGlobalSkillsRoot());
  if (normalizedGlobalSkillsRoot && normalizedPattern.includes(normalizedGlobalSkillsRoot)) {
    return true;
  }

  return (
    normalizedPattern.includes('/.openinterpreter/skills/')
    || normalizedPattern.includes('/.codex/skills/')
  );
}

function isDisallowedNativeRuntimeShellCommand(commandPattern: string): boolean {
  const normalized = commandPattern.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /^js_repl(?:\s|$)/.test(normalized);
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const startLength = Math.max(12, Math.floor((maxLength - 1) / 2));
  const endLength = Math.max(8, maxLength - startLength - 1);
  return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
}

function hasExplicitDeclineDecision(decisions: CommandExecutionApprovalDecision[]): boolean {
  return decisions.includes('decline');
}

function commandDecisionLabelWithContext(
  decision: CommandExecutionApprovalDecision,
  decisions: CommandExecutionApprovalDecision[],
): string {
  if (decision === 'accept') {
    return 'Allow once';
  }
  if (decision === 'acceptForSession') {
    return 'Allow for this session';
  }
  if (decision === 'decline') {
    return "Don't allow";
  }
  if (decision === 'cancel') {
    return hasExplicitDeclineDecision(decisions) ? 'Not now' : "Don't allow";
  }
  if (isExecPolicyDecision(decision)) {
    const prefix = renderCommandPattern(decision.acceptWithExecpolicyAmendment.execpolicy_amendment);
    return prefix
      ? `Always allow: ${truncateMiddle(prefix, 34)}`
      : 'Always allow this pattern';
  }

  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return amendment.action === 'allow'
    ? `Always allow ${amendment.host}`
    : `Always block ${amendment.host}`;
}

function commandDecisionDescriptionWithContext(
  decision: CommandExecutionApprovalDecision,
  decisions: CommandExecutionApprovalDecision[],
): string {
  if (decision === 'accept') {
    return 'Run this command one time.';
  }
  if (decision === 'acceptForSession') {
    return 'Run it now and stop asking again during this session.';
  }
  if (decision === 'decline') {
    return 'Block this command.';
  }
  if (decision === 'cancel') {
    return hasExplicitDeclineDecision(decisions)
      ? 'Dismiss this request without running the command.'
      : 'Skip this command and let Interpreter continue.';
  }
  if (isExecPolicyDecision(decision)) {
    const prefix = renderCommandPattern(decision.acceptWithExecpolicyAmendment.execpolicy_amendment);
    return prefix
      ? `Run it now and also allow future commands that start with: ${prefix}`
      : 'Run it now and also allow this command pattern in the future.';
  }

  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return amendment.action === 'allow'
    ? 'Run it now and allow future network requests to this host.'
    : 'Run it now and block future network requests to this host.';
}

function buildCommandDecisionQuestion(
  params: CommandExecutionRequestApprovalParams,
): {
  question: Question;
  decisionByValue: Map<string, CommandExecutionApprovalDecision>;
} | null {
  const decisions = commandApprovalDecisions(params);
  if (decisions.length === 0) {
    return null;
  }

  const decisionByValue = new Map<string, CommandExecutionApprovalDecision>();
  const options = decisions.map((decision, index) => {
    const value = `decision:${index}`;
    decisionByValue.set(value, decision);

    return {
      label: commandDecisionLabelWithContext(decision, decisions),
      value,
      description: commandDecisionDescriptionWithContext(decision, decisions),
      recommended: decision === 'accept',
    };
  });

  const defaultValue = options.find((option) => option.recommended)?.value ?? options[0]?.value;
  if (!defaultValue) {
    return null;
  }

  return {
    question: {
      question: 'How should Interpreter handle this command?',
      options,
      allowOther: false,
      default: defaultValue,
    },
    decisionByValue,
  };
}

function commandApprovalDecisions(
  params: CommandExecutionRequestApprovalParams,
): CommandExecutionApprovalDecision[] {
  const decisions: CommandExecutionApprovalDecision[] = [
    'accept',
    'acceptForSession',
  ];
  if (params.proposedExecpolicyAmendment) {
    decisions.push({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: params.proposedExecpolicyAmendment,
      },
    });
  }
  for (const amendment of params.proposedNetworkPolicyAmendments ?? []) {
    decisions.push({
      applyNetworkPolicyAmendment: {
        network_policy_amendment: amendment,
      },
    });
  }
  decisions.push('decline', 'cancel');
  return decisions;
}

type CommandAccessResolution = 'accept' | 'decline' | 'prompt';

function collectRequestedCommandPaths(
  params: CommandExecutionRequestApprovalParams,
  workspacePath: string | null,
): {
  readPaths: string[];
  writePaths: string[];
} {
  const readPaths = new Set<string>();
  const writePaths = new Set<string>();

  function addPath(target: Set<string>, rawPath: string | null | undefined): void {
    const candidatePath = rawPath ?? params.cwd ?? workspacePath;
    if (!candidatePath) {
      return;
    }

    try {
      target.add(resolvePathWithWorkspace(candidatePath, workspacePath));
    } catch {
      // If the command path is malformed, let Codex's normal approval UI handle it.
    }
  }

  for (const action of params.commandActions ?? []) {
    switch (action.type) {
      case 'read':
        addPath(readPaths, action.path);
        break;
      case 'listFiles':
      case 'search':
        addPath(readPaths, action.path ?? params.cwd ?? workspacePath);
        break;
      case 'unknown':
        break;
    }
  }

  return {
    readPaths: Array.from(readPaths),
    writePaths: Array.from(writePaths),
  };
}

function collectPathsFromCommandPattern(
  commandPattern: string,
  workspacePath: string | null,
): {
  readPaths: string[];
  writePaths: string[];
} {
  const readPaths = new Set<string>();
  const writePaths = new Set<string>();

  function addPath(target: Set<string>, rawPath: string | null): void {
    if (!rawPath) {
      return;
    }

    try {
      target.add(resolvePathWithWorkspace(rawPath, workspacePath));
    } catch {
      // If we cannot safely resolve the path, fall back to prompting.
    }
  }

  const shellReadMatch = commandPattern.match(/^\s*cat\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (shellReadMatch) {
    addPath(readPaths, extractQuotedPath(shellReadMatch, [1, 2, 3]));
  }

  const shellWriteMatch = commandPattern.match(/(?:^|[\s;])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (shellWriteMatch) {
    addPath(writePaths, extractQuotedPath(shellWriteMatch, [1, 2, 3]));
  }

  const powerShellReadMatch = commandPattern.match(/ReadAllText\((?:'([^']+)'|"([^"]+)")\)/i);
  if (powerShellReadMatch) {
    addPath(readPaths, extractQuotedPath(powerShellReadMatch, [1, 2]));
  }

  const powerShellWriteMatch = commandPattern.match(/WriteAllText\((?:'([^']+)'|"([^"]+)")(?:\s*,|\))/i);
  if (powerShellWriteMatch) {
    addPath(writePaths, extractQuotedPath(powerShellWriteMatch, [1, 2]));
  }

  return {
    readPaths: Array.from(readPaths),
    writePaths: Array.from(writePaths),
  };
}

async function resolveCommandAccessPolicy(
  params: CommandExecutionRequestApprovalParams,
  agentId: string | undefined,
): Promise<CommandAccessResolution> {
  if (params.networkApprovalContext || (params.proposedNetworkPolicyAmendments?.length ?? 0) > 0) {
    return 'prompt';
  }

  const workspacePath = getBoundWorkspacePath(params.threadId);
  const commandPattern = extractCommandPattern(params.command);
  const requestedPaths = collectRequestedCommandPaths(params, workspacePath);
  const fallbackPaths = (
    requestedPaths.readPaths.length === 0
    && requestedPaths.writePaths.length === 0
  )
    ? collectPathsFromCommandPattern(commandPattern, workspacePath)
    : { readPaths: [], writePaths: [] };
  const readPaths = requestedPaths.readPaths.length > 0
    ? requestedPaths.readPaths
    : fallbackPaths.readPaths;
  const writePaths = requestedPaths.writePaths.length > 0
    ? requestedPaths.writePaths
    : fallbackPaths.writePaths;

  if (commandMentionsInstalledRuntimeSkillPath(commandPattern)) {
    return 'decline';
  }

  if (isDisallowedNativeRuntimeShellCommand(commandPattern)) {
    return 'decline';
  }

  if (readPaths.length === 0 && writePaths.length === 0) {
    return isSafeInterpreterCliDiscoveryCommand(commandPattern) ? 'accept' : 'prompt';
  }

  if (!workspacePath) {
    return 'decline';
  }

  const requesterId = agentId ?? 'codex-shell-command';

  for (const filePath of readPaths) {
    if (await isTrustedGlobalSkillReadPath(filePath)) {
      return 'decline';
    }

    const allowed = await checkFileAccessPermissionAsync(
      requesterId,
      filePath,
      'read',
      workspacePath,
    );
    if (!allowed) {
      return 'decline';
    }
  }

  let requiresPrompt = false;
  for (const filePath of writePaths) {
    const allowed = await checkFileAccessPermissionAsync(
      requesterId,
      filePath,
      'write',
      workspacePath,
    );
    if (allowed) {
      continue;
    }

    if (!shouldPromptForWorkspaceWriteSync()) {
      return 'decline';
    }

    if (await isOutsideWorkspace(filePath, workspacePath)) {
      return 'decline';
    }

    requiresPrompt = true;
  }

  return requiresPrompt ? 'prompt' : 'accept';
}

function commandDecisionFromResult(
  result: QuestionResult,
  decisionByValue: Map<string, CommandExecutionApprovalDecision>,
): CommandExecutionApprovalDecision {
  const selected = typeof result.answers['0'] === 'string'
    ? decisionByValue.get(result.answers['0'])
    : undefined;
  return selected ?? 'cancel';
}

function buildFileChangeDecisionQuestion(
  params: FileChangeRequestApprovalParams,
): {
  question: Question;
  decisionByValue: Map<string, FileChangeApprovalDecision>;
} {
  const sessionLabel = params.grantRoot
    ? 'Allow this folder for this session'
    : 'Allow these files for this session';
  const sessionDescription = params.grantRoot
    ? 'Approve these changes and stop asking again for this folder during this session.'
    : 'Approve these changes and stop asking again for these files during this session.';
  const options: Array<{ label: string; value: string; description: string; recommended?: boolean }> = [
    {
      label: 'Allow once',
      value: 'decision:0',
      description: 'Make these changes this time.',
      recommended: true,
    },
    {
      label: sessionLabel,
      value: 'decision:1',
      description: sessionDescription,
    },
    {
      label: "Don't allow",
      value: 'decision:2',
      description: 'Skip these changes and let Interpreter continue.',
    },
    {
      label: 'Stop here',
      value: 'decision:3',
      description: 'Skip these changes and stop this run.',
    },
  ];
  const decisionByValue = new Map<string, FileChangeApprovalDecision>([
    ['decision:0', 'accept'],
    ['decision:1', 'acceptForSession'],
    ['decision:2', 'decline'],
    ['decision:3', 'cancel'],
  ]);

  return {
    question: {
      question: 'How should Interpreter handle these file changes?',
      options,
      allowOther: false,
      default: 'decision:0',
    },
    decisionByValue,
  };
}

function fileChangeDecisionFromResult(
  result: QuestionResult,
  decisionByValue: Map<string, FileChangeApprovalDecision>,
): FileChangeApprovalDecision {
  const selected = typeof result.answers['0'] === 'string'
    ? decisionByValue.get(result.answers['0'])
    : undefined;
  return selected ?? 'cancel';
}

async function handleFileChangeApproval(
  request: Extract<ServerRequest, { method: 'item/fileChange/requestApproval' }>,
  respond: ServerRequestResponder,
  deps: CodexServerRequestApprovalDeps,
): Promise<void> {
  const agentId = getBoundAgentId(request.params.threadId);
  const context = {
    threadId: request.params.threadId,
    turnId: request.params.turnId,
    itemId: request.params.itemId,
    message: 'Interpreter wants to make changes to files.',
    description: 'Review these file changes before continuing.',
    reason: request.params.reason ?? null,
    grantRoot: request.params.grantRoot ?? null,
  };
  const questionConfig = buildFileChangeDecisionQuestion(request.params);
  const result = await deps.createQuestion(
    'Apply patch',
    'codex',
    [questionConfig.question],
    context,
    0,
    request.params.itemId,
    agentId,
  );
  respond({ decision: fileChangeDecisionFromResult(result, questionConfig.decisionByValue) });
}

async function handleLegacyApplyPatchApproval(
  request: Extract<ServerRequest, { method: 'applyPatchApproval' }>,
  respond: ServerRequestResponder,
  deps: CodexServerRequestApprovalDeps,
): Promise<void> {
  const agentId = getBoundAgentId(request.params.conversationId);
  const questionConfig = buildFileChangeDecisionQuestion({
    threadId: request.params.conversationId,
    turnId: '',
    itemId: request.params.callId,
    startedAtMs: Date.now(),
    reason: request.params.reason ?? null,
    grantRoot: request.params.grantRoot ?? null,
  });
  const result = await deps.createQuestion(
    'Apply patch',
    'codex',
    [questionConfig.question],
    {
      threadId: request.params.conversationId,
      itemId: request.params.callId,
      message: 'Interpreter wants to make changes to files.',
      description: 'Review these file changes before continuing.',
      reason: request.params.reason,
      grantRoot: request.params.grantRoot,
      fileChanges: request.params.fileChanges,
    },
    0,
    request.params.callId,
    agentId,
  );
  const decision = fileChangeDecisionFromResult(result, questionConfig.decisionByValue);
  respond({
    decision: decision === 'accept'
      ? 'approved'
      : decision === 'acceptForSession'
        ? 'approved_for_session'
        : decision === 'cancel'
          ? 'abort'
          : 'denied',
  });
}

async function handleMcpServerElicitationRequest(
  request: Extract<ServerRequest, { method: 'mcpServer/elicitation/request' }>,
  respond: ServerRequestResponder,
  deps: CodexServerRequestApprovalDeps,
): Promise<void> {
  const agentId = getBoundAgentId(request.params.threadId);
  if (isMcpToolApprovalElicitation(request)) {
    const serverName = request.params.serverName;
    const meta = isRecord(request.params._meta) ? request.params._meta : {};
    const toolTitle =
      stringFromRecord(meta, 'tool_title') ??
      stringFromRecord(meta, 'tool_name') ??
      'MCP tool';
    const toolName = resolveMcpToolApprovalToolName(request.params, meta, toolTitle);
    const approvalToolName = prefixToolName(serverName, toolName);

    const result = await deps.createSessionAwareApproval(
      approvalToolName,
      serverName,
      {
        message: 'Interpreter wants to use an MCP tool.',
        description: 'Review this MCP tool call before continuing.',
        serverId: serverName,
        toolName,
        args: meta.tool_params ?? {},
        threadId: request.params.threadId,
      },
      `Interpreter wants to call ${approvalToolName}.`,
      0,
      undefined,
      agentId,
    );

    respond(mcpApprovalResponseFromDecision(
      result.approved
        ? result.mode === 'session' ? 'accept_session' : 'accept'
        : 'decline',
    ));
    return;
  }

  const questionFlow = buildMcpElicitationQuestionFlow(request.params);

  if (!questionFlow) {
    respond({ action: 'cancel', content: null, _meta: null });
    return;
  }

  const result = await deps.createQuestion(
    questionFlow.toolName,
    request.params.serverName,
    questionFlow.questions,
    questionFlow.context,
    0,
    undefined,
    agentId,
  );

  respond(questionFlow.resolveResult(result));
}

export async function handleCodexServerRequest(
  request: ServerRequest,
  respond: ServerRequestResponder,
  deps: CodexServerRequestApprovalDeps = defaultDeps(),
): Promise<void> {
  try {
    if (isCommandExecutionApproval(request)) {
      const agentId = getBoundAgentId(request.params.threadId);

      if (isViewImageCommandApproval(request)) {
        const reason = request.params.reason;
        const path = typeof reason === 'string' ? reason.slice('view_image: '.length) : undefined;

        if (path && await deps.shouldAutoApproveViewImagePath?.(path)) {
          respond({ decision: 'accept' });
          return;
        }

        const approved = await deps.createApproval(
          'view_image',
          'main-agent-server',
          {
            path,
            reason,
            threadId: request.params.threadId,
            warning: 'Interpreter wants to view an image file.',
            description: 'Interpreter needs permission to view this image.',
            command: request.params.command,
            cwd: request.params.cwd,
            itemId: request.params.itemId,
          },
          0,
          getCommandExecutionUiToolCallId(request),
          agentId,
        );

        if (approved) {
          respond({ decision: 'accept' });
        } else {
          respond({ decision: 'decline' });
        }
        return;
      }

      const accessDecision = await resolveCommandAccessPolicy(request.params, agentId);
      if (accessDecision === 'accept') {
        respond({ decision: 'accept' });
        return;
      }
      if (accessDecision === 'decline') {
        respond({ decision: 'decline' });
        return;
      }

      const context = {
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.params.itemId,
        approvalId: request.params.approvalId ?? null,
        message: 'Interpreter wants to run a command.',
        description: normalizeShellApprovalDescription(request.params.reason),
        command: request.params.command,
        cwd: request.params.cwd,
        reason: request.params.reason,
        commandActions: request.params.commandActions ?? [],
        availableDecisions: commandApprovalDecisions(request.params),
        proposedExecpolicyAmendment: request.params.proposedExecpolicyAmendment ?? null,
        proposedNetworkPolicyAmendments: request.params.proposedNetworkPolicyAmendments ?? [],
        networkApprovalContext: request.params.networkApprovalContext ?? null,
      };
      const questionConfig = buildCommandDecisionQuestion(request.params);

      if (questionConfig) {
        const result = await deps.createQuestion(
          'Shell command',
          'codex',
          [questionConfig.question],
          context,
          0,
          getCommandExecutionUiToolCallId(request),
          agentId,
        );

        respond({ decision: commandDecisionFromResult(result, questionConfig.decisionByValue) });
        return;
      }

      const approved = await deps.createApproval(
        'Shell command',
        'codex',
        context,
        0,
        getCommandExecutionUiToolCallId(request),
        agentId,
      );

      respond({ decision: approved ? 'accept' : 'decline' });
      return;
    }

    if (isLegacyExecCommandApproval(request)) {
      const agentId = getBoundAgentId(request.params.conversationId);
      const approved = await deps.createApproval(
        'Shell command',
        'codex',
        {
          threadId: request.params.conversationId,
          itemId: request.params.callId,
          approvalId: request.params.approvalId,
          message: 'Interpreter wants to run a command.',
          description: normalizeShellApprovalDescription(request.params.reason),
          command: request.params.command,
          cwd: request.params.cwd,
          reason: request.params.reason,
          commandActions: request.params.parsedCmd ?? [],
        },
        0,
        getLegacyExecUiToolCallId(request),
        agentId,
      );

      respond({ decision: approved ? 'approved' : 'denied' });
      return;
    }

    if (isFileChangeApproval(request)) {
      await handleFileChangeApproval(request, respond, deps);
      return;
    }

    if (isMcpServerElicitationRequest(request)) {
      await handleMcpServerElicitationRequest(request, respond, deps);
      return;
    }

    if (isLegacyApplyPatchApproval(request)) {
      await handleLegacyApplyPatchApproval(request, respond, deps);
      return;
    }

    // Ignore server requests that are not mapped to approval manager yet.
  } catch (error) {
    // Cleanup already decided this request is over. Responding after that can
    // race app-server teardown and turn a normal quit into a transport error.
    if (isCleanupCancellationError(error)) {
      return;
    }

    if (!isTransportDisconnectedError(error)) {
      deps.onError(error);
    }

    try {
      respond(isMcpServerElicitationRequest(request)
        ? cancelledElicitationResponse()
        : deniedDecisionForRequest(request));
    } catch (respondError) {
      if (!isTransportDisconnectedError(respondError)) {
        deps.onError(respondError);
      }
    }
  }
}

export function attachCodexServerRequestApprovals(
  client: CodexServerRequestClient,
  deps: CodexServerRequestApprovalDeps = defaultDeps(),
): void {
  if (attachedClients.has(client)) {
    return;
  }

  attachedClients.add(client);
  client.subscribeServerRequests((request, respond) => {
    void handleCodexServerRequest(request, respond, deps);
  });
}
