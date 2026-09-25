import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { needsSignedFeedback, submitSignedFeedback, supportsSignedFeedback } from './feedbackSignedUpload';

const endpoint = 'https://feedback.example.test/v0/feedback';
const id = 'a'.repeat(32);
const path = `${id}/${'b'.repeat(32)}`;
const metadata = { email: 'test@example.org', message: 'private issue', version: '0.0.52', platform: 'linux', arch: 'x64' };

describe('private feedback signed upload', () => {
  test('large originals choose direct upload without changing small legacy payloads', () => {
    const original = (size: number) => ({ name: 'log', contentType: 'text/plain', blob: new Blob([Buffer.alloc(size)]) });
    expect(needsSignedFeedback([original(4 * 1024 * 1024)])).toBe(false);
    expect(needsSignedFeedback([original(4 * 1024 * 1024), original(4 * 1024 * 1024)])).toBe(true);
  });
  test('retains legacy multipart only when the configured endpoint explicitly returns 404', async () => {
    const unsupported = async () => new Response(null, { status: 404 });
    expect(await supportsSignedFeedback(endpoint, unsupported as typeof fetch)).toBe(false);
    const supported = async () => Response.json({ schema: 1, signed_upload: true });
    expect(await supportsSignedFeedback(endpoint, supported as typeof fetch)).toBe(true);
    const unavailable = async () => new Response(null, { status: 503 });
    await expect(supportsSignedFeedback(endpoint, unavailable as typeof fetch)).rejects.toThrow('HTTP 503');
  });

  test('uploads original bytes directly to GCS, finalizes hash and preserves metadata', async () => {
    const original = Buffer.alloc(9 * 1024 * 1024, 0x5a);
    const sha256 = createHash('sha256').update(original).digest('hex');
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchMock = async (target: string | URL, options: RequestInit): Promise<Response> => {
      const url = String(target);
      calls.push({ url, options });
      if (url === endpoint + '/uploads') return Response.json({ id, upload_capability: 'c'.repeat(48) });
      if (url === endpoint + '/uploads/' + id) return Response.json({ path,
        url: 'https://storage.googleapis.com/private-bucket/object?X-Goog-Signature=dummy',
        method: 'PUT', expires_in: 600, content_type: 'application/octet-stream', content_length: original.length });
      if (url.includes('storage.googleapis.com')) return new Response(null, { status: 200 });
      if (url.endsWith('/finalize')) return Response.json({ success: true });
      if (url.endsWith('/complete')) return Response.json({ success: true, id });
      throw new Error('unexpected request');
    };
    const reportId = await submitSignedFeedback(endpoint, metadata,
      [{ name: 'session.log', contentType: 'text/plain', blob: new Blob([original]) }], fetchMock as typeof fetch);
    expect(reportId).toBe(id);
    expect(JSON.parse(calls[0].options.body as string)).toMatchObject({ origin: 'workstation', reason: metadata.message,
      email: metadata.email, platform: metadata.platform, arch: metadata.arch });
    expect(JSON.parse(calls[1].options.body as string)).toEqual({
      name: 'session.log', content_type: 'text/plain', bytes: original.length, sha256,
    });
    expect(calls[2].options.body).toEqual(original);
    expect((calls[2].options.headers as Record<string, string>)['Content-Length']).toBe(String(original.length));
    expect((calls[2].options.headers as Record<string, string>)['X-Feedback-Upload-Capability']).toBeUndefined();
    expect(JSON.parse(calls[3].options.body as string)).toMatchObject({ path, sha256 });
    expect(calls[4].url).toEndWith('/complete');
  });

  test('rejects hostile signed destination without uploading or disclosing capability', async () => {
    const fetchMock = async (target: string | URL): Promise<Response> => {
      if (String(target) === endpoint + '/uploads') return Response.json({ id, upload_capability: 'c'.repeat(48) });
      return Response.json({ path, url: 'https://attacker.example/steal', method: 'PUT', expires_in: 600,
        content_type: 'application/octet-stream', content_length: 1 });
    };
    await expect(submitSignedFeedback(endpoint, metadata,
      [{ name: 'x.log', contentType: 'text/plain', blob: new Blob(['x']) }], fetchMock as typeof fetch))
      .rejects.toThrow('unexpected destination');
  });

  test('malformed grant URL never appears in a client error', async () => {
    const fetchMock = async (target: string | URL): Promise<Response> => {
      if (String(target) === endpoint + '/uploads') return Response.json({ id, upload_capability: 'c'.repeat(48) });
      return Response.json({ path, url: 'malformed-signed-url-PRIVATE-CAPABILITY', method: 'PUT', expires_in: 600,
        content_type: 'application/octet-stream', content_length: 1 });
    };
    await expect(submitSignedFeedback(endpoint, metadata,
      [{ name: 'x.log', contentType: 'text/plain', blob: new Blob(['x']) }], fetchMock as typeof fetch))
      .rejects.toThrow('Invalid signed feedback upload URL');
  });
});
