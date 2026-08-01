import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AgentTabCompletionEvent } from '../../../server/agentTabManager';
import { startAgentTask } from '../../../server/agentTaskService';
import { callHiddenAgentTool } from '../../../server/tools/builtin-tools/interpreter-overlay/hiddenAgentTool';
import type { ToolCallResponse } from '../../../server/tools/toolTypes';
import { getCustomInstructions } from '../../../server/configStore';
import { broadcastEvent } from '../../../server/handlers/broadcast';
import {
  overlaySessionManager,
  type OverlaySessionCreateOptions,
  type OverlaySessionRecord,
} from '../../../server/overlaySessionManager';
import { getCurrentWorkspace } from '../../../server/utils/workspace';
import { profileToModelConfig, type Profile } from '../../../shared/types/profile';
import type { RunEngine } from '../runtime/core/run-engine.js';
import { IPC_CHANNELS } from '../../../electron/ipc/registry';
import type { Capture } from '../runtime/infra/capture.js';
import { appendOverlayPromptExtras } from './overlay-prompt-extras.js';
import { DESKTOP_CUA_ALLOWED_TOOL_NAMES } from './overlay-agent-tools.js';
import { buildAdvancedVoiceDelegatedToolResponse } from '../shared/advanced-voice-tool-response.js';
import {
  advancedVoiceMimeTypeForPath,
  readAdvancedVoiceTestAudioFromEnv,
} from './advanced-voice-test-audio.js';
import {
  type AdvancedVoiceSessionKind,
  buildAdvancedVoiceCreateCallRequestBody,
  postAdvancedVoiceCreateCall,
} from '../shared/advanced-voice-create-call.js';
import { parseOnboardingVoiceInterviewToolArguments } from '../shared/onboarding-voice-interview.js';
import {
  buildOverlayBuiltinToolIdentity,
  buildOverlayToolSessionIdentity,
} from './overlay-tool-identity.js';
import { buildAdvancedVoiceOverlayContextInstructions } from '../shared/advanced-voice-context.js';
import { buildAdvancedVoiceDesktopAgentSystemPrompt } from '../shared/advanced-voice-desktop-agent-prompt.js';
import { buildAdvancedVoiceNoTargetLaunchMessageBody } from '../shared/advanced-voice-no-target.js';
import type { ComputerBatchParams, ToolExecutionResult } from '../shared/ports.js';
import type { Bounds, DisplayInfo } from '../shared/types.js';
import type {
  OverlayContextItem,
  OverlayRegionContextItem,
  OverlayState,
  OverlayUserAttachment,
} from '../shared/ipc.js';
import {
  resolveOverlayModelTaskProfileIds,
  type InterpreterOverlaySettings,
} from '../shared/settings.js';
import { REALTIME_COMPUTER_BATCH_TOOL_NAME } from '../../../shared/types/overlayToolCatalog';
import {
  callOverlayComputerBatchBridgeTool,
  formatOverlaySelectedTargetBatchResult,
} from './overlay-computer-batch-bridge.js';
import { formatTouchedWindowDiff } from '../shared/touched-window-diff.js';
import {
  buildOverlayWholeComputerStateText,
  getTargetContextItem,
  type OverlayWholeComputerState,
} from '../shared/text-controller.js';
import { buildOverlaySelectedContextToolArgs } from './overlay-selected-context-tool-args.js';
import { committedTargetWindowClosedMessage } from './attached-target-context.js';
import {
  appendOverlayHiddenAgentReportInstruction,
  buildOverlayControllerVoicePromptText,
  OVERLAY_HIDDEN_AGENT_REPORT_CONTRACT,
} from './overlay-controller-prompt.js';
import {
  buildReferenceContextPrompt,
  createOverlayAgentId,
  createOverlayCallerToken,
  formatOverlayBounds,
  getAdvancedVoiceAgentAllowedToolNames,
  getErrorMessage,
  getInterpreterOverlayAccessToken,
  prependOverlayMentions,
  queryOverlayAttachments,
  type InterpreterOverlayAdvancedVoiceDebugState,
  type InterpreterOverlayCapturedContext,
} from './service.js';

/**
 * Realtime tool outputs travel back to the model over the WebRTC data
 * channel, which closes the whole session when a single message exceeds the
 * SCTP send limit (~256KiB). Cap the output well below that so an oversized
 * tool result degrades to a truncated message instead of killing the call.
 */
export const ADVANCED_VOICE_TOOL_OUTPUT_MAX_CHARS = 60_000;

export function capAdvancedVoiceToolOutput(output: string): string {
  if (output.length <= ADVANCED_VOICE_TOOL_OUTPUT_MAX_CHARS) {
    return output;
  }
  return `${output.slice(0, ADVANCED_VOICE_TOOL_OUTPUT_MAX_CHARS)}\n[Tool output truncated at ${ADVANCED_VOICE_TOOL_OUTPUT_MAX_CHARS} characters. Act on the content above; reread context if you need more.]`;
}

export interface AdvancedVoiceControllerHost {
  baseUrl: string;
  overlayApprovalAgentIds: Set<string>;
  getOverlayState(): OverlayState;
  getEffectiveSettings(): InterpreterOverlaySettings;
  getEngine(): RunEngine | null;
  getCapture(): Capture | null;
  getInteractionDisplay(): DisplayInfo | null;
  setInteractionDisplay(display: DisplayInfo): void;
  setScopeBounds(bounds: Bounds): void;
  getLastRemovedTargetContext(): OverlayRegionContextItem | null;
  getActiveAttachedSessionId(): string | null;
  getVoiceRecordingStartedAt(): number | null;
  setVoiceRecordingStartedAt(value: number | null): void;
  setVoiceInputUsed(value: boolean): void;
  send(partial: Partial<OverlayState>): void;
  beginAdvancedVoicePlanningVisual(): Promise<void>;
  endAdvancedVoicePlanningVisual(): void;
  trackOverlayEvent(event: string, data?: Record<string, unknown>): void;
  cancelVoiceTimer(): void;
  startGlobalApprovalPoller(): void;
  stopGlobalApprovalPoller(): void;
  onAdvancedVoiceStopped(sessionKind: AdvancedVoiceSessionKind): void;
  waitForMatchingTargetContextHydration(bounds: Bounds): Promise<void>;
  captureContextForScope(options: {
    displayId?: string | null;
    scopeBounds?: Bounds | null;
    persistScreenshotToTmp?: boolean;
    targetContext?: OverlayRegionContextItem | null;
    targetWindowSessionKey?: string | null;
  }): Promise<InterpreterOverlayCapturedContext>;
  buildOverlayWholeComputerState(input: {
    workspacePath: string | null;
    targetWindowSessionKey: string | null;
    targetContext: OverlayRegionContextItem | null;
    contextItems: OverlayContextItem[];
  }): Promise<OverlayWholeComputerState>;
  ensureExecutableContextForTarget(
    targetContext: OverlayRegionContextItem,
  ): Promise<OverlayRegionContextItem>;
  createAgentToolSession(
    options: Omit<OverlaySessionCreateOptions, 'displayId' | 'scopeBoundsDIP' | 'initialContext'> & {
      targetContext?: OverlayRegionContextItem | null;
    },
  ): Promise<OverlaySessionRecord>;
  resolveOverlayTargetWindow(
    workspacePath: string | null,
    targetWindowSessionKey: string | null,
  ): Promise<{
    workspacePath: string | null;
    targetWindowSessionKey: string;
    targetWindowId: number;
  }>;
  resolveHiddenAgentProfile(): Promise<Profile>;
  resolveOverlayAgentProfileByModelSetting(requested: string, missingMessage: string): Promise<Profile>;
  persistOverlayUserAttachmentMentions(userAttachments: OverlayUserAttachment[]): Promise<string[]>;
  buildNormalAgentAttachmentsFromContextItems(contextItems: OverlayContextItem[]): OverlayUserAttachment[];
  buildOverlayLaunchMessage(
    prompt: string,
    initialContext: Pick<
      InterpreterOverlayCapturedContext,
      'formattedText' | 'screenshotPath' | 'targetIdentity' | 'currentSelectionContext'
    >,
    targetContext: OverlayRegionContextItem | null,
    attachmentMentions?: string[],
  ): string;
  buildOverlaySystemPrompt(session: OverlaySessionRecord): Promise<string>;
}

export class AdvancedVoiceController {
  isAdvancedVoiceInputActive = false;
  advancedVoiceAgent: {
    agentId: string;
    callerToken: string;
    threadId: string | null;
    lastAssistantText: string;
    lastUserMessageAt: number | null;
  } | null = null;
  advancedVoiceDebug: InterpreterOverlayAdvancedVoiceDebugState = {
    active: false,
    startedAt: null,
    stoppedAt: null,
    createCallRequestedAt: null,
    createCallSucceededAt: null,
    createCallError: null,
    testAudioRequestedAt: null,
    testAudioPath: null,
    testAudioBytes: null,
    audioEvents: [],
    toolCalls: [],
  };
  private advancedVoiceComputerBatchGeneration = 0;
  private advancedVoiceSpeechInputOpen = false;
  private advancedVoicePlanningVisualActive = false;
  private advancedVoiceAgentTaskQueue: Promise<void> = Promise.resolve();
  private advancedVoiceAgentTaskInFlight = 0;
  private advancedVoicePendingDelegatedRequests = new Set<string>();

  constructor(private readonly host: AdvancedVoiceControllerHost) {}

  readonly createCallIpcHandler = async (
    event: unknown,
    request: { offerSdp: string; sessionKind?: AdvancedVoiceSessionKind },
  ): Promise<{ answerSdp: string; callId: string | null }> =>
    await this.handleAdvancedVoiceCreateCall(event, request);

  readonly toolCallIpcHandler = async (
    event: unknown,
    request: { name: string; argumentsJson: string },
  ): Promise<{ output: string; followUpUserMessage?: string; requestResponse?: boolean }> => {
    const response = await this.handleAdvancedVoiceToolCall(event, request);
    return { ...response, output: capAdvancedVoiceToolOutput(response.output) };
  };

  readonly testAudioIpcHandler = async (): Promise<{
    dataUrl?: string;
    mimeType?: string;
    segments?: Array<{ dataUrl: string; mimeType: string; delayAfterMs?: number }>;
  } | null> => await this.handleAdvancedVoiceTestAudio();

  readonly audioEventIpcHandler = async (
    event: unknown,
    audioEvent: { type?: unknown; segmentIndex?: unknown },
  ): Promise<void> => await this.handleAdvancedVoiceAudioEvent(event, audioEvent);

  private get overlayState(): OverlayState {
    return this.host.getOverlayState();
  }

  private get effectiveSettings(): InterpreterOverlaySettings {
    return this.host.getEffectiveSettings();
  }

  private get engine(): RunEngine | null {
    return this.host.getEngine();
  }

  private get capture(): Capture | null {
    return this.host.getCapture();
  }

  private get baseUrl(): string {
    return this.host.baseUrl;
  }

  resetAdvancedVoiceDebug(): void {
    this.advancedVoiceDebug = {
      active: false,
      startedAt: null,
      stoppedAt: null,
      createCallRequestedAt: null,
      createCallSucceededAt: null,
      createCallError: null,
      testAudioRequestedAt: null,
      testAudioPath: null,
      testAudioBytes: null,
      audioEvents: [],
      toolCalls: [],
    };
  }

  startAdvancedVoiceInput(
    source: 'hotkey' | 'button',
    sessionKind: AdvancedVoiceSessionKind = 'advanced_voice',
  ): void {
    if (this.overlayState.mode !== 'input') {
      return;
    }

    this.host.cancelVoiceTimer();
    this.resetAdvancedVoiceDebug();
    this.advancedVoiceAgent = null;
    this.advancedVoiceComputerBatchGeneration = 0;
    this.advancedVoiceSpeechInputOpen = false;
    this.advancedVoiceAgentTaskQueue = Promise.resolve();
    this.advancedVoicePendingDelegatedRequests.clear();
    this.host.overlayApprovalAgentIds.clear();
    this.host.startGlobalApprovalPoller();
    this.advancedVoiceDebug.active = true;
    this.advancedVoiceDebug.startedAt = Date.now();
    this.host.setVoiceInputUsed(true);
    this.isAdvancedVoiceInputActive = true;
    this.host.setVoiceRecordingStartedAt(Date.now());
    this.host.trackOverlayEvent('overlay_advanced_voice_started', {
      source,
      agentModel: this.effectiveSettings.advancedVoiceModel,
      workspacePath: this.effectiveSettings.advancedVoiceWorkspacePath ?? 'Desktop',
    });
    this.host.send({
      mode: 'idle',
      action: null,
      ghosts: [],
      transcript: '',
      isRecording: true,
      amplitude: 0,
      advancedVoiceActive: true,
      advancedVoiceSessionKind: sessionKind,
      advancedVoiceCompletionNotice: null,
      globalApproval: null,
      pill: { kind: 'hidden' },
    });
  }

  stopAdvancedVoiceInput(): void {
    const sessionKind = this.overlayState.advancedVoiceSessionKind;
    const overlayStillShowsAdvancedVoice =
      this.overlayState.advancedVoiceActive === true || this.overlayState.isRecording === true;
    if (!this.isAdvancedVoiceInputActive && !overlayStillShowsAdvancedVoice) {
      return;
    }

    const durationMs =
      this.host.getVoiceRecordingStartedAt() === null ? undefined : Date.now() - this.host.getVoiceRecordingStartedAt()!;
    console.log('[InterpreterOverlay] stopping advanced voice input', {
      serviceActive: this.isAdvancedVoiceInputActive,
      overlayAdvancedVoiceActive: this.overlayState.advancedVoiceActive,
      overlayIsRecording: this.overlayState.isRecording,
      durationMs,
    });
    this.host.trackOverlayEvent('overlay_advanced_voice_finished', { durationMs });
    this.advancedVoicePlanningVisualActive = false;
    this.isAdvancedVoiceInputActive = false;
    this.advancedVoiceComputerBatchGeneration += 1;
    this.advancedVoiceSpeechInputOpen = false;
    this.engine?.endAttachedToolSession();
    this.advancedVoiceDebug.active = false;
    this.advancedVoiceDebug.stoppedAt = Date.now();
    this.host.setVoiceRecordingStartedAt(null);
    const keepGlobalApprovalBridge =
      this.advancedVoiceAgentTaskInFlight > 0
      || this.advancedVoicePendingDelegatedRequests.size > 0
      || this.overlayState.globalApproval !== null;
    if (!keepGlobalApprovalBridge) {
      this.host.overlayApprovalAgentIds.clear();
      this.host.stopGlobalApprovalPoller();
    }
    this.host.send({
      mode: 'idle',
      isRecording: false,
      amplitude: 0,
      advancedVoiceActive: false,
      advancedVoiceSessionKind: 'advanced_voice',
      globalApproval: keepGlobalApprovalBridge ? this.overlayState.globalApproval : null,
      pill: { kind: 'hidden' },
    });
    this.host.onAdvancedVoiceStopped(sessionKind);
  }

  private getAdvancedVoiceWorkspacePath(): string {
    const configured = this.effectiveSettings.advancedVoiceWorkspacePath?.trim();
    if (configured) {
      return configured;
    }
    return path.join(os.homedir(), 'Desktop');
  }

  private async buildAdvancedVoiceContextInstructions(): Promise<string[]> {
    const targetContext = getTargetContextItem(this.overlayState.contextItems);
    if (targetContext) {
      // The context packet must carry the committed selected-context refs —
      // the only element ids computer_batch accepts — so wait for the
      // in-flight target hydration before building it. Do not append any
      // other element-id source: a second ref namespace here previously made
      // the realtime model submit ids the executor rejects.
      await this.host.waitForMatchingTargetContextHydration(targetContext.bounds);
    }
    return buildAdvancedVoiceOverlayContextInstructions(this.overlayState.contextItems);
  }

  private async buildAdvancedVoiceInstructions(): Promise<string> {
    const contextInstructionLines = await this.buildAdvancedVoiceContextInstructions();
    // Selected-context evidence for the harness, mirroring the typed
    // [FAST_PATH] loop-start marker: the packet size and the committed
    // selectable ref ids the voice session instructions carry.
    const targetContext = getTargetContextItem(this.overlayState.contextItems);
    const packetRefIds = targetContext
      ? (targetContext.snapshot.selectableRefs.length > 0
          ? targetContext.snapshot.selectableRefs
          : targetContext.selectableElements ?? []
        ).map((ref) => ref.id)
      : [];
    console.log('[InterpreterOverlay][AdvancedVoice] session-instructions packet', {
      iso: new Date().toISOString(),
      packetChars: contextInstructionLines.join('\n').length,
      packetRefIdCount: packetRefIds.length,
      packetRefIds: packetRefIds.slice(0, 400).join(','),
    });
    const baseInstructions = buildOverlayControllerVoicePromptText({
      contextInstructionLines,
      wholeComputerStateText: buildOverlayWholeComputerStateText(await this.host.buildOverlayWholeComputerState({
        workspacePath: getCurrentWorkspace(),
        targetWindowSessionKey: null,
        targetContext: getTargetContextItem(this.overlayState.contextItems),
        contextItems: this.overlayState.contextItems,
      })),
    });
    return appendOverlayPromptExtras(baseInstructions, {
      customInstructions: await getCustomInstructions(),
    });
  }

  private async buildOnboardingVoiceInterviewInstructions(): Promise<string> {
    const baseInstructions = [
      'You are running the Interpreter onboarding voice interview.',
      'Ask short follow-up questions until you can fill these exact review fields: modelsUsed, aiUseToday, and currentSetup.',
      'modelsUsed means the AI models or AI systems the user says they use now.',
      'aiUseToday means how the user says they use AI today.',
      'currentSetup means the user\'s current AI apps, CLIs, local models, API keys, or workflow setup.',
      'When the fields are clear enough, call complete_onboarding_voice_interview with concise user-reviewable text for all three fields.',
      'Do not mention desktop control, screen context, hidden agents, attachments, or tools.',
      'Do not invent details the user did not say.',
    ].join('\n');
    return appendOverlayPromptExtras(baseInstructions, {
      customInstructions: await getCustomInstructions(),
    });
  }

  private async buildAdvancedVoiceCreateCallInstructions(
    sessionKind: AdvancedVoiceSessionKind,
  ): Promise<string> {
    if (sessionKind === 'onboarding_voice_interview') {
      return this.buildOnboardingVoiceInterviewInstructions();
    }
    return this.buildAdvancedVoiceInstructions();
  }

  private buildAdvancedVoiceNoTargetLaunchMessage(
    message: string,
    initialContext: Pick<InterpreterOverlayCapturedContext, 'formattedText' | 'screenshotPath'> | null,
    attachmentMentions: string[],
  ): string {
    const observedTarget = this.host.getLastRemovedTargetContext();
    const formattedText = initialContext?.formattedText.trim() ?? '';
    const windowName = /^<window name="([^"]+)"/.exec(formattedText)?.[1] ?? null;

    return prependOverlayMentions(
      buildAdvancedVoiceNoTargetLaunchMessageBody({
        message,
        observedForegroundApp: observedTarget
          ? (observedTarget.appIconLabel ?? observedTarget.label.replace(/^Active app:\s*/i, ''))
          : null,
        observedContextLabel: observedTarget?.label ?? null,
        observedBounds: observedTarget ? formatOverlayBounds(observedTarget.bounds) : null,
        observedWindowName: windowName,
        initialScreenshotPath: initialContext?.screenshotPath ?? null,
        initialAccessibilityText: formattedText,
      }),
      attachmentMentions.filter(
        (mention): mention is string => Boolean(mention),
      ),
    );
  }

  private normalizeAdvancedVoiceAgentMessage(message: string): string {
    return message
      .replace(/^send\s+this\s+to\s+(?:the\s+)?agent\s+exactly\s*[:.]?\s*/i, '')
      .trim();
  }

  private getLastAssistantTextFromMessages(messages: any[]): string {
    const assistantMessages = messages
      .filter((candidate: any) => candidate?.role === 'assistant')
      .map((candidate: any) => String(candidate.content ?? candidate.text ?? ''))
      .filter(Boolean);
    return assistantMessages[assistantMessages.length - 1] ?? '';
  }

  handleAgentTabCompletion(event: AgentTabCompletionEvent): void {
    const activeAgent = this.advancedVoiceAgent;
    if (!activeAgent) {
      return;
    }
    if (event.agentId !== activeAgent.agentId || event.callerToken !== activeAgent.callerToken) {
      return;
    }
    if (event.requestId) {
      this.advancedVoicePendingDelegatedRequests.delete(event.requestId);
    }

    const lastAssistantText = event.error
      ? `I ran into an error: ${event.error}`
      : this.getLastAssistantTextFromMessages(event.messages);
    this.advancedVoiceAgent = {
      ...activeAgent,
      threadId: event.threadId ?? activeAgent.threadId,
      lastAssistantText,
    };

    this.stopAdvancedVoiceApprovalBridgeIfIdle();
    if (!this.isAdvancedVoiceInputActive || !lastAssistantText.trim()) {
      return;
    }
    this.host.send({
      advancedVoiceCompletionNotice: {
        id: randomUUID(),
        at: Date.now(),
        threadId: this.advancedVoiceAgent.threadId,
      },
    });
  }

  stopAdvancedVoiceApprovalBridgeIfIdle(): void {
    if (
      this.isAdvancedVoiceInputActive
      || this.advancedVoiceAgentTaskInFlight > 0
      || this.advancedVoicePendingDelegatedRequests.size > 0
      || this.overlayState.globalApproval
    ) {
      return;
    }
    this.host.overlayApprovalAgentIds.clear();
    this.host.stopGlobalApprovalPoller();
  }

  private handleAdvancedVoiceCreateCall = async (
    _event: unknown,
    request: { offerSdp: string; sessionKind?: AdvancedVoiceSessionKind },
  ): Promise<{ answerSdp: string; callId: string | null }> => {
    this.advancedVoiceDebug.createCallRequestedAt = Date.now();
    this.advancedVoiceDebug.createCallError = null;
    if (process.env.INTERPRETER_OVERLAY_DISABLE_ADVANCED_VOICE_CREATE_CALL === 'true') {
      const message = 'Advanced voice create-call is disabled by the test environment.';
      this.advancedVoiceDebug.createCallError = message;
      throw new Error(message);
    }
    const token = await getInterpreterOverlayAccessToken();
    const sessionKind = request.sessionKind ?? 'advanced_voice';
    try {
      const result = await postAdvancedVoiceCreateCall({
        fetchFn: fetch,
        baseUrl: this.baseUrl,
        bearerToken: token,
        body: buildAdvancedVoiceCreateCallRequestBody({
          offerSdp: request.offerSdp,
          instructions: await this.buildAdvancedVoiceCreateCallInstructions(sessionKind),
          agentModel: this.effectiveSettings.advancedVoiceModel,
          workspacePath: this.getAdvancedVoiceWorkspacePath(),
          sessionKind,
        }),
      });
      this.advancedVoiceDebug.createCallSucceededAt = Date.now();
      return result;
    } catch (error) {
      this.advancedVoiceDebug.createCallError = getErrorMessage(error);
      throw error;
    }
  };

  private handleAdvancedVoiceToolCall = async (
    _event: unknown,
    request: { name: string; argumentsJson: string },
  ): Promise<{ output: string; followUpUserMessage?: string; requestResponse?: boolean }> => {
    const toolCallDebug = {
      name: request.name,
      receivedAt: Date.now(),
      argumentsLength: request.argumentsJson.length,
      argumentsPreview: request.argumentsJson.slice(0, 4000),
      resultPreview: undefined as string | undefined,
      error: undefined as string | undefined,
    };
    this.advancedVoiceDebug.toolCalls.push(toolCallDebug);
    if (request.name === 'complete_onboarding_voice_interview') {
      if (this.overlayState.advancedVoiceSessionKind !== 'onboarding_voice_interview') {
        const output = 'Error: complete_onboarding_voice_interview is only available during onboarding voice interview sessions.';
        toolCallDebug.error = output;
        toolCallDebug.resultPreview = output;
        return { output, requestResponse: false };
      }
      try {
        const result = parseOnboardingVoiceInterviewToolArguments(request.argumentsJson);
        broadcastEvent(IPC_CHANNELS.INTERPRETER_OVERLAY_ONBOARDING_VOICE_INTERVIEW_COMPLETED, result);
        this.stopAdvancedVoiceInput();
        const output = JSON.stringify({ status: 'completed' });
        toolCallDebug.resultPreview = output;
        return { output, requestResponse: false };
      } catch (error) {
        const output = `Error: ${getErrorMessage(error)}`;
        toolCallDebug.error = getErrorMessage(error);
        toolCallDebug.resultPreview = output;
        return { output, requestResponse: false };
      }
    }

    if (request.name === 'send_message_to_agent') {
      const speakingBlock = this.getAdvancedVoiceSpeakingBlockResponse(request.name);
      if (speakingBlock) {
        toolCallDebug.resultPreview = speakingBlock.output.slice(0, 4000);
        return speakingBlock;
      }
      const args = JSON.parse(request.argumentsJson || '{}') as { message?: unknown };
      const message = typeof args.message === 'string'
        ? this.normalizeAdvancedVoiceAgentMessage(args.message)
        : '';
      if (!message) {
        return { output: 'No message was provided.' };
      }
      console.log('[InterpreterOverlay][AdvancedVoice] send_message_to_agent', {
        messageLength: message.length,
        messagePreview: message.slice(0, 500),
      });

      return await this.enqueueAdvancedVoiceAgentMessage(message);
    }

    if (request.name === REALTIME_COMPUTER_BATCH_TOOL_NAME) {
      const speakingBlock = this.getAdvancedVoiceSpeakingBlockResponse(request.name);
      if (speakingBlock) {
        toolCallDebug.resultPreview = speakingBlock.output.slice(0, 4000);
        return speakingBlock;
      }
      try {
        const output = await this.callAdvancedVoiceComputerBatchTool(request.argumentsJson);
        toolCallDebug.resultPreview = output.slice(0, 4000);
        return { output };
      } catch (error) {
        const output = `Error: ${getErrorMessage(error)}`;
        toolCallDebug.error = getErrorMessage(error);
        toolCallDebug.resultPreview = output;
        console.warn('[InterpreterOverlay][AdvancedVoice] computer_batch failed', {
          error: getErrorMessage(error),
          argumentsPreview: request.argumentsJson.slice(0, 4000),
        });
        return { output };
      }
    }

    if (request.name === 'query_attachments') {
      try {
        const output = await this.queryAdvancedVoiceAttachments(request.argumentsJson);
        toolCallDebug.resultPreview = output.slice(0, 4000);
        return { output };
      } catch (error) {
        const output = `Error: ${getErrorMessage(error)}`;
        toolCallDebug.error = getErrorMessage(error);
        toolCallDebug.resultPreview = output;
        console.warn('[InterpreterOverlay][AdvancedVoice] query_attachments failed', {
          error: getErrorMessage(error),
          argumentsPreview: request.argumentsJson.slice(0, 4000),
        });
        return { output };
      }
    }

    if (request.name === 'call_hidden_agent') {
      const speakingBlock = this.getAdvancedVoiceSpeakingBlockResponse(request.name);
      if (speakingBlock) {
        toolCallDebug.resultPreview = speakingBlock.output.slice(0, 4000);
        return speakingBlock;
      }
      try {
        const output = await this.callAdvancedVoiceHiddenAgent(request.argumentsJson);
        toolCallDebug.resultPreview = output.slice(0, 4000);
        return { output };
      } catch (error) {
        const output = `Error: ${getErrorMessage(error)}`;
        toolCallDebug.error = getErrorMessage(error);
        toolCallDebug.resultPreview = output;
        console.warn('[InterpreterOverlay][AdvancedVoice] call_hidden_agent failed', {
          error: getErrorMessage(error),
          argumentsPreview: request.argumentsJson.slice(0, 4000),
        });
        return { output };
      }
    }

    if (request.name === 'read_agent_assistant_messages') {
      const text = this.advancedVoiceAgent?.lastAssistantText.trim();
      return {
        output: text || (this.advancedVoiceAgentTaskInFlight > 0 || this.advancedVoicePendingDelegatedRequests.size > 0
          ? 'No user-visible result is ready yet. If the user asked for progress, answer only: Still working.'
          : 'No user-visible result is ready yet.'),
      };
    }

    return { output: `Unknown advanced voice tool: ${request.name}` };
  };

  private getAdvancedVoiceSpeakingBlockResponse(
    toolName: string,
  ): { output: string; requestResponse: false } | null {
    if (!this.advancedVoiceSpeechInputOpen) {
      return null;
    }
    const output = JSON.stringify({
      status: 'not_executed_user_still_speaking',
      tool: toolName,
      instruction: 'Do not tell the user this action started. Wait for the next committed user input, then call the tool again only if the request still applies.',
    });
    console.log('[InterpreterOverlay][AdvancedVoice] blocked actionful tool while user is speaking', {
      toolName,
    });
    return { output, requestResponse: false };
  }

  private async callAdvancedVoiceComputerBatchTool(argumentsJson: string): Promise<string> {
    const targetContext = getTargetContextItem(this.overlayState.contextItems);
    let agentId = this.advancedVoiceAgent?.agentId ?? createOverlayAgentId();
    if (targetContext) {
      const session = await this.ensureAdvancedVoiceOverlayToolSession();
      agentId = session.agentId;
    } else if (!this.advancedVoiceAgent) {
      this.advancedVoiceAgent = {
        agentId,
        callerToken: createOverlayCallerToken(),
        threadId: null,
        lastAssistantText: '',
        lastUserMessageAt: Date.now(),
      };
    }

    const selectedProfile = await this.resolveAdvancedVoiceAgentProfile();
    const modelConfig = profileToModelConfig(selectedProfile, {
      reasoningEffort: selectedProfile.reasoningEffort,
    });
    return await callOverlayComputerBatchBridgeTool({
      argumentsJson,
      agentId,
      workspacePath: this.getAdvancedVoiceWorkspacePath(),
      profileId: selectedProfile.id,
      modelConfig,
      targetContext: targetContext ?? null,
      callSelectedTargetBatch: async (params) => await this.callAdvancedVoiceSelectedTargetBatch(params),
    });
  }

  private async callAdvancedVoiceSelectedTargetBatch(
    params: ComputerBatchParams,
  ): Promise<ToolCallResponse> {
    const session = await this.ensureAdvancedVoiceOverlayToolSession();
    const replacedPendingBatch = this.engine?.replacePendingComputerBatchForNewProposal() ?? false;
    console.log('[InterpreterOverlay][AdvancedVoice] selected target computer_batch action', {
      actionCount: params.actions.length,
      sessionId: session.id,
      replacedPendingBatch,
      firstActions: params.actions.slice(0, 5),
      actionsJson: JSON.stringify(params.actions).slice(0, 12000),
    });
    const batchGeneration = ++this.advancedVoiceComputerBatchGeneration;
    const outcome = await overlaySessionManager.computerBatch(session.agentId, params);
    if (this.advancedVoiceComputerBatchGeneration !== batchGeneration) {
      return {
        content: [{ type: 'text', text: 'Replaced by a newer computer_batch proposal.' }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'completed_after_review',
          actionCount: params.actions.length,
          replacedPendingBatch,
          outputPreview: this.formatAdvancedVoiceToolResult(outcome.result).slice(0, 4000),
          touched_window_diff: formatTouchedWindowDiff(outcome.touchedWindowDiff),
        }),
      }],
    };
  }

  private async callAdvancedVoiceHiddenAgent(argumentsJson: string): Promise<string> {
    const parsed = JSON.parse(argumentsJson || '{}') as {
      message?: unknown;
      system?: unknown;
      timeout_ms?: unknown;
    };
    const message = typeof parsed.message === 'string'
      ? this.normalizeAdvancedVoiceAgentMessage(parsed.message)
      : '';
    if (!message) {
      throw new Error('call_hidden_agent requires a message.');
    }

    const targetContext = getTargetContextItem(this.overlayState.contextItems);
    if (targetContext) {
      // A delegated agent must not inherit a dead committed target silently:
      // the tool result carries the observation instead of dispatching, and
      // the controller model decides the outcome.
      const closedMessage = await committedTargetWindowClosedMessage(targetContext);
      if (closedMessage) {
        console.warn('[InterpreterOverlay][AdvancedVoice] dead-target-observation', {
          at: 'call_hidden_agent',
          message: closedMessage,
        });
        return JSON.stringify({ status: 'target_window_closed', message: closedMessage });
      }
    }
    let agentId = this.advancedVoiceAgent?.agentId ?? createOverlayAgentId();
    const callerToken = this.advancedVoiceAgent?.callerToken ?? createOverlayCallerToken();
    if (targetContext) {
      const session = await this.ensureAdvancedVoiceOverlayToolSession();
      agentId = session.agentId;
    } else {
      this.advancedVoiceAgent = {
        agentId,
        callerToken,
        threadId: this.advancedVoiceAgent?.threadId ?? null,
        lastAssistantText: this.advancedVoiceAgent?.lastAssistantText ?? '',
        lastUserMessageAt: Date.now(),
      };
    }

    const selectedProfile = await this.host.resolveHiddenAgentProfile();
    const modelConfig = profileToModelConfig(selectedProfile, {
      reasoningEffort: selectedProfile.reasoningEffort,
    });
    const result = await callHiddenAgentTool.handler({
      message: [
        buildReferenceContextPrompt(this.overlayState.contextItems, message),
        OVERLAY_HIDDEN_AGENT_REPORT_CONTRACT,
      ].join('\n\n'),
      ...(typeof parsed.system === 'string' ? { system: parsed.system } : {}),
      ...(typeof parsed.timeout_ms === 'number' ? { timeout_ms: parsed.timeout_ms } : {}),
      ...buildOverlaySelectedContextToolArgs(targetContext, this.overlayState.contextItems),
    }, buildOverlayBuiltinToolIdentity({
      agentId,
      workspacePath: this.getAdvancedVoiceWorkspacePath(),
      modelConfig,
    }));
    return appendOverlayHiddenAgentReportInstruction(result.content[0]?.text ?? '');
  }

  private async queryAdvancedVoiceAttachments(argumentsJson: string): Promise<string> {
    return await queryOverlayAttachments(this.overlayState.contextItems, argumentsJson);
  }

  private handleAdvancedVoiceAudioEvent = async (
    _event: unknown,
    event: { type?: unknown; segmentIndex?: unknown },
  ): Promise<void> => {
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    const segmentIndex = event.segmentIndex === null || event.segmentIndex === undefined
      ? null
      : Number(event.segmentIndex);
    this.advancedVoiceDebug.audioEvents.push({
      type,
      segmentIndex: Number.isFinite(segmentIndex) ? segmentIndex : null,
      at: Date.now(),
    });
    if (type === 'input_audio_buffer.speech_started' || type === 'segment_started') {
      this.advancedVoiceSpeechInputOpen = true;
    } else if (
      type === 'input_audio_buffer.speech_stopped'
      || type === 'input_audio_buffer.committed'
      || type === 'input_audio_buffer.cleared'
      || type === 'input_committed'
      || type === 'segment_ended'
      || type === 'response_requested'
      || type === 'segment_clear'
    ) {
      this.advancedVoiceSpeechInputOpen = false;
    }
    console.log('[InterpreterOverlay][AdvancedVoice] audio event', {
      iso: new Date().toISOString(),
      type,
      segmentIndex: Number.isFinite(segmentIndex) ? segmentIndex : null,
      speechInputOpen: this.advancedVoiceSpeechInputOpen,
    });
    // Planning window visual: from speech commit until the first staged batch
    // (review takes over) or the response finishing without one. The world
    // pin plus the shared thinking sheen renders over the committed target,
    // matching the typed controller's planning presentation.
    if (
      type === 'input_committed'
      || type === 'response_requested'
      || type === 'input_audio_buffer.committed'
    ) {
      await this.beginAdvancedVoicePlanningVisual();
    } else if (
      type === 'response_done'
      || type === 'input_audio_buffer.speech_started'
      || type === 'segment_started'
    ) {
      this.endAdvancedVoicePlanningVisual(type);
    }
  };

  private async beginAdvancedVoicePlanningVisual(): Promise<void> {
    if (this.advancedVoicePlanningVisualActive || !this.isAdvancedVoiceInputActive) {
      return;
    }
    if (!getTargetContextItem(this.overlayState.contextItems)) {
      return;
    }
    if (this.overlayState.mode === 'review' || this.overlayState.action) {
      return;
    }
    this.advancedVoicePlanningVisualActive = true;
    console.log('[InterpreterOverlay][AdvancedVoice] planning-visual begin', {
      iso: new Date().toISOString(),
    });
    await this.host.beginAdvancedVoicePlanningVisual();
  }

  private endAdvancedVoicePlanningVisual(reason: string): void {
    if (!this.advancedVoicePlanningVisualActive) {
      return;
    }
    this.advancedVoicePlanningVisualActive = false;
    console.log('[InterpreterOverlay][AdvancedVoice] planning-visual end', {
      iso: new Date().toISOString(),
      reason,
    });
    this.host.endAdvancedVoicePlanningVisual();
  }

  private formatAdvancedVoiceToolResult(result: ToolExecutionResult | undefined): string {
    return formatOverlaySelectedTargetBatchResult(result);
  }

  private async ensureAdvancedVoiceOverlayToolSession(): Promise<OverlaySessionRecord> {
    const agentId = this.advancedVoiceAgent?.agentId ?? createOverlayAgentId();
    const callerToken = this.advancedVoiceAgent?.callerToken ?? createOverlayCallerToken();
    const existing = this.getExistingAdvancedVoiceAgentToolSession(agentId);
    if (existing) {
      return existing;
    }

    let targetContext = getTargetContextItem(this.overlayState.contextItems);
    if (!targetContext) {
      throw new Error('No active overlay target is attached for computer_batch.');
    }
    if (!this.capture) {
      throw new Error('Interpreter Overlay runtime is not active.');
    }

    targetContext = await this.host.ensureExecutableContextForTarget(targetContext);

    const display = targetContext.displayId === null
      ? this.capture.getActiveDisplay()
      : this.capture.getDisplayById(String(targetContext.displayId));
    this.host.setInteractionDisplay(display);
    this.host.setScopeBounds(targetContext.bounds);

    const session = await this.host.createAgentToolSession({
      ...buildOverlayToolSessionIdentity({
        agentId,
        callerToken,
        workspacePath: this.getAdvancedVoiceWorkspacePath(),
        windowSessionKey: targetContext.targetWindowSessionKey,
      }),
      targetContext,
    });
    this.advancedVoiceAgent = {
      agentId,
      callerToken,
      threadId: this.advancedVoiceAgent?.threadId ?? null,
      lastAssistantText: this.advancedVoiceAgent?.lastAssistantText ?? '',
      lastUserMessageAt: this.advancedVoiceAgent?.lastUserMessageAt ?? null,
    };
    return session;
  }

  private async enqueueAdvancedVoiceAgentMessage(
    message: string,
  ): Promise<{ output: string; followUpUserMessage?: string; requestResponse?: boolean }> {
    const previous = this.advancedVoiceAgentTaskQueue.catch(() => undefined);
    const queued = previous.then(() => this.sendAdvancedVoiceAgentMessage(message));
    this.advancedVoiceAgentTaskQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  private async sendAdvancedVoiceAgentMessage(
    message: string,
  ): Promise<{ output: string; followUpUserMessage?: string; requestResponse?: boolean }> {
    this.advancedVoiceAgentTaskInFlight += 1;
    try {
      const agentId = this.advancedVoiceAgent?.agentId ?? createOverlayAgentId();
      const callerToken = this.advancedVoiceAgent?.callerToken ?? createOverlayCallerToken();
      const previousThreadId = this.advancedVoiceAgent?.threadId ?? null;
      const selectedProfile = await this.resolveAdvancedVoiceAgentProfile();
      const workspacePath = this.getAdvancedVoiceWorkspacePath();
      const targetWindow = await this.host.resolveOverlayTargetWindow(workspacePath, null);
      const targetContext = getTargetContextItem(this.overlayState.contextItems);
      const contextItems = this.overlayState.contextItems;
      const messageWithReferences = buildReferenceContextPrompt(contextItems, message);
      const contextAttachmentMentions = await this.host.persistOverlayUserAttachmentMentions(
        this.host.buildNormalAgentAttachmentsFromContextItems(contextItems),
      );
      this.advancedVoiceAgent = {
        agentId,
        callerToken,
        threadId: previousThreadId,
        lastAssistantText: this.advancedVoiceAgent?.lastAssistantText ?? '',
        lastUserMessageAt: Date.now(),
      };
      this.host.overlayApprovalAgentIds.add(agentId);
      this.host.startGlobalApprovalPoller();
      if (!targetContext) {
        const initialContext = this.capture
          ? await this.host.captureContextForScope({
              displayId: this.host.getInteractionDisplay()?.id,
              scopeBounds: null,
              persistScreenshotToTmp: true,
            })
          : null;
        const launchMessage = this.buildAdvancedVoiceNoTargetLaunchMessage(
          messageWithReferences,
          initialContext,
          contextAttachmentMentions,
        );
        console.log('[InterpreterOverlay][AdvancedVoice] no-target launch message', {
          messageLength: launchMessage.length,
          preview: launchMessage.slice(0, 700),
        });
        const result = await startAgentTask({
          agentId,
          callerToken,
          mode: 'headed',
          message: launchMessage,
          system: buildAdvancedVoiceDesktopAgentSystemPrompt(),
          threadId: previousThreadId ?? undefined,
          workspace: targetWindow.workspacePath ?? undefined,
          activate: true,
          targetWindowSessionKey: targetWindow.targetWindowSessionKey,
          allowedToolNames: DESKTOP_CUA_ALLOWED_TOOL_NAMES,
          modelConfig: profileToModelConfig(selectedProfile, {
            reasoningEffort: selectedProfile.reasoningEffort,
          }),
          toolProfileId: selectedProfile.id,
          broadcastCreateRequestToAllWindows: true,
        });
        const lastAssistantText = this.getLastAssistantTextFromMessages(result.messages);
        if (result.requestId && !lastAssistantText) {
          this.advancedVoicePendingDelegatedRequests.add(result.requestId);
        }
        this.advancedVoiceAgent = {
          agentId,
          callerToken,
          threadId: result.threadId ?? previousThreadId,
          lastAssistantText,
          lastUserMessageAt: Date.now(),
        };
        return buildAdvancedVoiceDelegatedToolResponse(lastAssistantText);
      }

      const session = this.getExistingAdvancedVoiceAgentToolSession(agentId)
        ?? await this.host.createAgentToolSession({
          agentId,
          callerToken,
          workspacePath: targetWindow.workspacePath,
          windowSessionKey: targetWindow.targetWindowSessionKey,
          targetContext,
        });
      const allowedToolNames = getAdvancedVoiceAgentAllowedToolNames();
      const result = await startAgentTask({
        agentId,
        callerToken,
        mode: 'headed',
        message: this.host.buildOverlayLaunchMessage(
          messageWithReferences,
          session.initialContext,
          targetContext,
          contextAttachmentMentions,
        ),
        system: await this.host.buildOverlaySystemPrompt(session),
        threadId: previousThreadId ?? undefined,
        workspace: targetWindow.workspacePath ?? undefined,
        activate: true,
        targetWindowSessionKey: targetWindow.targetWindowSessionKey,
        allowedToolNames,
        modelConfig: profileToModelConfig(selectedProfile, {
          reasoningEffort: selectedProfile.reasoningEffort,
        }),
        toolProfileId: selectedProfile.id,
        broadcastCreateRequestToAllWindows: true,
      });
      const lastAssistantText = this.getLastAssistantTextFromMessages(result.messages);
      if (result.requestId && !lastAssistantText) {
        this.advancedVoicePendingDelegatedRequests.add(result.requestId);
      }
      this.advancedVoiceAgent = {
        agentId,
        callerToken,
        threadId: result.threadId ?? previousThreadId,
        lastAssistantText,
        lastUserMessageAt: Date.now(),
      };
      return buildAdvancedVoiceDelegatedToolResponse(lastAssistantText);
    } finally {
      this.advancedVoiceAgentTaskInFlight = Math.max(0, this.advancedVoiceAgentTaskInFlight - 1);
      this.stopAdvancedVoiceApprovalBridgeIfIdle();
    }
  }

  private getExistingAdvancedVoiceAgentToolSession(agentId: string): OverlaySessionRecord | null {
    try {
      const session = overlaySessionManager.getSessionForAgent(agentId);
      if (this.host.getActiveAttachedSessionId() === session.id) {
        return session;
      }
    } catch {
      return null;
    }
    return null;
  }

  private handleAdvancedVoiceTestAudio = async (): Promise<{
    dataUrl?: string;
    mimeType?: string;
    segments?: Array<{ dataUrl: string; mimeType: string; delayAfterMs?: number }>;
  } | null> => {
    const result = await readAdvancedVoiceTestAudioFromEnv();
    if (!result) {
      return null;
    }
    this.advancedVoiceDebug.testAudioRequestedAt = Date.now();
    this.advancedVoiceDebug.testAudioPath = result.sourcePath;
    this.advancedVoiceDebug.testAudioBytes = result.byteLength;
    return result.payload;
  };

  private advancedVoiceMimeTypeForPath(audioPath: string): string {
    return advancedVoiceMimeTypeForPath(audioPath);
  }

  private async resolveAdvancedVoiceAgentProfile(): Promise<Profile> {
    const modelTaskProfiles = resolveOverlayModelTaskProfileIds(this.effectiveSettings);
    return this.host.resolveOverlayAgentProfileByModelSetting(
      modelTaskProfiles.advancedVoiceProfileId,
      'No Interpreter agent profiles are available for advanced voice mode.',
    );
  }
}
