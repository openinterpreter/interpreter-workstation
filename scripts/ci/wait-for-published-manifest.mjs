import { randomUUID } from 'node:crypto';

const MAX_ATTEMPTS = 12;
const RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
class PermanentManifestFailure extends Error {}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Public reads can briefly return an older updater alias after S3 HEAD succeeds.
export async function waitForPublishedManifest({
  baseUrl, name, version, filenames,
  fetchManifest = fetch, sleep = pause,
  maxAttempts = MAX_ATTEMPTS, retryDelayMs = RETRY_DELAY_MS,
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new Error(`Manifest verification attempts must be between 1 and ${MAX_ATTEMPTS}`);
  }
  const expectedVersions = new Set([version, `"${version}"`, `'${version}'`]);
  let lastFailure = 'no response';
  const nonce = randomUUID();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/${name}`);
    url.searchParams.set('release_verify', `${version}-${nonce}-${attempt}`);
    try {
      const response = await fetchManifest(url, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new PermanentManifestFailure(`${name} returned non-retryable HTTP ${response.status}`);
      }
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        const body = await response.text();
        const versionLines = body.split(/\r?\n/).filter((line) => line.startsWith('version:'));
        if (versionLines.length !== 1 || !expectedVersions.has(versionLines[0].slice('version:'.length).trim())) {
          lastFailure = 'wrong version';
        } else {
          const missing = filenames.find((filename) => !body.includes(filename));
          if (!missing) return;
          lastFailure = `missing required asset ${missing}`;
        }
      }
    } catch (error) {
      if (error instanceof PermanentManifestFailure) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  throw new Error(`${name} did not converge to ${version} after ${maxAttempts} attempts: ${lastFailure}`);
}
