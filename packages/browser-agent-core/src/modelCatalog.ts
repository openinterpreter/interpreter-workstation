import type { Model } from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { BrowserPiAppServerSession } from './piSession';
import type { PresentationValidator } from './presentationGate';
import type { BrowserPiTranscriptStore } from './piTranscript';
import type { InputModality } from '../../../server/handlers/codex-generated-types/InputModality';
import { acquireGgufAsset } from './ggufStore';

export type BrowserModelAsset = Readonly<{
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  /** Exact HTTPS response hosts permitted after a public model download redirect. */
  redirectHosts?: readonly string[];
}>;
export type BrowserModelDescriptor = Readonly<{
  id: string;
  name: string;
  /** CPU/WASM context allocation; omitted preserves the existing 2048-token default. */
  contextTokens?: number;
  /** Pinned source revision of a GGUF model; asset SHA-256 pins its actual bytes. */
  revision?: string;
  /** Disable optional model reasoning in templates that declare this setting. */
  disableThinking?: boolean;
  inputModalities?: readonly InputModality[];
  assets: readonly BrowserModelAsset[];
}>;
export type BrowserModelRuntime = Readonly<{ model: Model<any>; streamFn: StreamFn;
  dispose?: () => void }>;

/** Public, revision- and digest-pinned CPU/WASM browser default; weights are fetched on demand. */
export const DEFAULT_BROWSER_GGUF_MODEL: BrowserModelDescriptor = Object.freeze({
  id: 'ggml-org/Qwen3-1.7B-GGUF', name: 'Qwen3 1.7B (local)',
  contextTokens: 8192,
  revision: 'daeb8e2d528a760970442092f6bf1e55c3b659eb',
  inputModalities: Object.freeze(['text' as const]), disableThinking: true,
  assets: Object.freeze([Object.freeze({ path: 'Qwen3-1.7B-Q4_K_M.gguf',
    url: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/' +
      'daeb8e2d528a760970442092f6bf1e55c3b659eb/Qwen3-1.7B-Q4_K_M.gguf',
    bytes: 1_282_439_264,
    sha256: 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
    redirectHosts: Object.freeze(['us.gcp.cdn.hf.co']),
  })]),
});

const identity = /^[a-zA-Z0-9_-]{1,64}$/;
const modelIdentity = /^[a-zA-Z0-9_.\/-]{1,96}$/;
const assetPath = /^[a-zA-Z0-9_.-]{1,100}$/;
// Only the legacy/test byte-loader uses these limits. GGUF always streams via OPFS.
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_BYTES = 32 * 1024 * 1024;
const MAX_GGUF_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CONTEXT_TOKENS = 2048;
const MAX_CONTEXT_TOKENS = 8192;
export function browserModelContextTokens(descriptor: BrowserModelDescriptor): number {
  const value = descriptor.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  if (!Number.isSafeInteger(value) || value < DEFAULT_CONTEXT_TOKENS || value > MAX_CONTEXT_TOKENS)
    throw new Error('Invalid browser model context');
  return value;
}
const gguf = (descriptor: BrowserModelDescriptor) =>
  descriptor.assets.length === 1 && descriptor.assets[0].path.toLowerCase().endsWith('.gguf');
const CACHE_NAME = 'workstation-browser-model-v1';
const CONFIG_PREFIX = 'workstation-browser-model-project-v1:';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function supportedUrl(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.origin === origin))
    throw new Error('Browser model asset requires HTTPS or the current origin');
  if (url.username || url.password || url.hash) throw new Error('Invalid browser model asset URL');
  return url.href;
}

/** Generic model bytes and project configuration; domain tools never enter the catalog. */
export class BrowserLocalModelCatalog {
  private readonly entries = new Map<string, BrowserModelDescriptor>();

  constructor(descriptors: readonly BrowserModelDescriptor[] = [DEFAULT_BROWSER_GGUF_MODEL],
    private readonly origin: string = globalThis.location?.origin ?? '') {
    if (!origin) throw new Error('Browser model origin unavailable');
    for (const descriptor of descriptors) {
      browserModelContextTokens(descriptor);
      if (!modelIdentity.test(descriptor.id) || descriptor.id.includes('..') ||
          !descriptor.name || descriptor.name.length > 160 ||
          (gguf(descriptor) && !/^[a-f0-9]{40}$/.test(descriptor.revision ?? '')) ||
          !descriptor.assets.length || this.entries.has(descriptor.id))
        throw new Error('Invalid or duplicate browser model descriptor');
      let total = 0;
      const paths = new Set<string>();
      for (const asset of descriptor.assets) {
        supportedUrl(asset.url, origin);
        if (!assetPath.test(asset.path) || paths.has(asset.path) ||
            !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) ||
            (asset.redirectHosts?.some(host =>
              !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) ?? false) ||
            asset.bytes < 1 || asset.bytes > (gguf(descriptor) ? MAX_GGUF_BYTES : MAX_ASSET_BYTES))
          throw new Error('Invalid browser model asset');
        total += asset.bytes;
        paths.add(asset.path);
      }
      if (total > (gguf(descriptor) ? MAX_GGUF_BYTES : MAX_MODEL_BYTES))
        throw new Error('Browser model exceeds size limit');
      this.entries.set(descriptor.id, Object.freeze({ ...descriptor,
        assets: Object.freeze(descriptor.assets.map(asset => Object.freeze({ ...asset,
          redirectHosts: asset.redirectHosts ? Object.freeze([...asset.redirectHosts]) : undefined }))) }));
    }
  }

  list(): readonly BrowserModelDescriptor[] { return [...this.entries.values()]; }

  private entry(modelId: string): BrowserModelDescriptor {
    const entry = this.entries.get(modelId);
    if (!entry) throw new Error('Browser model is not registered');
    return entry;
  }

  private async cache(): Promise<Cache> {
    if (!globalThis.caches || !globalThis.crypto?.subtle)
      throw new Error('Browser model cache or digest capability unavailable');
    return caches.open(CACHE_NAME);
  }

  /** No network request occurs until the caller explicitly requests acquisition. */
  async acquire(modelId: string, signal?: AbortSignal,
    onProgress?: (completedBytes: number, totalBytes: number) => void): Promise<void> {
    const descriptor = this.entry(modelId);
    if (gguf(descriptor)) {
      await acquireGgufAsset(descriptor.assets[0], this.origin, signal, onProgress);
      return;
    }
    const cache = await this.cache();
    const total = descriptor.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    let completed = 0;
    for (const asset of descriptor.assets) {
      if (signal?.aborted) throw new DOMException('Browser model download aborted', 'AbortError');
      if (await this.readVerified(cache, descriptor.id, asset)) {
        completed += asset.bytes; onProgress?.(completed, total); continue;
      }
      const url = supportedUrl(asset.url, this.origin);
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error('Browser model asset download failed');
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) !== asset.bytes)
        throw new Error('Browser model asset size mismatch');
      const reader = response.body.getReader();
      const bytes = new Uint8Array(asset.bytes);
      let offset = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.byteLength > asset.bytes) throw new Error('Browser model asset exceeds declared size');
          bytes.set(value, offset);
          offset += value.byteLength;
          onProgress?.(completed + offset, total);
        }
      } finally { reader.releaseLock(); }
      if (offset !== asset.bytes || hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) !== asset.sha256)
        throw new Error('Browser model asset digest or size mismatch');
      await cache.put(this.cacheKey(descriptor.id, asset.path), new Response(bytes.buffer as ArrayBuffer));
      completed += asset.bytes;
    }
  }

  private cacheKey(modelId: string, path: string): string {
    return new URL(`/.workstation-browser-model/${modelId}/${path}`, this.origin).href;
  }

  private async readVerified(cache: Cache, modelId: string, asset: BrowserModelAsset): Promise<Uint8Array | null> {
    const response = await cache.match(this.cacheKey(modelId, asset.path));
    if (!response) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === asset.bytes &&
        hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) === asset.sha256) return bytes;
    await cache.delete(this.cacheKey(modelId, asset.path));
    return null;
  }

  async asset(modelId: string, path: string): Promise<Uint8Array> {
    const descriptor = this.entry(modelId);
    if (gguf(descriptor)) throw new Error('Browser GGUF assets are streaming only');
    const asset = descriptor.assets.find(item => item.path === path);
    if (!asset) throw new Error('Browser model asset is not registered');
    const verified = await this.readVerified(await this.cache(), modelId, asset);
    if (!verified) throw new Error('Browser model asset unavailable; acquire it first');
    return verified;
  }

  select(projectId: string, modelId: string): void {
    if (!identity.test(projectId)) throw new Error('Invalid browser project identity');
    this.entry(modelId);
    if (!globalThis.localStorage) throw new Error('Browser model configuration storage unavailable');
    localStorage.setItem(CONFIG_PREFIX + encodeURIComponent(this.origin) + ':' + projectId, modelId);
  }

  selected(projectId: string): BrowserModelDescriptor {
    if (!identity.test(projectId) || !globalThis.localStorage)
      throw new Error('Browser model configuration storage unavailable');
    return this.entry(localStorage.getItem(CONFIG_PREFIX + encodeURIComponent(this.origin) + ':' + projectId) ?? '');
  }

  /** The registered loader supplies only transport; Pi remains the model/tool engine. */
  async openSession(options: { projectId: string; modelId?: string; threadId: string;
    providerId?: string; signal?: AbortSignal; tools: AgentTool<any>[];
    systemPrompt: string; storage?: BrowserPiTranscriptStore; timeoutMs?: number; maxTurns?: number;
    presentationValidator?: PresentationValidator;
    /** Internal/test seam. The normal browser runtime uses the package's lazy GGUF engine. */
    load?: (model: BrowserModelDescriptor, asset: (path: string) => Promise<Uint8Array>) => Promise<BrowserModelRuntime>;
  }): Promise<BrowserPiAppServerSession> {
    const descriptor = options.modelId ? this.entry(options.modelId) : this.selected(options.projectId);
    let runtime: BrowserModelRuntime;
    if (!options.load) {
      if (!gguf(descriptor)) throw new Error('Browser model format has no registered engine');
      const blob = await acquireGgufAsset(descriptor.assets[0], this.origin, options.signal);
      const { createWllamaRuntime } = await import('./wllamaEngine');
      runtime = await createWllamaRuntime(descriptor, blob,
        options.providerId ?? 'browser-local', options.signal);
    } else {
      const verified = new Map<string, Uint8Array>();
      for (const entry of descriptor.assets)
        verified.set(entry.path, await this.asset(descriptor.id, entry.path));
      runtime = await options.load(descriptor, path => {
        const bytes = verified.get(path);
        if (!bytes) throw new Error('Browser model asset is not registered');
        return Promise.resolve(bytes);
      });
    }
    if (runtime.model.id !== descriptor.id ||
        (options.providerId && runtime.model.provider !== options.providerId)) {
      runtime.dispose?.();
      throw new Error(runtime.model.id !== descriptor.id ?
        'Browser model identity mismatch' : 'Browser model provider identity mismatch');
    }
    let session: BrowserPiAppServerSession;
    try { session = await BrowserPiAppServerSession.open({ projectId: options.projectId,
      threadId: options.threadId,
      model: runtime.model, streamFn: runtime.streamFn, tools: options.tools,
      systemPrompt: options.systemPrompt, timeoutMs: options.timeoutMs,
      maxTurns: options.maxTurns, catalog: this, onDispose: runtime.dispose,
      presentationValidator: options.presentationValidator }, options.storage);
    } catch (error) { runtime.dispose?.(); throw error; }
    try {
      this.select(options.projectId, descriptor.id);
    } catch (error) {
      session.dispose();
      throw error;
    }
    return session;
  }
}

/** Host acquisition is repeatable: verified cached assets finish without network traffic. */
export function createBrowserModelDownload(catalog: BrowserLocalModelCatalog, providerId: string) {
  return async (requestedProvider: string, modelId: string,
    onProgress: (progress: { total?: number; completed?: number; status?: string;
      done?: boolean; error?: string }) => void, signal?: AbortSignal): Promise<void> => {
    if (requestedProvider !== providerId) throw new Error('Browser model provider unavailable');
    try {
      await catalog.acquire(modelId, signal, (completed, total) => {
        onProgress({ completed, total });
      });
      if (signal?.aborted) throw new DOMException('Browser model download aborted', 'AbortError');
      onProgress({ done: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        onProgress({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
