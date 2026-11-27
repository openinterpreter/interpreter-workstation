import { acquireGgufAsset } from './ggufStore';
import { BrowserLocalModelCatalog } from './index';

const button = document.querySelector<HTMLButtonElement>('#run')!;
const result = document.querySelector<HTMLElement>('#result')!;
button.addEventListener('click', async () => {
  button.disabled = true;
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode('small pinned browser storage smoke');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const good = new URL('/verified-small.gguf', location.origin).href;
  const interrupted = new URL('/interrupted-small.gguf', location.origin).href;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    if (input === good || input === interrupted) {
      requests++;
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }
    return originalFetch(input, init);
  };
  try {
    if (new BrowserLocalModelCatalog(undefined, location.origin).list()[0]?.assets[0]?.bytes !==
      1_282_439_264) throw new Error('Pinned browser agent core catalogue did not load');
    const asset = { path: 'verified-small.gguf', url: good, bytes: bytes.length, sha256: digest };
    const first = await acquireGgufAsset(asset, location.origin);
    const second = await acquireGgufAsset(asset, location.origin);
    if (first.size !== bytes.length || second.size !== bytes.length || requests !== 1)
      throw new Error('Verified cache was not reused');
    const controller = new AbortController();
    try {
      await acquireGgufAsset({ ...asset, url: interrupted }, location.origin,
        controller.signal, () => controller.abort());
      throw new Error('Interrupted download was accepted');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    }
    const { CacheManager } = await import('@wllama/wllama');
    if (await new CacheManager().open(interrupted))
      throw new Error('Interrupted model remained in browser storage');
    result.textContent = 'PASS: real browser OPFS verified, reused and aborted without a trusted partial file';
  } catch (error) {
    result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  } finally { globalThis.fetch = originalFetch; button.disabled = false; }
});
