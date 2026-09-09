import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkspaceScanStatus } from './workspaceScan';

const MIRRORED_REPOS = {
  embeddings: 'models--xberg-io--embedding-models',
  reranker: 'models--xberg-io--reranker-models',
  nerModel: 'models--xberg-io--gliner-models',
} as const;

let cacheDir: string;
let savedEnv: Record<string, string | undefined>;

function seedArtifact(repoDir: string) {
  const snapDir = join(cacheDir, 'hub', repoDir, 'snapshots', 'rev123');
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, 'model.onnx'), 'fake-bytes');
}

describe('workspaceScan resourcesReady — truthful model presence', () => {
  beforeEach(() => {
    savedEnv = {
      HF_HUB_CACHE: process.env.HF_HUB_CACHE,
      HUGGINGFACE_HUB_CACHE: process.env.HUGGINGFACE_HUB_CACHE,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      HOME: process.env.HOME,
    };
    cacheDir = mkdtempSync(join(tmpdir(), 'hb-cache-'));
    process.env.HF_HUB_CACHE = join(cacheDir, 'hub');
    process.env.HUGGINGFACE_HUB_CACHE = undefined;
    process.env.XDG_CACHE_HOME = join(cacheDir, 'xdg');
    process.env.HOME = cacheDir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('reports all lanes not-ready with an empty model cache', () => {
    const status = getWorkspaceScanStatus();
    expect(status.resourcesReady).toEqual({ nerModel: false, embeddings: false, reranker: false });
  });

  it('reports embeddings ready when its artifact is cached', () => {
    seedArtifact(MIRRORED_REPOS.embeddings);
    const status = getWorkspaceScanStatus();
    expect(status.resourcesReady.embeddings).toBe(true);
    expect(status.resourcesReady.reranker).toBe(false);
    expect(status.resourcesReady.nerModel).toBe(false);
  });

  it('reports reranker ready when its artifact is cached', () => {
    seedArtifact(MIRRORED_REPOS.reranker);
    const status = getWorkspaceScanStatus();
    expect(status.resourcesReady.reranker).toBe(true);
    expect(status.resourcesReady.embeddings).toBe(false);
  });

  it('reports NER ready when its artifact is cached', () => {
    seedArtifact(MIRRORED_REPOS.nerModel);
    const status = getWorkspaceScanStatus();
    expect(status.resourcesReady.nerModel).toBe(true);
  });

  it('reports not-ready for an empty snapshot dir with no artifact file', () => {
    const snapDir = join(cacheDir, 'hub', MIRRORED_REPOS.embeddings, 'snapshots', 'rev123');
    mkdirSync(snapDir, { recursive: true });
    const status = getWorkspaceScanStatus();
    expect(status.resourcesReady.embeddings).toBe(false);
  });

  it('counts snapshot symlinks (hf-hub links blobs) as cached artifacts', () => {
    const snapDir = join(cacheDir, 'hub', MIRRORED_REPOS.embeddings, 'snapshots', 'rev123');
    mkdirSync(snapDir, { recursive: true });
    const target = join(cacheDir, 'blob-target');
    writeFileSync(target, 'fake-bytes');
    symlinkSync(target, join(snapDir, 'model.onnx'));
    const status = getWorkspaceScanStatus();
    expect(status.resourcesReady.embeddings).toBe(true);
  });
});
