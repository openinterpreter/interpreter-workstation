import type { StructuredScreenSnapshot, ToolCall, ToolExecutionResult } from './ports.js';
import type { OverlayUserAttachment } from './ipc.js';

export interface OverlayRunStartMessage {
  type: 'run.start';
  conversationId: string;
  userText: string;
  systemAddendum?: string;
  model?: string;
  computerEnvironment: 'windows' | 'mac' | 'linux';
  initialSnapshot?: StructuredScreenSnapshot;
  initialImageCapture?: {
    screenshotId: string;
    screenshotBase64: string;
  };
  /**
   * User-supplied attachments from the overlay composer (pasted/dropped
   * images). Emitted to the LLM as vision inputs alongside `userText` and
   * the screen-capture `initialImageCapture`.
   */
  userAttachments?: OverlayUserAttachment[];
}

export interface OverlayToolResultMessage {
  type: 'tool.result';
  seq: number;
  result: ToolExecutionResult;
}

export interface OverlayRunCancelMessage {
  type: 'run.cancel';
}

export type OverlayAgentClientMessage =
  | OverlayRunStartMessage
  | OverlayToolResultMessage
  | OverlayRunCancelMessage;

export interface OverlayToolCallMessage {
  type: 'tool.call';
  seq: number;
  tool: ToolCall;
}

export interface OverlayActPreviewMessage {
  type: 'act.preview';
  batchId: string;
  turn: number;
  actions: Array<{
    seq: number;
    tool: ToolCall;
  }>;
}

export interface OverlayRunCompletedMessage {
  type: 'run.completed';
  finalText: string;
}

export interface OverlayRunErrorMessage {
  type: 'run.error';
  message: string;
}

export interface OverlayDebugTranscriptMessage {
  type: 'debug.transcript';
  event: {
    kind:
      | 'llm.request'
      | 'llm.response'
      | 'conversation.message.append'
      | 'tool.dispatch'
      | 'tool.result';
    turn: number;
    attempt?: number;
    atMs?: number;
    durationMs?: number;
    payload: unknown;
  };
}

export type OverlayAgentServerMessage =
  | OverlayActPreviewMessage
  | OverlayToolCallMessage
  | OverlayRunCompletedMessage
  | OverlayRunErrorMessage
  | OverlayDebugTranscriptMessage;
