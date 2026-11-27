import { sha256 } from '@noble/hashes/sha256';

/** Hash a browser-backed Blob incrementally; never materialize model weights in JS memory. */
export async function verifyModelBlob(blob: Blob, expectedBytes: number, expectedSha256: string,
  signal?: AbortSignal): Promise<void> {
  if (blob.size !== expectedBytes) throw new Error('Browser model asset size mismatch');
  const hash = sha256.create();
  const reader = blob.stream().getReader();
  let completed = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Browser model verification aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      completed += value.byteLength;
      if (completed > expectedBytes) throw new Error('Browser model asset size mismatch');
      hash.update(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (signal?.aborted) throw new DOMException('Browser model verification aborted', 'AbortError');
  if (completed !== expectedBytes || Array.from(hash.digest() as Uint8Array,
    (byte: number) => byte.toString(16)
    .padStart(2, '0')).join('') !== expectedSha256)
    throw new Error('Browser model asset digest or size mismatch');
}
