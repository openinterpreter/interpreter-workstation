import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { StreamRequestBody, StopRequestBody } from '../../../src/lib/codex/api-types';
import type { SseStreamEvent } from '../../../src/lib/codex/event-mapper';
import type { AppServerNotification } from '../../../src/lib/codex/protocol';
import { mapBrowserNotificationToUiEvents, SERVER_METHOD } from './protocolWire';
import type { v2 } from '../../../server/handlers/codex-generated-types/index';
import { BrowserProjectAppServer } from './appServer';
import { IndexedDbPiTranscriptStore, validatePiTranscript,
  type BrowserPiTranscript, type BrowserPiTranscriptStore } from './piTranscript';
import { projectPiHistory } from './piHistory';
import type { BrowserLocalModelCatalog } from './modelCatalog';

/** Browser transport of the *existing* app-server stream, not an alternate chat protocol. */
export type BrowserAppServerEventSink = (event: SseStreamEvent, notification?: AppServerNotification) => void;
export type BrowserPiSessionOptions = {
  projectId: string;
  threadId: string;
  model: Model<any>;
  /** Browser-local model adapter implementing Pi's unmodified StreamFn contract. */
  streamFn: StreamFn;
  tools: AgentTool<any>[];
  systemPrompt: string;
  onEvent?: BrowserAppServerEventSink;
  maxTurns?: number;
  timeoutMs?: number;
  storage?: BrowserPiTranscriptStore;
  catalog?: BrowserLocalModelCatalog;
  /** Release a browser-local model worker after the session is retired. */
  onDispose?: () => void;
};

const identity = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TEXT_BYTES = 8192;
const MAX_ASSISTANT_TEXT_BYTES = 32 * 1024;
const MAX_BROWSER_TOOL_CALLS = 16;
const JOURNAL_SETTLE_AFTER_DEADLINE_MS = 2_000;
/** Local WASM inference may require more than one model pass before a tool result is grounded. */
export const DEFAULT_BROWSER_TURN_TIMEOUT_MS = 10 * 60_000;
/** Explicit opt-in only: slow browser-local CPU models may need multiple passes per turn. */
export const MAX_BROWSER_TURN_TIMEOUT_MS = 90 * 60_000;
const textEncoder = new TextEncoder();

/** Pi owns the transcript, model/tool loop and tool execution; this class only speaks Workstation protocol. */
export class BrowserPiAppServerSession {
  agent: Agent;
  readonly projectId: string;
  readonly threadId: string;
  get model() { return this.agent.state.model; }
  readonly appServer: BrowserProjectAppServer;
  private readonly listeners = new Set<BrowserAppServerEventSink>();
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private activeTurn: string | null = null;
  private stoppedTurn: string | null = null;
  private cancelActiveTurn: (() => void) | null = null;
  private sentTurns = 0;
  private modelCalls = 0;
  private modelPassLimitReached = false;
  private toolCalls = 0;
  private readonly storage?: BrowserPiTranscriptStore;
  private revision = 0;
  private unavailableReason: string | null = null;
  private interruptedTurnIds: string[] = [];
  private failedTurns: Record<string, 'failed' | 'truncated' | 'storage'> = {};
  private readonly agentOptions: BrowserPiSessionOptions;

  /** Only registered catalogue entries are offered for browser acquisition. */
  get catalog(): BrowserLocalModelCatalog | undefined { return this.agentOptions.catalog; }
  availableModels(): ReadonlyArray<{ id: string; name: string }> {
    return this.agentOptions.catalog?.list() ?? [{ id: this.model.id, name: this.model.name }];
  }

  constructor(options: BrowserPiSessionOptions) {
    if (!identity.test(options.projectId) || !identity.test(options.threadId))
      throw new Error('Invalid browser project or thread ID');
    this.projectId = options.projectId;
    this.threadId = options.threadId;
    this.agentOptions = options;
    this.storage = options.storage;
    if (options.onEvent) this.listeners.add(options.onEvent);
    this.maxTurns = options.maxTurns ?? 32;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_TURN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxTurns) || this.maxTurns < 1 || this.maxTurns > 64 ||
        !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 ||
        this.timeoutMs > MAX_BROWSER_TURN_TIMEOUT_MS)
      throw new Error('Invalid browser session bounds');
    this.agent = this.newAgent();
    this.appServer = new BrowserProjectAppServer(this);
  }

  private newAgent(): Agent {
    const options = this.agentOptions;
    const agent = new Agent({
      initialState: { systemPrompt: options.systemPrompt, model: options.model, tools: options.tools },
      streamFn: options.streamFn,
      toolExecution: 'sequential',
      beforeToolCall: async ({ args }) => {
        if (this.unavailableReason || agent !== this.agent)
          return { block: true, reason: 'Browser turn interrupted', terminate: true };
        if (++this.toolCalls > MAX_BROWSER_TOOL_CALLS)
          return { block: true, reason: 'Browser tool-call limit reached', terminate: true };
        if (textEncoder.encode(JSON.stringify(args) ?? '').byteLength > MAX_TEXT_BYTES)
          return { block: true, reason: 'Browser tool arguments exceed limit', terminate: true };
      },
      afterToolCall: async ({ result, isError }) => {
        // Pi converts thrown tool-handler exceptions into text results. Never
        // expose their raw messages to the model, the SSE UI or IndexedDB.
        if (isError) return { content: [{ type: 'text', text: 'Browser tool failed' }],
          isError: true, details: {} };
        let resultBytes: number;
        try {
          resultBytes = textEncoder.encode(JSON.stringify({ content: result.content,
            structuredContent: result.structuredContent, details: result.details })).byteLength;
        } catch { resultBytes = MAX_TEXT_BYTES + 1; }
        if (resultBytes > MAX_TEXT_BYTES)
          return { content: [{ type: 'text', text: 'Browser tool result exceeds limit' }],
            isError: true, details: {} };
      },
    });
    agent.subscribe(event => {
      if (agent !== this.agent) return;
      if (event.type === 'turn_start' && ++this.modelCalls > 8) {
        this.modelPassLimitReached = true;
        agent.abort();
      }
    });
    return agent;
  }

  static async open(options: Omit<BrowserPiSessionOptions, 'storage'>,
    storage: BrowserPiTranscriptStore = new IndexedDbPiTranscriptStore()): Promise<BrowserPiAppServerSession> {
    let restored: BrowserPiTranscript | null;
    try {
      restored = await storage.read(options.projectId, options.threadId);
    } catch {
      throw new Error('Browser conversation storage unavailable; reload before sending');
    }
    const session = new BrowserPiAppServerSession({ ...options, storage });
    if (restored) {
      const transcript = validatePiTranscript(restored, options.projectId, options.threadId);
      session.agent.state.messages = transcript.messages;
      session.revision = transcript.revision;
      session.interruptedTurnIds = transcript.interruptedTurnIds ?? [];
      session.failedTurns = transcript.failedTurns ?? {};
      // Reopening a tab must not reset the per-thread turn budget while the
      // model context and its durable revision are retained.
      session.sentTurns = transcript.messages.filter(message => message.role === 'user').length;
    }
    return session;
  }

  private notification(notification: AppServerNotification): void {
    for (const listener of this.notificationListeners) listener(notification);
    for (const event of mapBrowserNotificationToUiEvents(notification)) this.emit(event, notification);
  }

  subscribeNotifications(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  private emit(event: SseStreamEvent, notification?: AppServerNotification): void {
    for (const listener of this.listeners) listener(event, notification);
  }

  subscribe(listener: BrowserAppServerEventSink): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rehydrate visible chat through Workstation's ordinary thread-history mapper. */
  historyThread(): v2.Thread {
    if (this.unavailableReason) throw new Error(this.unavailableReason);
    if (this.activeTurn) throw new Error('Browser Pi history unavailable during an active turn');
    return projectPiHistory(this.projectId, this.threadId, this.agent.state.model.provider,
      this.agent.state.model.id, this.agent.state.messages, this.interruptedTurnIds, this.failedTurns);
  }

  /** Same SSE wire events parsed by useChat's existing eventsource-parser and reducer. */
  stream(request: StreamRequestBody, signal?: AbortSignal): Response {
    const encoder = new TextEncoder();
    const self = this;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let finished = false;
        const unsubscribe = self.subscribe(event => {
          if (finished) return;
          controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.payload)}\n\n`));
        });
        const abort = () => { if (self.activeTurn) self.stop({ threadId: self.threadId }); };
        signal?.addEventListener('abort', abort, { once: true });
        void self.send(request, signal).catch(error => {
          if (!finished) controller.error(error);
        }).finally(() => {
          finished = true;
          unsubscribe(); signal?.removeEventListener('abort', abort);
          try { controller.close(); } catch { /* already errored */ }
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  private item(method: typeof SERVER_METHOD.itemStarted | typeof SERVER_METHOD.itemCompleted,
    turnId: string, item: v2.ThreadItem): void {
    if (method === SERVER_METHOD.itemStarted) {
      this.notification({ method: SERVER_METHOD.itemStarted, params: {
        threadId: this.threadId, turnId, item, startedAtMs: Date.now(),
      } });
    } else {
      this.notification({ method: SERVER_METHOD.itemCompleted, params: {
        threadId: this.threadId, turnId, item, completedAtMs: Date.now(),
      } });
    }
  }

  private async handle(event: AgentEvent, turnId: string, toolItems: Map<string, Extract<v2.ThreadItem, { type: 'mcpToolCall' }>>,
    assistantId: string, output: { deltaBytes: number; completedBytes: number;
      toolStarts: number; exceeded: boolean }): Promise<void> {
    if (output.exceeded) return;
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      output.deltaBytes += textEncoder.encode(event.assistantMessageEvent.delta).byteLength;
      if (output.deltaBytes > MAX_ASSISTANT_TEXT_BYTES) {
        output.exceeded = true;
        this.unavailableReason = 'Browser Pi session exceeded assistant output limit; reload';
        this.agent.abort();
        throw new Error('Browser assistant output exceeds limit');
      }
      this.notification({ method: SERVER_METHOD.agentMessageDelta, params: {
        threadId: this.threadId, turnId, itemId: assistantId, delta: event.assistantMessageEvent.delta,
      } });
    } else if (event.type === 'tool_execution_start') {
      output.toolStarts++;
      let argsBytes: number;
      try { argsBytes = textEncoder.encode(JSON.stringify(event.args) ?? '').byteLength; }
      catch { argsBytes = MAX_TEXT_BYTES + 1; }
      if (output.toolStarts > MAX_BROWSER_TOOL_CALLS || argsBytes > MAX_TEXT_BYTES ||
          event.toolCallId.length > 160 || event.toolName.length > 160) {
        // Pi emits this event *before* beforeToolCall validation. Do not place
        // unbounded model-generated arguments on Workstation's SSE/UI wire.
        output.exceeded = true;
        this.unavailableReason = 'Browser Pi session exceeded browser event limit; reload';
        this.agent.abort();
        throw new Error('Browser tool event exceeds limit');
      }
      const item: Extract<v2.ThreadItem, { type: 'mcpToolCall' }> = {
        type: 'mcpToolCall', id: `pi-tool-${turnId}-${output.toolStarts}`,
        server: 'browser-project', tool: event.toolName,
        status: 'inProgress', arguments: event.args, appContext: null, mcpAppUi: null,
        pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
      };
      toolItems.set(event.toolCallId, item);
      this.item(SERVER_METHOD.itemStarted, turnId, item);
    } else if (event.type === 'tool_execution_end') {
      const started = toolItems.get(event.toolCallId);
      if (!started) throw new Error('Pi completed an unknown browser tool call');
      const item: Extract<v2.ThreadItem, { type: 'mcpToolCall' }> = {
        ...started, status: event.isError ? 'failed' : 'completed', durationMs: event.durationMs ?? null,
        result: event.isError ? null : {
          content: event.result.content, structuredContent: event.result.structuredContent ?? null, _meta: null,
        }, error: event.isError ? { message: event.result.content.map((part: { type: string; text?: string }) =>
          part.type === 'text' ? part.text ?? '' : '').join('\n') } : null,
      };
      toolItems.set(event.toolCallId, item);
      this.item(SERVER_METHOD.itemCompleted, turnId, item);
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const answer = event.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
      output.completedBytes += textEncoder.encode(answer).byteLength;
      if (output.completedBytes > MAX_ASSISTANT_TEXT_BYTES) {
        output.exceeded = true;
        this.unavailableReason = 'Browser Pi session exceeded assistant output limit; reload';
        this.agent.abort();
        throw new Error('Browser assistant output exceeds limit');
      }
      if (answer) this.item(SERVER_METHOD.itemCompleted, turnId, {
        type: 'agentMessage', id: assistantId, text: answer, phase: 'final_answer',
        memoryCitation: null, delivery: null, questions: null,
      });
    }
  }

  async send(request: StreamRequestBody, signal?: AbortSignal): Promise<string> {
    if (this.unavailableReason) throw new Error(this.unavailableReason);
    if (signal?.aborted) throw new DOMException('Browser turn aborted', 'AbortError');
    if (this.activeTurn) throw new Error('Browser thread already has an active turn');
    if (request.threadId && request.threadId !== this.threadId)
      throw new Error('Browser thread ID does not match project session');
    if (request.workspacePath !== `browser-project:${this.projectId}`)
      throw new Error('Browser workspace capability unavailable for this path');
    if (request.attachments?.length || request.skills?.length || request.customEndpoint || request.customApiKey ||
        request.system)
      throw new Error('Browser session capability unavailable: attachments, native skills or hosted configuration');
    if (typeof request.message !== 'string' || !request.message.trim() ||
        textEncoder.encode(request.message).byteLength > MAX_TEXT_BYTES)
      throw new Error('Invalid or oversized browser message');
    if (this.sentTurns >= this.maxTurns) throw new Error('Browser session turn limit reached');
    const validatedRequest = { ...request, message: request.message };
    if (this.storage) {
      try {
        return await this.storage.runExclusive(this.projectId, this.threadId, async () => {
          const persisted = await this.storage!.read(this.projectId, this.threadId);
          // The HTTP stream may be stopped while IndexedDB is opening or reading.
          // Never start model inference or invoke tools after that cancellation.
          if (signal?.aborted) throw new DOMException('Browser turn aborted', 'AbortError');
          if ((persisted?.revision ?? 0) !== this.revision)
            throw new Error('Browser Pi transcript changed in another tab; reload before sending');
          return this.performTurn(validatedRequest);
        });
      } catch (error) {
        if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError')
          throw new DOMException('Browser turn aborted', 'AbortError');
        if (error instanceof Error && (error.message === 'Browser Pi thread is active in another tab' ||
            error.message === 'Browser Pi transcript changed in another tab; reload before sending' ||
            error.message === 'Browser Pi cross-tab lock capability unavailable' ||
            error.message === 'Browser conversation exceeds finite capacity; start a new thread')) throw error;
        throw new Error('Browser conversation storage unavailable; reload before sending');
      }
    }
    return this.performTurn(validatedRequest);
  }

  private async performTurn(request: StreamRequestBody & { message: string }): Promise<string> {
    if (this.activeTurn) throw new Error('Browser thread already has an active turn');
    // History reconstruction keys turns by the Pi user-message index. Use that
    // same stable ID on the live app-server wire, including after IDB restore.
    const turnId = `pi-turn-${this.agent.state.messages.length}`;
    const assistantId = crypto.randomUUID();
    this.activeTurn = turnId;
    this.stoppedTurn = null;
    const interrupted = new Promise<never>((_, reject) => {
      this.cancelActiveTurn = () => reject(new DOMException('Browser turn aborted', 'AbortError'));
    });
    this.sentTurns++;
    this.modelCalls = 0;
    this.modelPassLimitReached = false;
    this.toolCalls = 0;
    const startedAt = Date.now();
    const turn: v2.Turn = { id: turnId, items: [], itemsView: 'full', status: 'inProgress',
      error: null, startedAt: startedAt / 1000, completedAt: null, durationMs: null };
    this.emit({ event: 'thread', payload: { threadId: this.threadId } });
    this.emit({ event: 'turn', payload: { threadId: this.threadId, turnId, status: 'inProgress' } });
    this.notification({ method: SERVER_METHOD.turnStarted, params: { threadId: this.threadId, turn } });
    const user: v2.ThreadItem = { type: 'userMessage', id: request.clientUserMessageId ?? crypto.randomUUID(),
      clientId: request.clientUserMessageId ?? null, content: [{ type: 'text', text: request.message, text_elements: [] }] };
    this.item(SERVER_METHOD.itemCompleted, turnId, user);
    const toolItems = new Map<string, Extract<v2.ThreadItem, { type: 'mcpToolCall' }>>();
    const output = { deltaBytes: 0, completedBytes: 0, toolStarts: 0, exceeded: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let saving = false;
    const agent = this.agent;
    const priorMessages = agent.state.messages.slice();
    const priorRevision = this.revision;
    const interruptedTurnIds = [...this.interruptedTurnIds, turnId];
    const completedTools: Array<{ item: Extract<v2.ThreadItem, { type: 'mcpToolCall' }>;
      toolCallId: string }> = [];
    let journalMessages: AgentMessage[] = [];
    let journalWrites: Promise<void> = Promise.resolve();
    const snapshot = (): AgentMessage[] => {
      const timestamp = startedAt;
      const messages: AgentMessage[] = [...priorMessages,
        { role: 'user', content: request.message, timestamp }];
      for (const { item: tool, toolCallId } of completedTools) {
        messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId,
          name: tool.tool, arguments: tool.arguments }], api: agent.state.model.api,
          provider: agent.state.model.provider, model: agent.state.model.id,
          stopReason: 'toolUse', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0,
              cacheWrite: 0, total: 0 } } } as AgentMessage);
        messages.push({ role: 'toolResult', toolCallId, toolName: tool.tool,
          content: tool.status === 'failed' ? [{ type: 'text', text: 'Browser tool failed' }] :
            tool.result!.content as unknown as Extract<AgentMessage, { role: 'toolResult' }>['content'],
          isError: tool.status === 'failed', timestamp: Date.now() } as AgentMessage);
      }
      return messages;
    };
    const queueJournal = (): Promise<void> => {
      const messages = snapshot();
      if (!this.storage) { journalMessages = messages; return Promise.resolve(); }
      journalWrites = journalWrites.then(async () => {
        projectPiHistory(this.projectId, this.threadId, agent.state.model.provider,
          agent.state.model.id, messages, interruptedTurnIds, this.failedTurns);
        const next: BrowserPiTranscript = { version: 1, projectId: this.projectId,
          threadId: this.threadId, revision: this.revision + 1, messages, interruptedTurnIds,
          failedTurns: this.failedTurns };
        await this.storage!.compareAndSwap(next, this.revision);
        this.revision = next.revision;
        journalMessages = messages;
      }).catch(() => {
        saving = true;
        this.unavailableReason = 'Browser conversation storage unavailable; reload before sending';
        agent.abort();
        throw new Error(this.unavailableReason);
      });
      return journalWrites;
    };
    const unsubscribe = agent.subscribe(async event => {
      if (expired || this.stoppedTurn === turnId || agent !== this.agent) return;
      await this.handle(event, turnId, toolItems, assistantId, output);
      if (event.type === 'tool_execution_end') {
        const completed = toolItems.get(event.toolCallId);
        if (completed && (completed.status === 'completed' || completed.status === 'failed')) {
          completedTools.push({ item: completed, toolCallId: event.toolCallId });
          await queueJournal();
        }
      }
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        this.unavailableReason = 'Browser Pi session expired after an unresponsive model; reload';
        this.agent.abort();
        reject(new Error('Browser model did not settle before the finite deadline'));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([queueJournal(), deadline, interrupted]);
      if (expired) throw new Error('Browser model did not settle before the finite deadline');
      await Promise.race([agent.prompt(request.message), deadline, interrupted]);
      if (this.stoppedTurn === turnId) throw new DOMException('Browser turn aborted', 'AbortError');
      if (this.modelPassLimitReached) throw new Error('Browser model pass budget reached');
      const finalAssistant = [...agent.state.messages].reverse()
        .find(message => message.role === 'assistant');
      if (completedTools.length && finalAssistant?.role === 'assistant' &&
          finalAssistant.stopReason !== 'stop')
        throw new Error('Browser model did not finish after a completed tool');
      if (!finalAssistant || finalAssistant.role !== 'assistant' ||
          (finalAssistant.stopReason !== 'error' && finalAssistant.stopReason !== 'aborted' &&
            (finalAssistant.stopReason !== 'stop' ||
              !finalAssistant.content.some(part => part.type === 'text' && !!part.text.trim()))))
        throw new Error('Browser model did not provide a final answer');
      await Promise.race([journalWrites, deadline, interrupted]);
      if (output.exceeded) throw new Error('Browser assistant output exceeds limit');
      if (this.storage) {
        if (completedTools.length) {
          // The final CAS can fail or settle after its deadline. Seal the
          // completed-tool journal as failed *before* attempting that write;
          // a successful final CAS removes this provisional failure marker.
          const failedTurns = { ...this.failedTurns, [turnId]: 'storage' as const };
          const sealed: BrowserPiTranscript = { version: 1, projectId: this.projectId,
            threadId: this.threadId, revision: this.revision + 1,
            messages: journalMessages, interruptedTurnIds: this.interruptedTurnIds, failedTurns };
          await Promise.race([this.storage.compareAndSwap(sealed, this.revision), deadline, interrupted]);
          this.revision = sealed.revision;
          this.failedTurns = failedTurns;
        }
        const finalFailures = { ...this.failedTurns };
        delete finalFailures[turnId];
        const next: BrowserPiTranscript = { version: 1, projectId: this.projectId,
          threadId: this.threadId, revision: this.revision + 1,
          messages: this.agent.state.messages.map(message =>
            message.role === 'assistant' && message.stopReason === 'error'
              ? { ...message, errorMessage: message.errorMessage === 'Browser local model output truncated'
                ? message.errorMessage : 'Browser local model turn failed' } : message),
          interruptedTurnIds: this.interruptedTurnIds, failedTurns: finalFailures };
        // Structural JSON validation alone does not guarantee that the normal
        // Workstation thread-history mapper can restore the model/tool trace.
        // Preserve the last readable CAS revision if Pi produced invalid IDs
        // or unmatched tool results instead of persisting an unreadable thread.
        projectPiHistory(this.projectId, this.threadId, this.agent.state.model.provider,
          this.agent.state.model.id, next.messages, next.interruptedTurnIds, next.failedTurns);
        saving = true;
        await Promise.race([this.storage.compareAndSwap(next, this.revision), deadline, interrupted]);
        this.revision = next.revision;
        this.interruptedTurnIds = next.interruptedTurnIds ?? [];
        this.failedTurns = finalFailures;
        // The next turn's provisional journal snapshots in-memory Pi state;
        // it must never reintroduce the raw provider failure we just sanitized.
        this.agent.state.messages = next.messages;
      }
      const last = [...this.agent.state.messages].reverse().find(message => message.role === 'assistant');
      const status = last?.role === 'assistant' && last.stopReason === 'error' ? 'failed' :
        last?.role === 'assistant' && last.stopReason === 'aborted' ? 'interrupted' : 'completed';
      if (timer) { clearTimeout(timer); timer = undefined; }
      this.notification({ method: SERVER_METHOD.turnCompleted, params: { threadId: this.threadId,
        turn: { ...turn, status,
          error: status === 'failed' ? { message: last?.role === 'assistant' &&
            last.errorMessage === 'Browser local model output truncated'
            ? 'Browser local model output truncated' : 'Browser local model turn failed',
            codexErrorInfo: last?.role === 'assistant' && last.errorMessage === 'Browser local model output truncated'
              ? 'other' : null,
            additionalDetails: last?.role === 'assistant' && last.errorMessage === 'Browser local model output truncated'
              ? 'browserModelTruncated' : null, misalignment: null } : null,
          completedAt: Date.now() / 1000, durationMs: Date.now() - startedAt },
      } });
      return turnId;
    } catch (failure) {
      const modelFailure = [...agent.state.messages.slice(priorMessages.length)].reverse().find(message =>
        message.role === 'assistant' && message.stopReason === 'error');
      const truncated = modelFailure?.role === 'assistant' &&
        modelFailure.errorMessage === 'Browser local model output truncated' ||
        failure instanceof Error && failure.message === 'Browser local model output truncated';
      if (expired || this.stoppedTurn === turnId || completedTools.length) {
        // A provider can ignore abort, a later output can fail validation, or
        // the final save can fail. None may erase earlier committed tool results.
        try {
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([journalWrites, new Promise<never>((_, reject) => {
              settleTimer = setTimeout(() => reject(new Error('Browser journal did not settle')),
                JOURNAL_SETTLE_AFTER_DEADLINE_MS);
            })]);
          } finally { if (settleTimer) clearTimeout(settleTimer); }
          if (this.storage && this.revision === priorRevision)
            throw new Error('Browser journal was not committed');
          if (!expired && this.stoppedTurn !== turnId && !saving && this.storage) {
            // Seal the completed-tool journal as FAILED, not user-interrupted.
            const failedTurns = { ...this.failedTurns,
              [turnId]: truncated ? 'truncated' as const : 'failed' as const };
            const next: BrowserPiTranscript = { version: 1, projectId: this.projectId,
              threadId: this.threadId, revision: this.revision + 1, messages: journalMessages,
              interruptedTurnIds: this.interruptedTurnIds, failedTurns };
            projectPiHistory(this.projectId, this.threadId, agent.state.model.provider,
              agent.state.model.id, next.messages, next.interruptedTurnIds, next.failedTurns);
            await this.storage.compareAndSwap(next, this.revision);
            this.revision = next.revision;
            this.failedTurns = failedTurns;
          }
          if (!expired && this.stoppedTurn !== turnId && !saving && !this.storage)
            this.failedTurns = { ...this.failedTurns, [turnId]: truncated ? 'truncated' : 'failed' };
          const replacement = this.newAgent();
          replacement.state.messages = journalMessages;
          this.agent = replacement;
          if ((expired || this.stoppedTurn === turnId || saving) && !this.failedTurns[turnId])
            this.interruptedTurnIds = interruptedTurnIds;
          // An ambiguous final CAS may yet write after this function returns.
          // Do not start another turn until reload can revalidate durable state.
          this.unavailableReason = saving
            ? 'Browser conversation storage unavailable; reload before sending' : null;
        } catch {
          this.unavailableReason = 'Browser conversation storage unavailable; reload before sending';
        }
      } else if (this.storage && this.revision !== priorRevision && !saving) {
        // Failed model/projection turns must not leave a provisional user or
        // partial tool trace that a later reload mistakes for an interruption.
        try {
          await journalWrites;
          const previous: BrowserPiTranscript = { version: 1, projectId: this.projectId,
            threadId: this.threadId, revision: this.revision + 1,
            messages: priorMessages, interruptedTurnIds: this.interruptedTurnIds,
            failedTurns: this.failedTurns };
          await this.storage.compareAndSwap(previous, this.revision);
          this.revision = previous.revision;
        } catch { this.unavailableReason = 'Browser conversation storage unavailable; reload before sending'; }
      }
      if (!expired && this.agent === agent) {
        // A failed CAS or corrupt/oversized transcript leaves Pi's in-memory
        // messages ahead of the durable revision. Never retry from that state.
        this.unavailableReason ??= 'Browser Pi session unavailable after a failed turn; reload';
        agent.abort();
      }
      // If a model ignores abort, its prompt can still be running. If storage
      // failed, its transcript is not durable. Neither case may start a retry.
      this.notification({ method: SERVER_METHOD.turnCompleted, params: { threadId: this.threadId,
        turn: { ...turn, status: (expired || this.stoppedTurn === turnId) &&
          !this.failedTurns[turnId] ? 'interrupted' : 'failed',
          error: (expired || this.stoppedTurn === turnId) && !this.failedTurns[turnId] ? null : { message: saving && this.failedTurns[turnId]
            ? 'Browser model outcome not recorded; completed tools retained' : saving ? 'Browser conversation could not be saved' :
            truncated ? 'Browser local model output truncated' : 'Browser local model turn failed',
            codexErrorInfo: truncated ? 'other' : null,
            additionalDetails: truncated ? 'browserModelTruncated' : null, misalignment: null }, completedAt: Date.now() / 1000,
          durationMs: Date.now() - startedAt },
      } });
      return turnId;
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      this.activeTurn = null;
      this.stoppedTurn = null;
      this.cancelActiveTurn = null;
    }
  }

  stop(request: StopRequestBody): void {
    if (request.threadId && request.threadId !== this.threadId) throw new Error('Wrong browser thread');
    if (request.turnId && request.turnId !== this.activeTurn) throw new Error('Wrong browser turn');
    if (!this.activeTurn) throw new Error('No active browser turn');
    this.stoppedTurn = this.activeTurn;
    this.agent.abort();
    this.cancelActiveTurn?.();
  }

  /** Stop an abandoned host without allowing another turn on its transcript. */
  dispose(): void {
    if (this.unavailableReason === 'Browser session disposed') return;
    this.unavailableReason = 'Browser session disposed';
    if (this.activeTurn) this.stop({ threadId: this.threadId });
    this.agent.abort();
    this.agentOptions.onDispose?.();
    this.listeners.clear();
    this.notificationListeners.clear();
  }
}
