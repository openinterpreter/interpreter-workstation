/**
 * Unified Question/Approval Types
 *
 * The approval system is built on a general-purpose question system.
 * Simple approve/deny requests are just the simplest case:
 * - Question: "Do you approve this action?"
 * - Options: [Approve, Deny]
 * - Response: boolean
 *
 * `createApproval()` is a convenience wrapper around `createQuestion()`.
 *
 * NOTE(approval-flow): Start the approval trace here when changing request
 * shape. `server/approvalManager.ts` owns the central queue; simple
 * approve/deny prompts are not a second protocol, they are one-option-index
 * `QuestionResult` responses.
 */

// ============================================================================
// QUESTION TYPES
// ============================================================================

export interface QuestionOption {
  /** Display text (e.g., "Use TypeScript") */
  label: string;
  /** Machine value returned to model (defaults to label if not provided) */
  value: string;
  /** Optional explanation */
  description?: string;
  /** If true, show visual indicator that model recommends this */
  recommended?: boolean;
}

export interface Question {
  /** The question text */
  question: string;
  /** Short label like "Language" (max 12 chars) */
  header?: string;
  /** 2+ options */
  options: QuestionOption[];
  /** Allow multiple selections (default: false) */
  multiSelect?: boolean;
  /** Show "Other" option with text input (default: false) */
  allowOther?: boolean;
  /** Model's default selection (value or array of values for multiSelect) */
  default?: string | string[];
  /** If true, shows countdown timer that auto-selects defaults */
  optional?: boolean;
}

export type ApprovalOwnerKind =
  | 'normal-agent'
  | 'overlay-agent'
  | 'hidden-agent'
  | 'extension-action'
  | 'cli';

export interface AgentPermissionOwnerReference {
  approvalOwnerKind: ApprovalOwnerKind;
  agentId: string | null;
  threadId?: string;
  windowSessionKey: string | null;
  workspacePath: string | null;
  toolProfileId?: string;
}

export interface AgentPermissionIdentity {
  agentId: string | null;
  threadId?: string;
  windowSessionKey: string | null;
  workspacePath: string | null;
  allowedToolNames?: string[];
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
}

export interface ApprovalOwnerSnapshot {
  approvalOwnerKind: ApprovalOwnerKind;
  identity: AgentPermissionIdentity;
  displayName: string;
  color: string;
  capturedAt: number;
}

export interface QuestionRequest {
  id: string;
  toolName: string;
  serverId: string;
  /** Always present - unified model */
  questions: Question[];
  /** Optional metadata to display (e.g., tool args) */
  context?: any;
  timestamp: number;
  toolCallId?: string;
  /** Optional stable key for replacing an evolving pending card from the same owner/tool */
  replacementKey?: string;
  /** Explicit flag for simple approve/deny, no detection needed */
  isSimpleApproval?: boolean;
  /** The agent that triggered this request */
  agentId?: string;
  /** Snapshot of the owner identity captured when the request was queued */
  owner?: ApprovalOwnerSnapshot;
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

/** Response is always a map of question index to answer(s) */
export type QuestionResponse = Record<string, string | string[]>;

/** Full result with metadata - this is what createQuestion() returns */
export interface QuestionResult {
  answers: QuestionResponse;
  /** True if user clicked Skip */
  skipped?: boolean;
  /** True if auto-timeout selected defaults */
  timedOut?: boolean;
  /** How long the timeout was (if timed out) */
  timeoutSeconds?: number;
  /** For session-based approvals: 'once' = single use, 'session' = remember for this session */
  approvalMode?: 'once' | 'session';
  /** True when a newer pending request replaced this one before the user answered */
  superseded?: boolean;
  /** The newer request id when superseded is true */
  supersededBy?: string;
}

// ============================================================================
// INTERNAL TYPES (for ApprovalManager)
// ============================================================================

/** Internal type with promise callbacks - resolves with full QuestionResult */
export interface QuestionRequestInternal extends QuestionRequest {
  ownerWindowSessionKey?: string | null;
  ownerWorkspacePath?: string | null;
  resolve: (result: QuestionResult) => void;
  reject: (error: Error) => void;
}

// ============================================================================
// IPC REQUEST/RESPONSE TYPES
// ============================================================================

export interface ApprovalRespondRequest {
  id: string;
  result: QuestionResult;
}

export interface ApprovalRespondResponse {
  success: boolean;
  error?: string;
}
