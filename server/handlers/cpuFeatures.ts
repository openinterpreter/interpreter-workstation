import { resolveBasemindBinary } from '../utils/basemindManager';
import { spawn } from 'node:child_process';

const DEFAULT_FEATURES = { arch: 'unknown', avx2: false, avx: false, sse4_1: false, sse4_2: false, neon: false };

/**
 * Detect CPU feature flags by shelling out to `basemind cpu-features`.
 * Returns a safe fallback on any error — the UI decides what to do.
 */
export async function cpuFeatures(): Promise<{ arch: string; avx2: boolean; avx: boolean; sse4_1: boolean; sse4_2: boolean; neon: boolean }> {
  const binary = resolveBasemindBinary();
  if (!binary) return DEFAULT_FEATURES;

  return new Promise((resolve) => {
    const child = spawn(binary, ['cpu-features'], { stdio: 'pipe' });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout.trim())); }
        catch { resolve(DEFAULT_FEATURES); }
      } else {
        resolve(DEFAULT_FEATURES);
      }
    });
    child.on('error', () => resolve(DEFAULT_FEATURES));
  });
}
