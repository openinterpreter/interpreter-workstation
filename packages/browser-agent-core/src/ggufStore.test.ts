import { expect, test } from 'bun:test';
import { acquireGgufAsset } from './ggufStore';
import { verifyModelBlob } from './modelIntegrity';
import { BrowserLocalModelCatalog } from './modelCatalog';

const origin = 'https://models.example';
const bytes = new TextEncoder().encode('verified local model');
const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('');
const asset = { path: 'weights.gguf', url: '/weights.gguf', bytes: bytes.length, sha256: digest };

const lock = { async request<T>(_key: string, _options: { mode: 'exclusive' },
  callback: () => Promise<T>): Promise<T> { return callback(); } };

function cache(initial?: Blob) {
  let stored = initial ?? null;
  const deleted: string[] = [];
  return { deleted,
    open: async () => stored,
    getNameFromURL: async () => 'pinned-model-key',
    write: async (_name: string, stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally { stored = new Blob(chunks); reader.releaseLock(); }
    },
    delete: async (url: string) => { deleted.push(url); stored = null; },
  };
}

test('large pinned GGUF descriptor is admitted without allocating model bytes', () => {
  expect(new BrowserLocalModelCatalog([{ id: 'org/large-model', name: 'Local',
    revision: 'a'.repeat(40), assets: [{ ...asset, bytes: 1_282_439_264 }] }], origin).list())
    .toHaveLength(1);
  expect(() => new BrowserLocalModelCatalog([{ id: 'org/too-large', name: 'Local',
    revision: 'a'.repeat(40), assets: [{ ...asset, bytes: 2_147_483_649 }] }], origin))
    .toThrow('Invalid browser model asset');
  expect(() => new BrowserLocalModelCatalog([{ id: 'org/unpinned', name: 'Local',
    assets: [asset] }], origin)).toThrow('Invalid or duplicate browser model descriptor');
});

test('verified OPFS Blob is reused; corrupt cache is deleted before a fresh download', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  try {
  const good = cache(new Blob([bytes]));
  await acquireGgufAsset(asset, origin, undefined, undefined, good, lock);
  expect(good.deleted).toHaveLength(0);
  const corrupt = cache(new Blob(['x'.repeat(bytes.length)]));
  const progress: number[] = [];
  await acquireGgufAsset(asset, origin, undefined, value => progress.push(value), corrupt, lock);
  expect(corrupt.deleted).toEqual([`${origin}/weights.gguf`]);
  expect(progress.at(-1)).toBe(bytes.length);
  } finally { globalThis.fetch = originalFetch; }
});

test('download omits credentials and fails closed on browser storage exhaustion', async () => {
  const originalFetch = globalThis.fetch;
  const exhausted = cache();
  exhausted.write = async () => { throw new DOMException('Quota reached', 'QuotaExceededError'); };
  globalThis.fetch = async (_url, options) => {
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'follow', cache: 'no-store' });
    return new Response(bytes);
  };
  try {
    await expect(acquireGgufAsset(asset, origin, undefined, undefined, exhausted, lock))
      .rejects.toThrow('Insufficient browser storage');
    expect(exhausted.deleted).toEqual([`${origin}/weights.gguf`]);
  } finally { globalThis.fetch = originalFetch; }
});

test('abort discards partial download and cannot make it a trusted cached model', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const abortedCache = cache();
  globalThis.fetch = async () => new Response(bytes);
  try {
    await expect(acquireGgufAsset(asset, origin, controller.signal,
      () => controller.abort(), abortedCache, lock)).rejects.toHaveProperty('name', 'AbortError');
  } finally { globalThis.fetch = originalFetch; }
  expect(abortedCache.deleted).toEqual([`${origin}/weights.gguf`]);
  await expect(verifyModelBlob(new Blob(['tampered']), bytes.length, digest))
    .rejects.toThrow('size mismatch');
});

test('digest mismatch removes the downloaded asset instead of marking it acquired', async () => {
  const originalFetch = globalThis.fetch;
  const wrong = cache();
  globalThis.fetch = async () => new Response('x'.repeat(bytes.length));
  try {
    await expect(acquireGgufAsset(asset, origin, undefined, undefined, wrong, lock))
      .rejects.toThrow('digest');
  } finally { globalThis.fetch = originalFetch; }
  expect(wrong.deleted).toEqual([`${origin}/weights.gguf`]);
  await expect(verifyModelBlob(new Blob(['x'.repeat(bytes.length)]), bytes.length, digest))
    .rejects.toThrow('digest');
});

test('a correct network digest cannot bless bytes corrupted after browser storage writes', async () => {
  const originalFetch = globalThis.fetch;
  const damaged = cache();
  const originalWrite = damaged.write;
  damaged.write = async (name, stream) => {
    await originalWrite(name, stream);
    // Simulate a post-stream storage mutation. The returned blob must be rehashed.
    damaged.open = async () => new Blob(['x'.repeat(bytes.length)]);
  };
  globalThis.fetch = async () => new Response(bytes);
  try {
    await expect(acquireGgufAsset(asset, origin, undefined, undefined, damaged, lock))
      .rejects.toThrow('digest');
    expect(damaged.deleted).toEqual([`${origin}/weights.gguf`]);
  } finally { globalThis.fetch = originalFetch; }
});

test('parallel tabs serialize one acquisition and never erase the verified winner', async () => {
  const serial = new Map<string, Promise<unknown>>();
  const exclusive = { async request<T>(key: string, _options: { mode: 'exclusive' },
    callback: () => Promise<T>): Promise<T> {
    const previous = serial.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    serial.set(key, current);
    return current;
  } };
  const shared = cache();
  let downloads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { downloads++; await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(bytes); };
  try {
    const [first, second] = await Promise.all([
      acquireGgufAsset(asset, origin, undefined, undefined, shared, exclusive),
      acquireGgufAsset(asset, origin, undefined, undefined, shared, exclusive),
    ]);
    expect(first.size).toBe(bytes.length);
    expect(second.size).toBe(bytes.length);
    expect(downloads).toBe(1);
    expect(shared.deleted).toHaveLength(0);
  } finally { globalThis.fetch = originalFetch; }
});

test('a pre-write download failure does not delete another tab verified file', async () => {
  const shared = cache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('network failed'); };
  try {
    await expect(acquireGgufAsset(asset, origin, undefined, undefined, shared, lock))
      .rejects.toThrow('network failed');
    expect(shared.deleted).toHaveLength(0);
  } finally { globalThis.fetch = originalFetch; }
});

test('missing cross-tab lock capability cannot read or mutate a cached model', async () => {
  const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  const storage = cache(new Blob([bytes]));
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: undefined });
  globalThis.fetch = async () => { fetches++; return new Response(bytes); };
  try {
    await expect(acquireGgufAsset(asset, origin, undefined, undefined, storage))
      .rejects.toThrow('Browser cross-tab model lock capability unavailable');
    expect(fetches).toBe(0);
    expect(storage.deleted).toHaveLength(0);
  } finally {
    if (originalLocks) Object.defineProperty(globalThis.navigator, 'locks', originalLocks);
    else delete (globalThis.navigator as Navigator & { locks?: unknown }).locks;
    globalThis.fetch = originalFetch;
  }
});

test('pinned HTTPS asset follows only an explicitly allowed final download host', async () => {
  const originalFetch = globalThis.fetch;
  const allowed = 'objects.example';
  let finalHost = allowed;
  globalThis.fetch = async (_url, options) => {
    expect(options?.redirect).toBe('follow');
    const response = new Response(bytes);
    Object.defineProperty(response, 'url', { value: `https://${finalHost}/file.gguf` });
    return response;
  };
  try {
    const pinned = { ...asset, redirectHosts: [allowed] };
    await expect(acquireGgufAsset(pinned, origin, undefined, undefined, cache(), lock))
      .resolves.toHaveProperty('size', bytes.length);
    finalHost = 'other.example';
    await expect(acquireGgufAsset(pinned, origin, undefined, undefined, cache(), lock))
      .rejects.toThrow('final host');
  } finally { globalThis.fetch = originalFetch; }
});
