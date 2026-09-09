import { spawn } from 'node:child_process';
import { resolveBasemindBinary } from '../utils/basemindManager';

export type BasemindDownloadStage = 'embeddings' | 'reranker' | 'nerModel';

export interface CpuFeatures {
  arch: string;
  avx2: boolean;
  avx: boolean;
  sse4_1: boolean;
  sse4_2: boolean;
  neon: boolean;
}

export interface BasemindDownloadProgress {
  stage: BasemindDownloadStage;
  progress: number;
  done: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}

interface StageConfig {
  stage: BasemindDownloadStage;
  args: string[];
  requiresAvx2: boolean;
}

const STAGES: StageConfig[] = [
  {
    stage: 'embeddings',
    args: ['code', 'semantic', '"warmup"', '--limit', '1'],
    requiresAvx2: false,
  },
  {
    stage: 'reranker',
    args: ['code', 'semantic', '--rerank', '"warmup"', '--limit', '1'],
    requiresAvx2: true,
  },
  {
    stage: 'nerModel',
    args: ['memory', 'documents', '"warmup"', '--limit', '1'],
    requiresAvx2: true,
  },
];

function isCompatible(config: StageConfig, cpu?: CpuFeatures): boolean {
  if (!config.requiresAvx2) return true;
  if (!cpu) return true;
  if (cpu.arch === 'aarch64') return cpu.neon;
  if (cpu.arch === 'x86_64') return cpu.avx2;
  return true;
}

function runBasemindCommand(
  binary: string,
  args: string[],
  onStderr?: (data: string) => void,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: 'pipe' });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stderr });
    });
    child.on('error', () => {
      resolve({ code: 1, stderr: 'spawn error' });
    });
  });
}

/**
 * Download all Basemind global resources sequentially.
 * Yields progress updates per stage.
 *
 * Stage mapping:
 *   embeddings -> basemind code semantic "warmup" (triggers embedding model download)
 *   reranker   -> basemind code semantic --rerank "warmup" (triggers reranker model download)
 *   nerModel   -> basemind memory documents "warmup" (triggers NER model download)
 */
export async function* basemindDownload(
  cpuFeatures?: CpuFeatures,
): AsyncGenerator<BasemindDownloadProgress> {
  const binary = resolveBasemindBinary();
  if (!binary) {
    for (const config of STAGES) {
      yield { stage: config.stage, progress: 0, done: false, error: 'basemind binary not found' };
    }
    return;
  }

  for (const config of STAGES) {
    yield { stage: config.stage, progress: 0, done: false };

    if (!isCompatible(config, cpuFeatures)) {
      yield {
        stage: config.stage,
        progress: 100,
        done: true,
        skipped: true,
        skipReason: 'CPU incompatible',
      };
      continue;
    }

    let lastProgress = 0;

    try {
      const { code, stderr } = await runBasemindCommand(binary, config.args, (text) => {
        const match = text.match(/progress=(\d+)/);
        if (match) {
          const progress = Math.min(99, parseInt(match[1], 10));
          if (progress !== lastProgress) {
            lastProgress = progress;
          }
        }
      });

      if (code === 132) {
        yield {
          stage: config.stage,
          progress: 0,
          done: false,
          error: 'CPU incompatible (SIGILL)',
        };
        continue;
      }

      if (code !== 0) {
        yield {
          stage: config.stage,
          progress: lastProgress,
          done: false,
          error: stderr || `exit code ${code}`,
        };
        continue;
      }

      yield { stage: config.stage, progress: 100, done: true };
    } catch (err) {
      yield {
        stage: config.stage,
        progress: lastProgress,
        done: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
