import { sha256 } from '@noble/hashes/sha256';
import type { BrowserModelAsset } from './modelCatalog';
import { verifyModelBlob } from './modelIntegrity';

type ModelCache = {
  open(url: string): Promise<Blob | null>;
  getNameFromURL(url: string): Promise<string>;
  write(name: string, stream: ReadableStream<Uint8Array>, metadata: {
    originalURL: string; originalSize: number; etag: string; sha256: string;
  }): Promise<void>;
  delete(url: string): Promise<void>;
};
type ModelLock = { request<T>(key: string, options: { mode: 'exclusive' },
  callback: () => Promise<T>): Promise<T> };

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Browser model acquisition aborted', 'AbortError');
}

/** Stream bytes into wllama's OPFS cache with no JS-sized model buffer or ambient credentials. */
export async function acquireGgufAsset(asset: BrowserModelAsset, origin: string,
  signal?: AbortSignal, onProgress?: (completed: number, total: number) => void,
  suppliedCache?: ModelCache, suppliedLock?: ModelLock): Promise<Blob> {
  const url = new URL(asset.url, origin);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.origin === origin)) ||
      url.username || url.password || url.hash)
    throw new Error('Invalid browser model asset URL');
  aborted(signal);
  const locks = suppliedLock ?? globalThis.navigator?.locks as ModelLock | undefined;
  if (!locks || typeof locks.request !== 'function')
    throw new Error('Browser cross-tab model lock capability unavailable');
  return locks.request(`workstation-gguf:${url.href}`, { mode: 'exclusive' }, async () => {
  aborted(signal);
  const cache = suppliedCache ?? new (await import('@wllama/wllama')).CacheManager();
  const cached = await cache.open(url.href);
  if (cached) {
    try {
      await verifyModelBlob(cached, asset.bytes, asset.sha256, signal);
      onProgress?.(asset.bytes, asset.bytes);
      return cached;
    } catch (error) {
      if (signal?.aborted) throw error;
      await cache.delete(url.href);
    }
  }
  let wrote = false;
  try {
    aborted(signal);
    const response = await fetch(url.href, { signal, credentials: 'omit',
      redirect: 'follow', cache: 'no-store' });
    const finalUrl = new URL(response.url || url.href);
    if ((finalUrl.protocol !== 'https:' && finalUrl.origin !== url.origin) ||
        finalUrl.username || finalUrl.password ||
        (finalUrl.origin !== url.origin &&
          !asset.redirectHosts?.includes(finalUrl.hostname)))
      throw new Error('Browser model asset final host is not allow-listed');
    if (!response.ok || !response.body) throw new Error('Browser model asset download failed');
    const length = response.headers.get('content-length');
    if (length && Number(length) !== asset.bytes)
      throw new Error('Browser model asset size mismatch');
    const hash = sha256.create();
    let completed = 0;
    const verified = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        aborted(signal);
        completed += chunk.byteLength;
        if (completed > asset.bytes) throw new Error('Browser model asset exceeds declared size');
        hash.update(chunk);
        onProgress?.(completed, asset.bytes);
        controller.enqueue(chunk);
      },
      flush() {
        aborted(signal);
        if (completed !== asset.bytes || Array.from(hash.digest() as Uint8Array,
          (byte: number) => byte.toString(16).padStart(2, '0')).join('') !== asset.sha256)
          throw new Error('Browser model asset digest or size mismatch');
      },
    }));
    const name = await cache.getNameFromURL(url.href);
    wrote = true;
    await cache.write(name, verified, {
      originalURL: url.href, originalSize: asset.bytes, etag: '', sha256: asset.sha256 });
    aborted(signal);
    const downloaded = await cache.open(url.href);
    if (!downloaded) throw new Error('Browser model asset was not stored');
    // The written file, not just the network stream, must match the pin.
    await verifyModelBlob(downloaded, asset.bytes, asset.sha256, signal);
    aborted(signal);
    wrote = false;
    onProgress?.(asset.bytes, asset.bytes);
    return downloaded;
  } catch (error) {
    if (wrote) await cache.delete(url.href).catch(() => {});
    if (error instanceof DOMException && error.name === 'QuotaExceededError')
      throw new Error('Insufficient browser storage for this local model');
    throw error;
  }
  });
}
