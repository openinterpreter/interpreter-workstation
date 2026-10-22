import { createHash } from 'node:crypto';

export type FeedbackOriginal = { name: string; contentType: string; blob: Blob };
type Metadata = { email: string; message: string; version: string; platform: string; arch: string };

const MAX_FILE = 200 * 1024 * 1024;
const ID = /^[0-9a-f]{32}$/;

export function needsSignedFeedback(originals: FeedbackOriginal[]): boolean {
  return originals.reduce((total, original) => total + original.blob.size, 0) > 7 * 1024 * 1024;
}

function endpoint(feedbackUrl: string): string {
  const parsed = new URL(feedbackUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/v0/feedback') {
    throw new Error('Feedback endpoint must be an HTTPS /v0/feedback URL');
  }
  return parsed.origin + '/v0/feedback/uploads';
}

async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Feedback upload endpoint returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid feedback upload response');
  return value as Record<string, unknown>;
}

/** Only a known legacy endpoint without the feature may receive the old multipart body. */
export async function supportsSignedFeedback(feedbackUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const response = await fetchImpl(endpoint(feedbackUrl) + '/capabilities', { method: 'GET', redirect: 'error' });
  if (response.status === 404) return false;
  const capabilities = await json(response);
  if (capabilities.schema !== 1 || capabilities.signed_upload !== true) {
    throw new Error('Invalid feedback upload capabilities');
  }
  return true;
}

export async function submitSignedFeedback(
  feedbackUrl: string,
  metadata: Metadata,
  originals: FeedbackOriginal[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (originals.length > 17 || originals.some(file => file.blob.size > MAX_FILE || file.blob.size < 0)) {
    throw new Error('Feedback attachment size or count exceeds limit');
  }
  const base = endpoint(feedbackUrl);
  const created = await json(await fetchImpl(base, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: 'workstation', reason: metadata.message, version: metadata.version,
      email: metadata.email, platform: metadata.platform, arch: metadata.arch }),
  }));
  const id = created.id;
  const capability = created.upload_capability;
  if (typeof id !== 'string' || !ID.test(id) || typeof capability !== 'string' || capability.length < 32) {
    throw new Error('Invalid feedback report identity');
  }
  const headers = { 'X-Feedback-Upload-Capability': capability, 'Content-Type': 'application/json' };
  for (const original of originals) {
    const body = Buffer.from(await original.blob.arrayBuffer());
    const digest = createHash('sha256').update(body).digest('hex');
    const descriptor = { name: original.name, content_type: original.contentType, bytes: body.length, sha256: digest };
    const grant = await json(await fetchImpl(base + '/' + id, {
      method: 'POST', redirect: 'error', headers, body: JSON.stringify(descriptor),
    }));
    if (typeof grant.path !== 'string' || !new RegExp(`^${id}/[0-9a-f]{32}$`).test(grant.path) ||
        grant.content_length !== body.length || grant.expires_in !== 600 || grant.method !== 'PUT' ||
        grant.content_type !== 'application/octet-stream' || typeof grant.url !== 'string') {
      throw new Error('Invalid signed feedback upload grant');
    }
    let url: URL;
    try {
      url = new URL(grant.url);
    } catch {
      throw new Error('Invalid signed feedback upload URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password ||
        !(url.hostname === 'storage.googleapis.com' || /^[a-z0-9.-]+\.storage\.googleapis\.com$/.test(url.hostname))) {
      throw new Error('Signed feedback URL has an unexpected destination');
    }
    // Never expose a signed URL in an exception, log, or diagnostic response.
    let uploaded: Response;
    try {
      uploaded = await fetchImpl(url, { method: 'PUT', redirect: 'error',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) }, body });
    } catch {
      throw new Error('Direct feedback attachment upload failed');
    }
    if (!uploaded.ok) throw new Error(`Direct feedback attachment upload returned HTTP ${uploaded.status}`);
    await json(await fetchImpl(base + '/' + id + '/finalize', {
      method: 'POST', redirect: 'error', headers, body: JSON.stringify({ ...descriptor, path: grant.path }),
    }));
  }
  const completed = await json(await fetchImpl(base + '/' + id + '/complete', {
    method: 'POST', redirect: 'error', headers, body: '{}',
  }));
  if (completed.success !== true || completed.id !== id) throw new Error('Feedback completion was not confirmed');
  return id;
}
