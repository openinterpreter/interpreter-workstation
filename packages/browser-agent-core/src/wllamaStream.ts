import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

export type BrowserChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool';
  content: string; tool_call_id?: string; tool_calls?: Array<{ id: string;
    type: 'function'; function: { name: string; arguments: string } }> };
export type BrowserChatTool = { type: 'function'; function: { name: string;
  description?: string; parameters: Record<string, unknown> } };
export type BrowserChatChunk = { choices: Array<{ delta: { content?: string | null;
  tool_calls?: Array<{ index: number; id?: string;
    function?: { name?: string; arguments?: string } }> };
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null }>;
  usage?: { completion_tokens?: number } | null;
  timings?: { predicted_n?: number } };
export type BrowserChatEngine = { complete(messages: BrowserChatMessage[], tools: BrowserChatTool[],
  signal: AbortSignal, onChunk: (chunk: BrowserChatChunk) => void): Promise<void> };

const text = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === 'string' ? content : content.filter(part => part.type === 'text')
    .map(part => part.text ?? '').join('');

/** Pi's full retained transcript, including model-authored calls and verified tool results. */
export function browserChatInput(context: TranscriptContext): {
  messages: BrowserChatMessage[]; tools: BrowserChatTool[] } {
  const messages: BrowserChatMessage[] = [];
  const system = getCurrentSystemPrompt(context.messages);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of context.messages) {
    if (message.role === 'user') messages.push({ role: 'user', content: text(message.content) });
    else if (message.role === 'assistant') messages.push({ role: 'assistant',
      content: text(message.content), tool_calls: message.content.filter(part => part.type === 'toolCall')
        .map(call => ({ id: call.id, type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
    else if (message.role === 'toolResult') messages.push({ role: 'tool',
      content: text(message.content), tool_call_id: message.toolCallId });
  }
  return { messages, tools: getCurrentTools(context.messages).map(tool => ({
    type: 'function', function: { name: tool.name, description: tool.description,
      parameters: tool.parameters as Record<string, unknown> },
  })) };
}

/** A generic Pi StreamFn: only the model chooses tool names and JSON arguments. */
export function createBrowserGgufStream(engine: BrowserChatEngine): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const response: AssistantMessage = { role: 'assistant', content: [], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'pending',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'start', partial: response });
    void (async () => {
      let textIndex = -1;
      let finishReason: BrowserChatChunk['choices'][number]['finish_reason'];
      let reportedTokens: number | undefined;
      const toolParts = new Map<number, { id: string; name: string; arguments: string }>();
      try {
        const input = browserChatInput(context);
        await engine.complete(input.messages, input.tools,
          options?.signal ?? new AbortController().signal, chunk => {
            if (options?.signal?.aborted) return;
            const choice = chunk.choices[0];
            const count = chunk.usage?.completion_tokens ?? chunk.timings?.predicted_n;
            if (Number.isSafeInteger(count) && count! >= 0)
              reportedTokens = Math.max(reportedTokens ?? 0, count!);
            const delta = choice?.delta;
            if (choice?.finish_reason && finishReason !== 'length' &&
                finishReason !== 'content_filter') finishReason = choice.finish_reason;
            if (delta?.content) {
              if (textIndex < 0) {
                textIndex = response.content.length;
                response.content.push({ type: 'text', text: '' });
                stream.push({ type: 'text_start', contentIndex: textIndex, partial: response });
              }
              const part = response.content[textIndex];
              if (part.type === 'text') part.text += delta.content;
              stream.push({ type: 'text_delta', contentIndex: textIndex,
                delta: delta.content, partial: response });
            }
            for (const call of delta?.tool_calls ?? []) {
              const part = toolParts.get(call.index) ?? { id: '', name: '', arguments: '' };
              part.id += call.id ?? '';
              part.name += call.function?.name ?? '';
              part.arguments += call.function?.arguments ?? '';
              toolParts.set(call.index, part);
            }
          });
        if (options?.signal?.aborted) throw new DOMException('Browser model turn aborted', 'AbortError');
        if (response.content.length === 0 && toolParts.size === 0)
          throw new Error('Browser model returned no answer or tool call');
        // Without an explicit terminal reason the model may have hit its token
        // ceiling; never turn an uncertified partial answer into a completed turn.
        if (finishReason === 'length' || finishReason === 'content_filter' ||
            (!finishReason && reportedTokens !== undefined && reportedTokens >= model.maxTokens) ||
            (finishReason === 'tool_calls' && toolParts.size === 0))
          throw new Error('Browser local model output truncated');
        if (!finishReason && reportedTokens === undefined)
          throw new Error('Browser model completion status unavailable');
        if (textIndex >= 0) {
          const part = response.content[textIndex];
          stream.push({ type: 'text_end', contentIndex: textIndex,
            content: part.type === 'text' ? part.text : '', partial: response });
        }
        const registered = new Set(input.tools.map(tool => tool.function.name));
        for (const [, part] of [...toolParts].sort(([a], [b]) => a - b)) {
          if (!registered.has(part.name)) throw new Error('Browser model named an unavailable tool');
          const args: unknown = JSON.parse(part.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('Browser model tool arguments must be an object');
          const call = { type: 'toolCall' as const, id: part.id || crypto.randomUUID(),
            name: part.name, arguments: args as Record<string, never> };
          const index = response.content.length;
          response.content.push(call);
          stream.push({ type: 'toolcall_start', contentIndex: index, partial: response });
          stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: call, partial: response });
        }
        if (response.content.length === 0 ||
          response.content.every(part => part.type === 'text' && !part.text.trim()))
          throw new Error('Browser model returned no answer or tool call');
        response.stopReason = toolParts.size ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: response.stopReason, message: response });
      } catch (error) {
        response.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        response.errorMessage = error instanceof Error && error.message === 'Browser local model output truncated'
          ? error.message : 'Browser local model turn failed';
        stream.push({ type: 'error', reason: response.stopReason, error: response });
      }
    })();
    return stream;
  };
}
