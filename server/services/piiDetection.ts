/**
 * PiiDetectionService — main-process PII detection with MCP fallback.
 *
 * Single-engine decision: detection runs through basemind's `redact_text`
 * tool (the same xberg pipeline as document extraction) instead of loading
 * a second GLiNER copy into Electron. The local model cache is used only as
 * a readiness signal; no ONNX inference is fabricated in this process.
 */

import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';

import { ToolManager } from '../tools/toolManager';

export interface PiiDetectionResult {
  category: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export interface RedactTextResult {
  redacted_text: string;
  rehydration_map: Record<string, string>;
  detections: PiiDetectionResult[];
}

const MODEL_SEARCH_PATTERNS = [
  'models--xberg-io--gliner-pii-models',
  'models--knowledgator--gliner-pii-edge-v1.0',
  'models--xberg-io--gliner-models',
];

export function resolvePiiModelBaseDir(homeDir = homedir()): string {
  const override = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (override) return path.join(override, 'basemind-hub');
  return path.join(homeDir, '.local', 'share', 'basemind', 'hub');
}

export function isPiiModelReady(baseDir = resolvePiiModelBaseDir()): boolean {
  return MODEL_SEARCH_PATTERNS.some((pattern) => {
    const dir = path.join(baseDir, pattern);
    if (!fs.existsSync(dir)) return false;
    try {
      return fs.readdirSync(dir).some((entry) => entry.endsWith('.onnx'));
    } catch {
      return false;
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asDetections(value: unknown): PiiDetectionResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      const category = typeof record.category === 'string' ? record.category : 'unknown';
      const start = typeof record.start === 'number' ? record.start : 0;
      const end = typeof record.end === 'number' ? record.end : start;
      const text = typeof record.text === 'string' ? record.text : '';
      const confidence = typeof record.confidence === 'number' ? record.confidence : 0.5;
      return { category, start, end, text, confidence };
    })
    .filter((entry): entry is PiiDetectionResult => entry !== null);
}

/** Map a basemind `redact_text` tool result onto the renderer PII contract. */
export function parseRedactTextResult(result: unknown): RedactTextResult {
  const record = asRecord(result) ?? {};
  const structured = asRecord(record.structuredContent) ?? record;
  const payload = asRecord(structured.result) ?? structured;
  const redactedText =
    typeof payload.redacted_text === 'string' ? payload.redacted_text : '';
  const rawMap = asRecord(payload.rehydration_map) ?? {};
  const rehydrationMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawMap)) {
    if (typeof value === 'string') rehydrationMap[key] = value;
  }
  return {
    redacted_text: redactedText,
    rehydration_map: rehydrationMap,
    detections: asDetections(payload.detections),
  };
}

async function detectPii(
  text: string,
  options?: { categories?: string[]; minConfidence?: number },
): Promise<PiiDetectionResult[]> {
  const manager = new ToolManager();
  const raw = await manager.callTool('basemind', 'redact_text', {
    text,
    categories: options?.categories ?? [],
  });
  const parsed = parseRedactTextResult(raw);
  const minConfidence = options?.minConfidence ?? 0;
  return parsed.detections.filter((detection) => detection.confidence >= minConfidence);
}

export const piiDetectionService = {
  detectPii,
  isPiiModelReady,
  parseRedactTextResult,
};
