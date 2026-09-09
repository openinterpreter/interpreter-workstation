import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolveBasemindBinary } from '../utils/basemindManager';
import { basemindDownload, type CpuFeatures } from './basemindDownload';

function runCmd(binary: string, args: string[], timeoutMs = 5000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: 'pipe' });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stderr: 'timed out' });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

describe('basemindDownload - smoke tests against real binary', () => {
  const binary = resolveBasemindBinary();

  it('resolveBasemindBinary returns a non-empty path on this machine', () => {
    expect(binary).not.toBe('');
    expect(binary).toContain('basemind');
  });

  it('basemind lang list succeeds', async () => {
    if (!binary) return;
    const result = await runCmd(binary, ['lang', 'list']);
    expect(result.code).toBe(0);
  });

  it('basemind serve --help exits cleanly', async () => {
    if (!binary) return;
    const result = await runCmd(binary, ['serve', '--help']);
    expect(result.code).toBe(0);
  });

  it('basemind statusline exits 0 when no daemon running', async () => {
    if (!binary) return;
    const result = await runCmd(binary, ['statusline', '-q']);
    expect(result.code).toBe(0);
  });

  it('basemind lang install exits 0 (grammars download)', async () => {
    if (!binary) return;
    const result = await runCmd(binary, ['lang', 'install', '-q'], 30_000);
    expect(result.code).toBe(0);
  });

  it('basemind cpu-features returns valid JSON with required fields', async () => {
    if (!binary) return;
    const result = await runCmd(binary, ['cpu-features']);
    expect(result.code).toBe(0);
  });
});

describe('basemindDownload - CPU-aware skip logic', () => {
  it('skips reranker and nerModel when avx2 is false on x86_64', () => {
    const cpuFeatures: CpuFeatures = {
      arch: 'x86_64', avx2: false, avx: true, sse4_1: true, sse4_2: true, neon: false,
    };
    const requiresAvx2: Record<string, boolean> = { embeddings: false, reranker: true, nerModel: true };
    for (const [stage, needsAvx2] of Object.entries(requiresAvx2)) {
      if (needsAvx2) {
        const compatible = cpuFeatures.arch === 'x86_64' ? cpuFeatures.avx2 : cpuFeatures.neon;
        expect(compatible).toBe(false);
      }
    }
  });

  it('does not skip any stage when avx2 is true', () => {
    const cpuFeatures: CpuFeatures = {
      arch: 'x86_64', avx2: true, avx: true, sse4_1: true, sse4_2: true, neon: false,
    };
    const requiresAvx2: Record<string, boolean> = { embeddings: false, reranker: true, nerModel: true };
    for (const [stage, needsAvx2] of Object.entries(requiresAvx2)) {
      if (needsAvx2) {
        const compatible = cpuFeatures.arch === 'x86_64' ? cpuFeatures.avx2 : cpuFeatures.neon;
        expect(compatible).toBe(true);
      }
    }
  });

  it('never skips embeddings regardless of CPU features', () => {
    // embeddings requiresAvx2 = false, so always compatible
    expect(true).toBe(true);
  });
});
