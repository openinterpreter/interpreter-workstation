import fs from 'node:fs';
import path from 'node:path';
import type { ClientRequest, IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type {
  AgentPort,
  AgentRun,
  AgentRunResult,
  AgentToolBatchPreview,
  StructuredScreenSnapshot,
  ToolCall,
  ToolExecutionResult,
} from '../../shared/ports.js';
import type {
  OverlayActPreviewMessage,
  OverlayAgentClientMessage,
  OverlayDebugTranscriptMessage,
  OverlayAgentServerMessage,
  OverlayRunCompletedMessage,
  OverlayRunErrorMessage,
  OverlayToolCallMessage,
} from '../../shared/agent-session.js';

export interface RemoteAgentConfig {
  getAccessToken: () => Promise<string> | string;
  model?: string;
  baseURL: string;
}

type ToolCallCallback = (tool: ToolCall, seq: number, resolve: (result: ToolExecutionResult) => void) => void;
type BatchPreviewCallback = (preview: AgentToolBatchPreview) => void;
type DoneCallback = (result: AgentRunResult) => void;

export interface OverlayTranscriptDebugEvent {
  kind: "llm.request" | "llm.response" | "conversation.message.append" | "tool.dispatch" | "tool.result";
  turn: number;
  attempt?: number;
  atMs?: number;
  durationMs?: number;
  payload: unknown;
}

const overlayTranscriptDebugEvents: OverlayTranscriptDebugEvent[] = [];
const defaultLogFilePath = process.env.LOG_FILE?.trim() || null;
const defaultTranscriptBasePath = defaultLogFilePath
  ? defaultLogFilePath.replace(/\.log$/i, '.transcript')
  : null;
const liveTranscriptTextPath =
  process.env.FORM_TESTS_LIVE_TRANSCRIPT_PATH?.trim()
  || (defaultTranscriptBasePath ? `${defaultTranscriptBasePath}.txt` : null);
const liveTranscriptJsonPath =
  process.env.FORM_TESTS_LIVE_TRANSCRIPT_JSON_PATH?.trim()
  || (defaultTranscriptBasePath ? `${defaultTranscriptBasePath}.json` : null);
const liveTranscriptHtmlPath =
  process.env.FORM_TESTS_LIVE_TRANSCRIPT_HTML_PATH?.trim()
  || (defaultTranscriptBasePath ? `${defaultTranscriptBasePath}.html` : null);

export function resetOverlayTranscriptDebugEvents(): void {
  overlayTranscriptDebugEvents.length = 0;
  persistOverlayTranscriptDebugEvents();
}

export function appendOverlayTranscriptDebugEvent(event: OverlayTranscriptDebugEvent): void {
  overlayTranscriptDebugEvents.push(structuredClone(event));
  persistOverlayTranscriptDebugEvents();
}

export function getOverlayTranscriptDebugEvents(): OverlayTranscriptDebugEvent[] {
  return overlayTranscriptDebugEvents.map((event) => ({
    ...event,
    payload: structuredClone(event.payload),
  }));
}

function formatTranscriptScalar(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return 'null';
  }
  return JSON.stringify(value, null, 2);
}

function isTranscriptImageResult(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && (value as Record<string, unknown>).kind === 'image';
}

function formatEventTiming(event: OverlayTranscriptDebugEvent): string[] {
  const lines: string[] = [];
  if (typeof event.atMs === 'number') {
    lines.push(`at: ${event.atMs}ms`);
  }
  if (typeof event.durationMs === 'number') {
    lines.push(`duration: ${event.durationMs}ms`);
  }
  return lines;
}

function formatOutputItemLines(item: unknown, indent = ''): string[] {
  if (!item || typeof item !== 'object') {
    return renderReadableTranscriptValue(item, indent);
  }

  const record = item as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'item';
  const lines = [`${indent}- ${type}`];

  if (type === 'reasoning' && Array.isArray(record.content)) {
    const summaryTexts = (record.content as unknown[])
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const contentRecord = entry as Record<string, unknown>;
        return typeof contentRecord.text === 'string' ? contentRecord.text : null;
      })
      .filter((value): value is string => Boolean(value));
    if (summaryTexts.length > 0) {
      lines.push(`${indent}  summary: |`);
      summaryTexts.join('\n\n').split('\n').forEach((line) => {
        lines.push(`${indent}    ${line}`);
      });
    }
    return lines;
  }

  if (type === 'function_call') {
    if (typeof record.name === 'string') {
      lines.push(`${indent}  name: ${record.name}`);
    }
    if (typeof record.arguments === 'string') {
      lines.push(`${indent}  arguments: |`);
      record.arguments.split('\n').forEach((line) => {
        lines.push(`${indent}    ${line}`);
      });
    }
    return lines;
  }

  if (type === 'computer_call') {
    const lines = [`${indent}- computer_call`];
    if (typeof record.call_id === 'string') {
      lines.push(`${indent}  call_id: ${record.call_id}`);
    }
    const actions = Array.isArray(record.actions) ? record.actions : [];
    if (actions.length > 0) {
      lines.push(`${indent}  actions:`);
      actions.forEach((action, index) => {
        lines.push(`${indent}    - [${index}]`);
        lines.push(...renderReadableTranscriptValue(action, `${indent}      `));
      });
    }
    return lines;
  }

  if (type === 'message' || type === 'output_text') {
    const text = typeof record.text === 'string'
      ? record.text
      : Array.isArray(record.content)
        ? (record.content as unknown[])
            .map((entry) => {
              if (!entry || typeof entry !== 'object') {
                return null;
              }
              const contentRecord = entry as Record<string, unknown>;
              return typeof contentRecord.text === 'string' ? contentRecord.text : null;
            })
            .filter((value): value is string => Boolean(value))
            .join('\n')
        : '';
    if (text) {
      lines.push(`${indent}  text: |`);
      text.split('\n').forEach((line) => {
        lines.push(`${indent}    ${line}`);
      });
    }
    return lines;
  }

  return [
    `${indent}- ${type}`,
    ...renderReadableTranscriptValue(item, `${indent}  `),
  ];
}

function formatInputItemLines(item: unknown, indent = ''): string[] {
  if (!item || typeof item !== 'object') {
    return renderReadableTranscriptValue(item, indent);
  }

  const record = item as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'item';
  const lines = [`${indent}- ${type}`];

  if (type === 'input_text' && typeof record.text === 'string') {
    lines.push(`${indent}  text: |`);
    record.text.split('\n').forEach((line) => {
      lines.push(`${indent}    ${line}`);
    });
    return lines;
  }

  if (type === 'input_image') {
    if (typeof record.local_image_path === 'string') {
      lines.push(`${indent}  image_path: ${record.local_image_path}`);
    }
    if (typeof record.annotated_image_path === 'string') {
      lines.push(`${indent}  annotated_image_path: ${record.annotated_image_path}`);
    }
    const nestedImage = record.image && typeof record.image === 'object'
      ? (record.image as Record<string, unknown>)
      : null;
    const fileId = typeof record.file_id === 'string'
      ? record.file_id
      : typeof record.fileId === 'string'
        ? record.fileId
        : typeof nestedImage?.id === 'string'
          ? nestedImage.id
          : null;
    if (fileId) {
      lines.push(`${indent}  file_id: ${fileId}`);
    }
    if (typeof record.detail === 'string') {
      lines.push(`${indent}  detail: ${record.detail}`);
    }
    return lines;
  }

  if (type === 'computer_call_output') {
    if (typeof record.call_id === 'string') {
      lines.push(`${indent}  call_id: ${record.call_id}`);
    }
    const output = record.output && typeof record.output === 'object'
      ? record.output as Record<string, unknown>
      : null;
    if (output) {
      lines.push(`${indent}  output:`);
      if (typeof output.type === 'string') {
        lines.push(`${indent}    type: ${output.type}`);
      }
      if (typeof output.local_image_path === 'string') {
        lines.push(`${indent}    image_path: ${output.local_image_path}`);
      }
      if (typeof output.annotated_image_path === 'string') {
        lines.push(`${indent}    annotated_image_path: ${output.annotated_image_path}`);
      }
      if (typeof output.detail === 'string') {
        lines.push(`${indent}    detail: ${output.detail}`);
      }
    }
    return lines;
  }

  return [
    `${indent}- ${type}`,
    ...renderReadableTranscriptValue(item, `${indent}  `),
  ];
}

function formatThreadTranscript(events: OverlayTranscriptDebugEvent[]): string {
  const lines: string[] = [];
  let currentInstructions: string | null = null;

  for (const event of events) {
    if (event.kind === 'llm.request') {
      const payload = event.payload as Record<string, unknown> | null;
      const instructions = payload && typeof payload.instructions === 'string'
        ? payload.instructions
        : null;
      if (instructions && instructions !== currentInstructions) {
        currentInstructions = instructions;
        lines.push('## SYSTEM');
        lines.push('');
        instructions.split('\n').forEach((line) => lines.push(line));
        lines.push('');
      }
      lines.push(`## MODEL INPUT | turn ${event.turn}`);
      lines.push('');
      lines.push(...formatEventTiming(event));
      const input = Array.isArray(payload?.input) ? payload.input : [];
      input.forEach((item, index) => {
        lines.push(`- input[${index}]`);
        lines.push(...formatInputItemLines(item, '  '));
      });
      if (typeof payload?.model === 'string') {
        lines.push(`model: ${payload.model}`);
      }
      if (typeof payload?.max_output_tokens === 'number') {
        lines.push(`max_output_tokens: ${payload.max_output_tokens}`);
      }
      if (typeof payload?.parallel_tool_calls === 'boolean') {
        lines.push(`parallel_tool_calls: ${payload.parallel_tool_calls}`);
      }
      lines.push('');
      continue;
    }

    if (event.kind === 'llm.response') {
      const payload = event.payload as Record<string, unknown> | null;
      const output = Array.isArray(payload?.output) ? payload.output : [];
      lines.push(`## MODEL OUTPUT | turn ${event.turn}`);
      lines.push('');
      lines.push(...formatEventTiming(event));
      output.forEach((item) => {
        lines.push(...formatOutputItemLines(item));
      });
      if (typeof payload?.responseId === 'string' && payload.responseId) {
        lines.push(`responseId: ${payload.responseId}`);
      }
      if (payload?.usage && typeof payload.usage === 'object') {
        lines.push('usage:');
        lines.push(...renderReadableTranscriptValue(payload.usage, '  '));
      }
      lines.push('');
      continue;
    }

    if (event.kind === 'conversation.message.append') {
      continue;
    }

    if (event.kind === 'tool.dispatch') {
      lines.push(`## TOOL DISPATCH | turn ${event.turn}`);
      lines.push('');
      lines.push(...formatEventTiming(event));
      lines.push(...renderReadableTranscriptValue(event.payload, ''));
      lines.push('');
      continue;
    }

    if (event.kind === 'tool.result') {
      lines.push(`## TOOL RESULT | turn ${event.turn}`);
      lines.push('');
      lines.push(...formatEventTiming(event));
      lines.push(...renderReadableTranscriptValue(event.payload, ''));
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderReadableTranscriptValue(value: unknown, indent = ''): string[] {
  if (isTranscriptImageResult(value)) {
    const record = value as Record<string, unknown>;
    const lines = [`${indent}kind: image`];
    if (typeof record.local_image_path === 'string') {
      lines.push(`${indent}image_path: ${record.local_image_path}`);
    }
    if (typeof record.annotated_image_path === 'string') {
      lines.push(`${indent}annotated_image_path: ${record.annotated_image_path}`);
    }
    if (typeof record.screenshotId === 'string') {
      lines.push(`${indent}screenshotId: ${record.screenshotId}`);
    }
    if (record.debug && typeof record.debug === 'object') {
      lines.push(`${indent}debug:`);
      lines.push(...renderReadableTranscriptValue(record.debug, `${indent}  `));
    }
    return lines;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.type === 'input_text') {
      return formatInputItemLines(value, indent);
    }
    if (record.type === 'input_image') {
      return formatInputItemLines(value, indent);
    }
  }
  if (typeof value === 'string') {
    return [`${indent}${value}`];
  }
  if (value == null || typeof value !== 'object') {
    return [`${indent}${formatTranscriptScalar(value)}`];
  }
  if (Array.isArray(value)) {
    const lines: string[] = [];
    value.forEach((entry, index) => {
      lines.push(`${indent}- [${index}]`);
      lines.push(...renderReadableTranscriptValue(entry, `${indent}  `));
    });
    return lines;
  }

  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      lines.push(`${indent}${key}:`);
      lines.push(...renderReadableTranscriptValue(entry, `${indent}  `));
      continue;
    }
    if (entry == null || typeof entry !== 'object') {
      lines.push(`${indent}${key}: ${formatTranscriptScalar(entry)}`);
      continue;
    }
    lines.push(`${indent}${key}:`);
    lines.push(...renderReadableTranscriptValue(entry, `${indent}  `));
  }
  return lines;
}

function formatLiveTranscript(events: OverlayTranscriptDebugEvent[]): string {
  return formatThreadTranscript(events);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtmlObject(value: unknown): string {
  if (isTranscriptImageResult(value)) {
    const record = value as Record<string, unknown>;
    const parts: string[] = ['<div class="item"><div class="label">image</div>'];
    if (typeof record.annotated_image_path === 'string') {
      parts.push(`<div class="meta">annotated_image_path: ${escapeHtml(record.annotated_image_path)}</div>`);
      parts.push(`<img class="shot" src="file://${encodeURI(record.annotated_image_path)}" alt="${escapeHtml(record.annotated_image_path)}">`);
    }
    if (typeof record.local_image_path === 'string') {
      parts.push(`<div class="meta">image_path: ${escapeHtml(record.local_image_path)}</div>`);
      parts.push(`<img class="shot" src="file://${encodeURI(record.local_image_path)}" alt="${escapeHtml(record.local_image_path)}">`);
    }
    if (typeof record.screenshotId === 'string') {
      parts.push(`<div class="meta">screenshotId: ${escapeHtml(record.screenshotId)}</div>`);
    }
    if (record.debug && typeof record.debug === 'object') {
      const debug = record.debug as Record<string, unknown>;
      if (typeof debug.durationMs === 'number') {
        parts.push(`<div class="timing">batch duration: ${debug.durationMs}ms</div>`);
      }
      parts.push(renderHtmlActionTimings(debug.actionTimings));
    }
    parts.push('</div>');
    return parts.join('');
  }
  if (typeof value === 'string') {
    return `<pre>${escapeHtml(value)}</pre>`;
  }
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function renderHtmlActionTimings(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return '';
  }

  const parts = ['<div class="label">action timings</div>'];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      parts.push(renderHtmlObject(entry));
      return;
    }
    const record = entry as Record<string, unknown>;
    const seq = typeof record.seq === 'number' ? record.seq : index;
    const tool = typeof record.tool === 'string' ? record.tool : 'unknown';
    const durationMs = typeof record.durationMs === 'number' ? record.durationMs : null;
    const status = typeof record.status === 'string' ? record.status : 'unknown';
    const error = typeof record.error === 'string' ? record.error : null;
    parts.push('<div class="item">');
    parts.push(`<div class="meta">seq ${seq} · ${escapeHtml(tool)} · ${escapeHtml(status)}</div>`);
    if (durationMs !== null) {
      parts.push(`<div class="timing">duration: ${durationMs}ms</div>`);
    }
    if (error) {
      parts.push(`<pre>${escapeHtml(error)}</pre>`);
    }
    parts.push('</div>');
  });
  return parts.join('');
}

function renderHtmlToolResultPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return renderHtmlObject(payload);
  }

  const record = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.seq === 'number') {
    parts.push(`<div class="meta">seq: ${record.seq}</div>`);
  }
  if (record.tool) {
    parts.push('<div class="label">tool</div>');
    parts.push(renderHtmlObject(record.tool));
  }
  if (record.content) {
    parts.push('<div class="label">content</div>');
    parts.push(renderHtmlObject(record.content));
  }
  return parts.join('');
}

function renderHtmlInputItem(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return renderHtmlObject(item);
  }

  const record = item as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'item';

  if (type === 'input_text' && typeof record.text === 'string') {
    return `<div class="item"><div class="label">input_text</div><pre>${escapeHtml(record.text)}</pre></div>`;
  }

  if (type === 'input_image') {
    const nestedImage = record.image && typeof record.image === 'object'
      ? (record.image as Record<string, unknown>)
      : null;
    const localPath = typeof record.local_image_path === 'string' ? record.local_image_path : null;
    const fileId = typeof record.file_id === 'string'
      ? record.file_id
      : typeof record.fileId === 'string'
        ? record.fileId
        : typeof nestedImage?.id === 'string'
          ? nestedImage.id
          : null;
    const parts: string[] = ['<div class="item"><div class="label">input_image</div>'];
    if (localPath) {
      parts.push(`<div class="meta">image_path: ${escapeHtml(localPath)}</div>`);
      parts.push(`<img class="shot" src="file://${encodeURI(localPath)}" alt="${escapeHtml(localPath)}">`);
    }
    if (typeof record.annotated_image_path === 'string') {
      parts.push(`<div class="meta">annotated_image_path: ${escapeHtml(record.annotated_image_path)}</div>`);
      parts.push(`<img class="shot" src="file://${encodeURI(record.annotated_image_path)}" alt="${escapeHtml(record.annotated_image_path)}">`);
    }
    if (fileId) {
      parts.push(`<div class="meta">file_id: ${escapeHtml(fileId)}</div>`);
    }
    if (typeof record.detail === 'string') {
      parts.push(`<div class="meta">detail: ${escapeHtml(record.detail)}</div>`);
    }
    parts.push('</div>');
    return parts.join('');
  }

  if (type === 'computer_call_output') {
    const output = record.output && typeof record.output === 'object'
      ? record.output as Record<string, unknown>
      : null;
    const parts: string[] = ['<div class="item"><div class="label">computer_call_output</div>'];
    if (typeof record.call_id === 'string') {
      parts.push(`<div class="meta">call_id: ${escapeHtml(record.call_id)}</div>`);
    }
    if (output) {
      if (typeof output.type === 'string') {
        parts.push(`<div class="meta">output.type: ${escapeHtml(output.type)}</div>`);
      }
      if (typeof output.local_image_path === 'string') {
        parts.push(`<div class="meta">image_path: ${escapeHtml(output.local_image_path)}</div>`);
        parts.push(`<img class="shot" src="file://${encodeURI(output.local_image_path)}" alt="${escapeHtml(output.local_image_path)}">`);
      }
      if (typeof output.annotated_image_path === 'string') {
        parts.push(`<div class="meta">annotated_image_path: ${escapeHtml(output.annotated_image_path)}</div>`);
        parts.push(`<img class="shot" src="file://${encodeURI(output.annotated_image_path)}" alt="${escapeHtml(output.annotated_image_path)}">`);
      }
      if (typeof output.detail === 'string') {
        parts.push(`<div class="meta">detail: ${escapeHtml(output.detail)}</div>`);
      }
    }
    parts.push('</div>');
    return parts.join('');
  }

  return renderHtmlObject(item);
}

function renderHtmlOutputItem(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return renderHtmlObject(item);
  }

  const record = item as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'item';

  if (type === 'reasoning') {
    const content = Array.isArray(record.content) ? record.content : [];
    const summary = content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const contentRecord = entry as Record<string, unknown>;
        return typeof contentRecord.text === 'string' ? contentRecord.text : null;
      })
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
    return `<div class="item"><div class="label">reasoning</div>${summary ? `<pre>${escapeHtml(summary)}</pre>` : '<pre>(empty)</pre>'}</div>`;
  }

  if (type === 'function_call') {
    const name = typeof record.name === 'string' ? record.name : 'unknown';
    const args = typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {}, null, 2);
    return `<div class="item"><div class="label">function_call: ${escapeHtml(name)}</div><pre>${escapeHtml(args)}</pre></div>`;
  }

  if (type === 'computer_call') {
    const parts: string[] = ['<div class="item"><div class="label">computer_call</div>'];
    if (typeof record.call_id === 'string') {
      parts.push(`<div class="meta">call_id: ${escapeHtml(record.call_id)}</div>`);
    }
    if (Array.isArray(record.actions)) {
      parts.push('<div class="label">actions</div>');
      parts.push(renderHtmlObject(record.actions));
    }
    parts.push('</div>');
    return parts.join('');
  }

  if (type === 'message' || type === 'output_text') {
    const text = typeof record.text === 'string'
      ? record.text
      : Array.isArray(record.content)
        ? (record.content as unknown[])
            .map((entry) => {
              if (!entry || typeof entry !== 'object') {
                return null;
              }
              const contentRecord = entry as Record<string, unknown>;
              return typeof contentRecord.text === 'string' ? contentRecord.text : null;
            })
            .filter((value): value is string => Boolean(value))
            .join('\n')
        : '';
    return `<div class="item"><div class="label">${escapeHtml(type)}</div><pre>${escapeHtml(text)}</pre></div>`;
  }

  return renderHtmlObject(item);
}

function formatLiveTranscriptHtml(events: OverlayTranscriptDebugEvent[]): string {
  const parts: string[] = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Overlay Transcript</title><style>',
    'body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#111;color:#eee;margin:0;padding:24px;line-height:1.45}',
    '.event{border:1px solid #333;border-radius:12px;padding:16px;margin:0 0 16px;background:#181818}',
    '.kind{font-size:12px;color:#9aa4b2;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}',
    '.meta{font-size:12px;color:#a7b0bd;margin:6px 0}',
    '.timing{font-size:12px;color:#ff5b5b;font-weight:700;margin:6px 0}',
    '.label{font-weight:700;margin:10px 0 6px}',
    'pre{white-space:pre-wrap;word-break:break-word;background:#0f0f0f;padding:12px;border-radius:8px;overflow:auto}',
    '.shot{display:block;max-width:100%;height:auto;border-radius:8px;border:1px solid #333;margin:10px 0}',
    '</style></head><body>',
    '<h1>Overlay Transcript</h1>',
  ];

  let currentInstructions: string | null = null;

  for (const event of events) {
    if (event.kind === 'llm.request') {
      const payload = event.payload as Record<string, unknown> | null;
      const instructions = payload && typeof payload.instructions === 'string'
        ? payload.instructions
        : null;
      if (instructions && instructions !== currentInstructions) {
        currentInstructions = instructions;
        parts.push('<section class="event">');
        parts.push('<div class="kind">system</div>');
        parts.push(`<pre>${escapeHtml(instructions)}</pre>`);
        parts.push('</section>');
      }
      parts.push(`<section class="event"><div class="kind">model input · turn ${event.turn}</div>`);
      if (typeof event.atMs === 'number') {
        parts.push(`<div class="timing">at: ${event.atMs}ms</div>`);
      }
      if (typeof event.durationMs === 'number') {
        parts.push(`<div class="timing">duration: ${event.durationMs}ms</div>`);
      }
      const input = Array.isArray(payload?.input) ? payload.input : [];
      input.forEach((item) => {
        parts.push(renderHtmlInputItem(item));
      });
      if (typeof payload?.model === 'string') {
        parts.push(`<div class="meta">model: ${escapeHtml(payload.model)}</div>`);
      }
      if (typeof payload?.max_output_tokens === 'number') {
        parts.push(`<div class="meta">max_output_tokens: ${payload.max_output_tokens}</div>`);
      }
      if (typeof payload?.parallel_tool_calls === 'boolean') {
        parts.push(`<div class="meta">parallel_tool_calls: ${payload.parallel_tool_calls}</div>`);
      }
      parts.push('</section>');
      continue;
    }

    if (event.kind === 'llm.response') {
      const payload = event.payload as Record<string, unknown> | null;
      const output = Array.isArray(payload?.output) ? payload.output : [];
      parts.push(`<section class="event"><div class="kind">model output · turn ${event.turn}</div>`);
      if (typeof event.atMs === 'number') {
        parts.push(`<div class="timing">at: ${event.atMs}ms</div>`);
      }
      if (typeof event.durationMs === 'number') {
        parts.push(`<div class="timing">duration: ${event.durationMs}ms</div>`);
      }
      output.forEach((item) => {
        parts.push(renderHtmlOutputItem(item));
      });
      if (typeof payload?.responseId === 'string' && payload.responseId) {
        parts.push(`<div class="meta">responseId: ${escapeHtml(payload.responseId)}</div>`);
      }
      if (payload?.usage) {
        parts.push('<div class="label">usage</div>');
        parts.push(renderHtmlObject(payload.usage));
      }
      parts.push('</section>');
      continue;
    }

    if (event.kind === 'conversation.message.append') {
      continue;
    }

    parts.push(`<section class="event"><div class="kind">${escapeHtml(event.kind)} · turn ${event.turn}</div>`);
    if (typeof event.atMs === 'number') {
      parts.push(`<div class="timing">at: ${event.atMs}ms</div>`);
    }
    if (typeof event.durationMs === 'number') {
      parts.push(`<div class="timing">duration: ${event.durationMs}ms</div>`);
    }
    if (event.kind === 'tool.result' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload as Record<string, unknown>;
      const content = payload.content && typeof payload.content === 'object'
        ? payload.content as Record<string, unknown>
        : null;
      const debug = content?.debug && typeof content.debug === 'object'
        ? content.debug as Record<string, unknown>
        : null;
      if (typeof debug?.durationMs === 'number') {
        parts.push(`<div class="timing">batch duration: ${debug.durationMs}ms</div>`);
      }
      parts.push(renderHtmlActionTimings(debug?.actionTimings));
      parts.push(renderHtmlToolResultPayload(event.payload));
      parts.push('</section>');
      continue;
    }
    parts.push(renderHtmlObject(event.payload));
    parts.push('</section>');
  }

  parts.push('</body></html>');
  return parts.join('');
}

function persistOverlayTranscriptDebugEvents(): void {
  try {
    if (liveTranscriptJsonPath) {
      fs.mkdirSync(path.dirname(liveTranscriptJsonPath), { recursive: true });
      fs.writeFileSync(
        liveTranscriptJsonPath,
        `${JSON.stringify(overlayTranscriptDebugEvents, null, 2)}\n`,
      );
    }
  } catch {}
  try {
    if (liveTranscriptTextPath) {
      fs.mkdirSync(path.dirname(liveTranscriptTextPath), { recursive: true });
      fs.writeFileSync(liveTranscriptTextPath, formatLiveTranscript(overlayTranscriptDebugEvents));
    }
  } catch {}
  try {
    if (liveTranscriptHtmlPath) {
      fs.mkdirSync(path.dirname(liveTranscriptHtmlPath), { recursive: true });
      fs.writeFileSync(liveTranscriptHtmlPath, formatLiveTranscriptHtml(overlayTranscriptDebugEvents));
    }
  } catch {}
}

function toWebSocketUrl(baseURL: string): string {
  const url = new URL(baseURL.trim());
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else {
    throw new Error(`Unsupported overlay agent server protocol: ${url.protocol}`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/agent/session`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[unserializable: ${message}]`;
  }
}

function summarizeStructuredSnapshot(snapshot: StructuredScreenSnapshot): Record<string, unknown> {
  return {
    formattedTextLength: snapshot.formattedText.length,
    elementCount: snapshot.elements.length,
    focusedMenuElementId: snapshot.focusedMenuElementId,
    formattedText: snapshot.formattedText,
    elements: snapshot.elements,
  };
}

function summarizeToolResult(result: ToolExecutionResult): Record<string, unknown> {
  if (result.kind === 'text') {
    return {
      kind: result.kind,
      text: result.text,
    };
  }

  if (result.kind === 'structured-screen') {
    return {
      kind: result.kind,
      snapshot: summarizeStructuredSnapshot(result.snapshot),
    };
  }

  return {
    kind: result.kind,
    screenshotId: result.screenshotId,
    screenshotBase64Length: typeof result.screenshotBase64 === 'string'
      ? result.screenshotBase64.length
      : 0,
  };
}

function parseServerMessage(raw: string): OverlayAgentServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
    return null;
  }

  const message = parsed as Record<string, unknown>;

  if (
    message.type === 'act.preview'
    && typeof message.batchId === 'string'
    && typeof message.turn === 'number'
    && Array.isArray(message.actions)
  ) {
    return message as unknown as OverlayActPreviewMessage;
  }

  if (message.type === 'tool.call' && typeof message.seq === 'number' && message.tool && typeof message.tool === 'object') {
    return message as unknown as OverlayToolCallMessage;
  }

  if (message.type === 'run.completed' && typeof message.finalText === 'string') {
    return message as unknown as OverlayRunCompletedMessage;
  }

  if (message.type === 'run.error' && typeof message.message === 'string') {
    return message as unknown as OverlayRunErrorMessage;
  }

  if (
    message.type === 'debug.transcript' &&
    message.event &&
    typeof message.event === 'object' &&
    typeof (message.event as { kind?: unknown }).kind === 'string' &&
    typeof (message.event as { turn?: unknown }).turn === 'number'
  ) {
    return message as unknown as OverlayDebugTranscriptMessage;
  }

  return null;
}

export function createRemoteAgent(config: RemoteAgentConfig): AgentPort {
  const {
    getAccessToken,
    model,
    baseURL,
  } = config;

  async function start(
    conversationId: string,
    userText: string,
    abortSignal: AbortSignal,
    options?: {
      initialSnapshot?: StructuredScreenSnapshot;
      initialImageCapture?: {
        screenshotId: string;
        screenshotBase64: string;
      };
      computerEnvironment?: 'windows' | 'mac' | 'linux';
      systemAddendum?: string;
      userAttachments?: import('../../shared/ipc.js').OverlayUserAttachment[];
      screenRegions?: import('../../shared/ipc.js').OverlayScreenQueryRegion[];
    },
  ): Promise<AgentRun> {
    if (abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    if (!options?.computerEnvironment) {
      throw new Error('Overlay remote agent requires a computer environment.');
    }
    const computerEnvironment = options.computerEnvironment;

    const token = await getAccessToken();
    const ws = new WebSocket(toWebSocketUrl(baseURL), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    let toolCallCallback: ToolCallCallback | null = null;
    let batchPreviewCallback: BatchPreviewCallback | null = null;
    let doneCallback: DoneCallback | null = null;
    let aborted = false;
    let terminalResult: AgentRunResult | null = null;
    let completed = false;
    const pendingBatchPreviews: AgentToolBatchPreview[] = [];
    const pendingToolCalls: OverlayToolCallMessage[] = [];
    let toolCallInFlight = false;

    const flushBatchPreviews = () => {
      if (!batchPreviewCallback || pendingBatchPreviews.length === 0 || completed || aborted) {
        return;
      }

      while (pendingBatchPreviews.length > 0) {
        batchPreviewCallback(pendingBatchPreviews.shift()!);
      }
    };

    const flushToolCalls = () => {
      if (!toolCallCallback || pendingToolCalls.length === 0 || completed || aborted || toolCallInFlight) {
        return;
      }

      const emitToolCall = toolCallCallback;
      if (!emitToolCall) {
        return;
      }

      const message = pendingToolCalls.shift()!;
      toolCallInFlight = true;
      emitToolCall(message.tool, message.seq, (result: ToolExecutionResult) => {
        toolCallInFlight = false;

        if (completed || aborted || ws.readyState !== WebSocket.OPEN) {
          return;
        }

        const payload: OverlayAgentClientMessage = {
          type: 'tool.result',
          seq: message.seq,
          result,
        };
        console.log(
          `[OverlayRemoteAgent] Sending tool.result\n${stringifyForLog({
            seq: message.seq,
            result: summarizeToolResult(result),
          })}`,
        );
        ws.send(JSON.stringify(payload));
        flushToolCalls();
      });
    };

    const flushTerminalMessage = () => {
      if (!doneCallback || terminalResult === null) {
        return;
      }

      const next = terminalResult;
      terminalResult = null;
      doneCallback(next);
    };

    const markDone = (result: AgentRunResult) => {
      if (completed) {
        return;
      }

      completed = true;
      terminalResult = result;
      flushTerminalMessage();
    };

    ws.on('open', () => {
      const payload: OverlayAgentClientMessage = {
        type: 'run.start',
        conversationId,
        userText,
        ...(options?.systemAddendum ? { systemAddendum: options.systemAddendum } : {}),
        ...(model ? { model } : {}),
        computerEnvironment,
        ...(options?.initialSnapshot ? { initialSnapshot: options.initialSnapshot } : {}),
        ...(options?.initialImageCapture ? { initialImageCapture: options.initialImageCapture } : {}),
        ...(options?.userAttachments && options.userAttachments.length > 0
          ? { userAttachments: options.userAttachments }
          : {}),
        ...(options?.screenRegions && options.screenRegions.length > 0
          ? { screenRegions: options.screenRegions }
          : {}),
      };
      console.log(
        `[OverlayRemoteAgent] Sending run.start\n${stringifyForLog({
          conversationId,
          model: model ?? null,
          userText,
          systemAddendum: options?.systemAddendum ?? null,
          computerEnvironment,
          initialSnapshot: options?.initialSnapshot
            ? summarizeStructuredSnapshot(options.initialSnapshot)
            : null,
          initialImageCapture: options?.initialImageCapture
            ? {
                screenshotId: options.initialImageCapture.screenshotId,
                screenshotBase64Length: options.initialImageCapture.screenshotBase64.length,
              }
            : null,
          userAttachments: options?.userAttachments
            ? options.userAttachments.map((att) => ({
                id: att.id,
                name: att.name,
                mimeType: att.mimeType,
                dataUrlLength: att.dataUrl?.length ?? 0,
                extractedTextLength: att.extractedText?.length ?? 0,
              }))
            : null,
          screenRegions: options?.screenRegions
            ? options.screenRegions.map((region) => ({
                id: region.id,
                role: region.role,
                label: region.label,
                bounds: region.bounds,
                displayId: region.displayId,
              }))
            : null,
        })}`,
      );
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (data: unknown) => {
      const raw = String(data);
      const message = parseServerMessage(raw);
      if (!message) {
        console.warn(`[OverlayRemoteAgent] Ignoring invalid server message\n${raw}`);
        return;
      }

      if (message.type === 'tool.call') {
        console.log(
          `[OverlayRemoteAgent] Received tool.call\n${stringifyForLog({
            seq: message.seq,
            tool: message.tool,
          })}`,
        );
      } else if (message.type === 'act.preview') {
        console.log(
          `[OverlayRemoteAgent] Received act.preview\n${stringifyForLog({
            batchId: message.batchId,
            turn: message.turn,
            actions: message.actions,
          })}`,
        );
      } else if (message.type === 'run.completed') {
        console.log(
          `[OverlayRemoteAgent] Received run.completed\n${stringifyForLog({
            finalText: message.finalText,
          })}`,
        );
      } else if (message.type === 'run.error') {
        console.error(
          `[OverlayRemoteAgent] Received run.error\n${stringifyForLog({
            message: message.message,
          })}`,
        );
      } else {
        overlayTranscriptDebugEvents.push(structuredClone(message.event));
        persistOverlayTranscriptDebugEvents();
        console.log(
          `[OverlayRemoteAgent] Received debug.transcript\n${stringifyForLog(message.event)}`,
        );
      }

      if (message.type === 'act.preview') {
        pendingBatchPreviews.push({
          batchId: message.batchId,
          turn: message.turn,
          actions: message.actions.map((action) => ({
            seq: action.seq,
            tool: action.tool,
          })),
        });
        flushBatchPreviews();
        return;
      }

      if (message.type === 'tool.call') {
        pendingToolCalls.push(message);
        flushToolCalls();
        return;
      }

      if (message.type === 'run.completed') {
        markDone({
          status: 'completed',
          finalText: message.finalText,
          reason: 'completed',
        });
        ws.close();
        return;
      }

      if (message.type === 'debug.transcript') {
        return;
      }

      markDone({
        status: 'failed',
        finalText: message.message,
        reason: message.message,
      });
      ws.close();
    });

    ws.on('error', (error: unknown) => {
      if (aborted || completed) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      markDone({
        status: 'failed',
        finalText: `Agent error: ${message}`,
        reason: message,
      });
    });

    ws.on('unexpected-response', (_request: ClientRequest, response: IncomingMessage) => {
      if (aborted || completed) {
        return;
      }

      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        const message = `Unexpected server response ${response.statusCode}${body ? `: ${body}` : ''}`;
        markDone({
          status: 'failed',
          finalText: `Agent error: ${message}`,
          reason: message,
        });
      });
    });

    ws.on('close', () => {
      if (aborted || completed) {
        return;
      }

      markDone({
        status: 'failed',
        finalText: 'Agent error: Remote overlay agent disconnected',
        reason: 'Remote overlay agent disconnected',
      });
    });

    abortSignal.addEventListener('abort', () => {
      aborted = true;
      markDone({
        status: 'cancelled',
        finalText: 'Agent run aborted',
        reason: 'cancelled',
      });
      if (ws.readyState === WebSocket.OPEN) {
        const payload: OverlayAgentClientMessage = { type: 'run.cancel' };
        ws.send(JSON.stringify(payload));
      }
      ws.close();
    }, { once: true });

    return {
      onBatchPreview(cb) {
        batchPreviewCallback = cb;
        flushBatchPreviews();
      },

      onToolCall(cb) {
        toolCallCallback = cb;
        flushToolCalls();
      },

      onDone(cb) {
        doneCallback = cb;
        flushTerminalMessage();
      },

      abort() {
        if (aborted || completed) {
          return;
        }

        aborted = true;
        markDone({
          status: 'cancelled',
          finalText: 'Agent run aborted',
          reason: 'cancelled',
        });
        if (ws.readyState === WebSocket.OPEN) {
          const payload: OverlayAgentClientMessage = { type: 'run.cancel' };
          ws.send(JSON.stringify(payload));
        }
        ws.close();
      },
    };
  }

  return {
    start,
  };
}
