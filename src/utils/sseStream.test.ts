import { describe, expect, test } from 'bun:test';

import { readJsonSseStream, type ReadJsonSseStreamOptions, type SseStreamDiagnosticEvent, type SseStreamDiagnostic } from './sseStream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function streamFromByteChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function errorAfterChunks(chunks: string[], error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.error(error);
      }
    },
  });
}

const SILENT_DIAG: ReadJsonSseStreamOptions = { streamName: 'test', addDiagnosticBreadcrumb: () => {} };

async function collect<T>(stream: ReadableStream<Uint8Array>, opts: ReadJsonSseStreamOptions = SILENT_DIAG): Promise<T[]> {
  const values: T[] = [];
  for await (const value of readJsonSseStream<T>(stream, opts)) {
    values.push(value);
  }
  return values;
}

type DiagEntry = { event: SseStreamDiagnosticEvent; diagnostic: SseStreamDiagnostic };

function collectWithDiag(streamName = 'test') {
  const diagnostics: DiagEntry[] = [];
  const opts = {
    streamName,
    addDiagnosticBreadcrumb: (event: SseStreamDiagnosticEvent, diagnostic: SseStreamDiagnostic) => {
      diagnostics.push({ event, diagnostic: { ...diagnostic } });
    },
  };
  return { opts, diagnostics };
}

// ---------------------------------------------------------------------------
// Chunk boundary / fragmentation tests
// ---------------------------------------------------------------------------

describe('readJsonSseStream', () => {
  describe('chunk boundary handling', () => {
    test('should parse event split mid-JSON across two chunks', async () => {
      const values = await collect<{ status: string }>(streamFromChunks([
        'data: {"status":"lo',
        'ading"}\n\n',
      ]));
      expect(values).toEqual([{ status: 'loading' }]);
    });

    test('should parse event split across three chunks', async () => {
      const values = await collect<{ a: number }>(streamFromChunks([
        'data: {"a',
        '":',
        '42}\n\n',
      ]));
      expect(values).toEqual([{ a: 42 }]);
    });

    test('should parse event when split at the data: prefix boundary', async () => {
      const values = await collect<{ ok: boolean }>(streamFromChunks([
        'dat',
        'a: {"ok":true}\n\n',
      ]));
      expect(values).toEqual([{ ok: true }]);
    });

    test('should parse event when double-newline terminator is split across chunks', async () => {
      const values = await collect<{ v: number }>(streamFromChunks([
        'data: {"v":1}\n',
        '\n',
      ]));
      expect(values).toEqual([{ v: 1 }]);
    });

    test('should parse multiple events from a single chunk', async () => {
      const values = await collect<{ step: number }>(streamFromChunks([
        'data: {"step":1}\n\ndata: {"step":2}\n\ndata: {"step":3}\n\n',
      ]));
      expect(values).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
    });

    test('should handle single-byte chunks (extreme fragmentation)', async () => {
      const raw = 'data: {"x":1}\n\n';
      const singleByteChunks = Array.from(raw).map((ch) => ch);
      const values = await collect<{ x: number }>(streamFromChunks(singleByteChunks));
      expect(values).toEqual([{ x: 1 }]);
    });

    test('should handle event data arriving one character at a time across many chunks', async () => {
      const raw = 'data: {"key":"value"}\n\ndata: {"key":"second"}\n\n';
      const chars = Array.from(raw);
      const values = await collect<{ key: string }>(streamFromChunks(chars));
      expect(values).toEqual([{ key: 'value' }, { key: 'second' }]);
    });

    test('should drop incomplete event when stream ends without blank-line dispatch', async () => {
      const values = await collect<{ v: number }>(streamFromChunks([
        'data: {"v":99}\n\n',
        'data: {"v":100}\n',
      ]));
      expect(values).toEqual([{ v: 99 }]);
    });
  });

  // ---------------------------------------------------------------------------
  // SSE protocol conformance
  // ---------------------------------------------------------------------------

  describe('SSE protocol conformance', () => {
    test('should handle \\r\\n line endings (Windows-style)', async () => {
      const values = await collect<{ w: boolean }>(streamFromChunks([
        'data: {"w":true}\r\n\r\n',
      ]));
      expect(values).toEqual([{ w: true }]);
    });

    test('should handle \\r line endings when followed by more data (resolves deferred CR)', async () => {
      const values = await collect<{ m: number }>(streamFromChunks([
        'data: {"m":1}\r\rdata: {"m":2}\n\n',
      ]));
      expect(values).toEqual([{ m: 1 }, { m: 2 }]);
    });

    test('should drop trailing \\r-terminated event at stream end (deferred CR not resolved)', async () => {
      const values = await collect<{ i: number }>(streamFromChunks([
        'data: {"i":1}\r\n\r\ndata: {"i":2}\r\r',
      ]));
      expect(values).toEqual([{ i: 1 }]);
    });

    test('should handle mixed \\r\\n and \\n line endings in one stream', async () => {
      const values = await collect<{ i: number }>(streamFromChunks([
        'data: {"i":1}\r\n\r\ndata: {"i":2}\n\ndata: {"i":3}\r\n\r\n',
      ]));
      expect(values).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    });

    test('should skip SSE comment lines (lines starting with :)', async () => {
      const values = await collect<{ v: number }>(streamFromChunks([
        ': this is a heartbeat comment\n',
        'data: {"v":1}\n\n',
        ': another comment\n',
        'data: {"v":2}\n\n',
      ]));
      expect(values).toEqual([{ v: 1 }, { v: 2 }]);
    });

    test('should ignore id: and event: fields without breaking JSON parsing', async () => {
      const values = await collect<{ msg: string }>(streamFromChunks([
        'id: 42\nevent: progress\ndata: {"msg":"hello"}\n\n',
      ]));
      expect(values).toEqual([{ msg: 'hello' }]);
    });

    test('should ignore retry: field without breaking parsing', async () => {
      const values = await collect<{ ok: boolean }>(streamFromChunks([
        'retry: 3000\ndata: {"ok":true}\n\n',
      ]));
      expect(values).toEqual([{ ok: true }]);
    });

    test('should concatenate multi-line data: fields with newlines per SSE spec', async () => {
      const values = await collect<unknown>(streamFromChunks([
        'data: {"multi":\n',
        'data: "line"}\n\n',
      ]));
      // eventsource-parser joins multi data: lines with \n
      // so the parsed data string is '{"multi":\n"line"}' which is valid JSON
      expect(values).toEqual([{ multi: 'line' }]);
    });

    test('should handle data field with no space after colon (data:payload)', async () => {
      const values = await collect<{ compact: boolean }>(streamFromChunks([
        'data:{"compact":true}\n\n',
      ]));
      expect(values).toEqual([{ compact: true }]);
    });

    test('should handle empty data field gracefully (skipped by trim check)', async () => {
      const values = await collect<{ after: boolean }>(streamFromChunks([
        'data: \n\n',
        'data: {"after":true}\n\n',
      ]));
      expect(values).toEqual([{ after: true }]);
    });

    test('should handle data field that is only whitespace (skipped by trim check)', async () => {
      const values = await collect<{ v: number }>(streamFromChunks([
        'data:   \n\n',
        'data: {"v":5}\n\n',
      ]));
      expect(values).toEqual([{ v: 5 }]);
    });
  });

  // ---------------------------------------------------------------------------
  // JSON edge cases
  // ---------------------------------------------------------------------------

  describe('JSON parsing', () => {
    test('should parse nested JSON objects', async () => {
      const values = await collect<{ outer: { inner: number } }>(streamFromChunks([
        'data: {"outer":{"inner":42}}\n\n',
      ]));
      expect(values).toEqual([{ outer: { inner: 42 } }]);
    });

    test('should parse JSON arrays', async () => {
      const values = await collect<number[]>(streamFromChunks([
        'data: [1,2,3]\n\n',
      ]));
      expect(values).toEqual([[1, 2, 3]]);
    });

    test('should parse JSON with unicode characters', async () => {
      const values = await collect<{ name: string }>(streamFromChunks([
        'data: {"name":"café ☃"}\n\n',
      ]));
      expect(values).toEqual([{ name: 'café ☃' }]);
    });

    test('should parse JSON containing escaped newlines in strings', async () => {
      const values = await collect<{ text: string }>(streamFromChunks([
        'data: {"text":"line1\\nline2"}\n\n',
      ]));
      expect(values).toEqual([{ text: 'line1\nline2' }]);
    });

    test('should parse JSON with all primitive types', async () => {
      const values = await collect<{ s: string; n: number; b: boolean; nil: null }>(streamFromChunks([
        'data: {"s":"str","n":3.14,"b":false,"nil":null}\n\n',
      ]));
      expect(values).toEqual([{ s: 'str', n: 3.14, b: false, nil: null }]);
    });

    test('should parse JSON with extra whitespace around it', async () => {
      const values = await collect<{ trimmed: boolean }>(streamFromChunks([
        'data:   {"trimmed":true}  \n\n',
      ]));
      expect(values).toEqual([{ trimmed: true }]);
    });

    test('should skip invalid JSON and continue parsing subsequent events', async () => {
      const values = await collect<{ ok: boolean }>(streamFromChunks([
        'data: {broken json\n\n',
        'data: {"ok":true}\n\n',
        'data: also not json\n\n',
        'data: {"ok":false}\n\n',
      ]));
      expect(values).toEqual([{ ok: true }, { ok: false }]);
    });

    test('should skip [DONE] sentinel', async () => {
      const values = await collect<{ v: number }>(streamFromChunks([
        'data: {"v":1}\n\ndata: [DONE]\n\n',
      ]));
      expect(values).toEqual([{ v: 1 }]);
    });

    test('should continue yielding events after [DONE] sentinel', async () => {
      const values = await collect<{ v: number }>(streamFromChunks([
        'data: {"v":1}\n\ndata: [DONE]\n\ndata: {"v":2}\n\n',
      ]));
      expect(values).toEqual([{ v: 1 }, { v: 2 }]);
    });
  });

  // ---------------------------------------------------------------------------
  // Stream lifecycle
  // ---------------------------------------------------------------------------

  describe('stream lifecycle', () => {
    test('should yield nothing from an empty stream', async () => {
      const values = await collect<unknown>(streamFromChunks([]));
      expect(values).toEqual([]);
    });

    test('should yield nothing from a stream with only comments', async () => {
      const values = await collect<unknown>(streamFromChunks([
        ': heartbeat\n',
        ': another heartbeat\n',
      ]));
      expect(values).toEqual([]);
    });

    test('should yield nothing from a stream with only [DONE]', async () => {
      const values = await collect<unknown>(streamFromChunks([
        'data: [DONE]\n\n',
      ]));
      expect(values).toEqual([]);
    });

    test('should propagate stream read errors', async () => {
      const stream = errorAfterChunks(
        ['data: {"v":1}\n\n'],
        new Error('network failure'),
      );
      await expect(collect(stream)).rejects.toThrow('network failure');
    });

    test('should yield events received before a stream error', async () => {
      const stream = errorAfterChunks(
        ['data: {"v":1}\n\n', 'data: {"v":2}\n\n'],
        new Error('late failure'),
      );
      const values: Array<{ v: number }> = [];
      try {
        for await (const value of readJsonSseStream<{ v: number }>(stream, SILENT_DIAG)) {
          values.push(value);
        }
      } catch {
        // expected
      }
      expect(values).toEqual([{ v: 1 }, { v: 2 }]);
    });

    test('should release the reader lock after normal completion', async () => {
      const stream = streamFromChunks(['data: {"v":1}\n\n']);
      await collect(stream);
      expect(stream.locked).toBe(false);
    });

    test('should release the reader lock after an error', async () => {
      const stream = errorAfterChunks([], new Error('boom'));
      try {
        await collect(stream);
      } catch {
        // expected
      }
      expect(stream.locked).toBe(false);
    });

    test('should release the reader lock when consumer breaks early', async () => {
      const stream = streamFromChunks([
        'data: {"v":1}\n\n',
        'data: {"v":2}\n\n',
        'data: {"v":3}\n\n',
      ]);
      const values: Array<{ v: number }> = [];
      for await (const value of readJsonSseStream<{ v: number }>(stream, SILENT_DIAG)) {
        values.push(value);
        if (value.v === 1) break;
      }
      expect(values).toEqual([{ v: 1 }]);
      expect(stream.locked).toBe(false);
    });

    test('should handle pull-based stream with async chunk delivery', async () => {
      let pullCount = 0;
      const chunks = [
        'data: {"seq":1}\n\n',
        'data: {"seq":2}\n\n',
        'data: {"seq":3}\n\n',
      ];
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount < chunks.length) {
            controller.enqueue(encoder.encode(chunks[pullCount++]));
          } else {
            controller.close();
          }
        },
      });

      const values = await collect<{ seq: number }>(stream);
      expect(values.map((v) => v.seq)).toEqual([1, 2, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  // Event ordering
  // ---------------------------------------------------------------------------

  describe('ordering', () => {
    test('should preserve order when multiple events arrive in one chunk', async () => {
      const values = await collect<{ seq: number }>(streamFromChunks([
        'data: {"seq":1}\n\ndata: {"seq":2}\n\ndata: {"seq":3}\n\ndata: {"seq":4}\n\ndata: {"seq":5}\n\n',
      ]));
      expect(values.map((v) => v.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    test('should preserve order across chunk boundaries', async () => {
      const values = await collect<{ seq: number }>(streamFromChunks([
        'data: {"seq":1}\n\nda',
        'ta: {"seq":2}\n\ndata: {"seq"',
        ':3}\n\n',
      ]));
      expect(values.map((v) => v.seq)).toEqual([1, 2, 3]);
    });

    test('should preserve order when invalid JSON is interspersed', async () => {
      const values = await collect<{ seq: number }>(streamFromChunks([
        'data: {"seq":1}\n\ndata: broken\n\ndata: {"seq":2}\n\ndata: nope\n\ndata: {"seq":3}\n\n',
      ]));
      expect(values.map((v) => v.seq)).toEqual([1, 2, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  describe('diagnostics', () => {
    test('should emit start and complete events for normal stream', async () => {
      const stream = streamFromChunks(['data: {"v":1}\n\n']);
      const { opts, diagnostics } = collectWithDiag();
      await collect<{ v: number }>(stream, opts);

      const events = diagnostics.map((d) => d.event);
      expect(events[0]).toBe('start');
      expect(events[events.length - 1]).toBe('complete');
    });

    test('should track byte count accurately across chunks', async () => {
      const chunk1 = 'data: {"v":1}\n\n';
      const chunk2 = 'data: {"v":2}\n\n';
      const stream = streamFromChunks([chunk1, chunk2]);
      const { opts, diagnostics } = collectWithDiag();
      await collect<{ v: number }>(stream, opts);

      const complete = diagnostics.find((d) => d.event === 'complete')!;
      const expectedBytes = new TextEncoder().encode(chunk1).byteLength + new TextEncoder().encode(chunk2).byteLength;
      expect(complete.diagnostic.bytes).toBe(expectedBytes);
    });

    test('should track chunk count accurately', async () => {
      const stream = streamFromChunks(['data: {"v":1}\n\n', 'data: {"v":2}\n\n', 'data: {"v":3}\n\n']);
      const { opts, diagnostics } = collectWithDiag();
      await collect<{ v: number }>(stream, opts);

      const complete = diagnostics.find((d) => d.event === 'complete')!;
      expect(complete.diagnostic.chunks).toBe(3);
    });

    test('should track event count (only successful JSON parses)', async () => {
      const stream = streamFromChunks([
        'data: {"v":1}\n\ndata: broken\n\ndata: {"v":2}\n\ndata: [DONE]\n\n',
      ]);
      const { opts, diagnostics } = collectWithDiag();
      await collect<{ v: number }>(stream, opts);

      const complete = diagnostics.find((d) => d.event === 'complete')!;
      expect(complete.diagnostic.events).toBe(2);
    });

    test('should emit invalid-json diagnostic for unparseable payloads', async () => {
      const stream = streamFromChunks([
        'data: not-json\n\ndata: {"ok":true}\n\ndata: also-bad\n\n',
      ]);
      const { opts, diagnostics } = collectWithDiag();
      await collect<{ ok: boolean }>(stream, opts);

      const invalidEvents = diagnostics.filter((d) => d.event === 'invalid-json');
      expect(invalidEvents.length).toBe(2);
    });

    test('should emit read-error diagnostic on stream failure', async () => {
      const stream = errorAfterChunks([], new Error('kaboom'));
      const { opts, diagnostics } = collectWithDiag();
      try {
        await collect(stream, opts);
      } catch {
        // expected
      }

      expect(diagnostics.some((d) => d.event === 'read-error')).toBe(true);
    });

    test('should emit large-chunk diagnostic for chunks >= 1MB', async () => {
      const largePayload = 'x'.repeat(1024 * 1024);
      const stream = streamFromChunks([
        `data: {"big":"${largePayload}"}\n\n`,
      ]);
      const { opts, diagnostics } = collectWithDiag();
      await collect<{ big: string }>(stream, opts);

      expect(diagnostics.some((d) => d.event === 'large-chunk')).toBe(true);
    });

    test('should not emit large-chunk diagnostic for chunks < 1MB', async () => {
      const stream = streamFromChunks(['data: {"v":1}\n\n']);
      const { opts, diagnostics } = collectWithDiag();
      await collect<{ v: number }>(stream, opts);

      expect(diagnostics.some((d) => d.event === 'large-chunk')).toBe(false);
    });

    test('should use provided streamName in diagnostics', async () => {
      const stream = streamFromChunks(['data: {"v":1}\n\n']);
      const { opts, diagnostics } = collectWithDiag('my-custom-stream');
      await collect<{ v: number }>(stream, opts);

      for (const d of diagnostics) {
        expect(d.diagnostic.streamName).toBe('my-custom-stream');
      }
    });

    test('should emit start diagnostic with zero counters', async () => {
      const stream = streamFromChunks(['data: {"v":1}\n\n']);
      const { opts, diagnostics } = collectWithDiag();
      await collect<{ v: number }>(stream, opts);

      const start = diagnostics.find((d) => d.event === 'start')!;
      expect(start.diagnostic).toMatchObject({ chunks: 0, bytes: 0, events: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // Real-world call-site patterns
  // ---------------------------------------------------------------------------

  describe('real-world patterns', () => {
    test('should parse Ollama pull progress stream', async () => {
      type OllamaPullProgress = {
        status: string;
        digest?: string;
        total?: number;
        completed?: number;
        done?: boolean;
        error?: string;
      };

      const values = await collect<OllamaPullProgress>(streamFromChunks([
        'data: {"status":"pulling manifest"}\n\n',
        'data: {"status":"downloading","digest":"sha256:abc","total":5000,"completed":1000}\n\n',
        'data: {"status":"downloading","digest":"sha256:abc","total":5000,"completed":3000}\n\n',
        'data: {"status":"downloading","digest":"sha256:abc","total":5000,"completed":5000}\n\n',
        'data: {"status":"verifying sha256 digest"}\n\n',
        'data: {"status":"success","done":true}\n\n',
      ]));

      expect(values.length).toBe(6);
      expect(values[0].status).toBe('pulling manifest');
      expect(values[3].completed).toBe(5000);
      expect(values[5]).toEqual({ status: 'success', done: true });
    });

    test('should parse Ollama pull with error response', async () => {
      type OllamaPullProgress = {
        status?: string;
        error?: string;
        done?: boolean;
      };

      const values = await collect<OllamaPullProgress>(streamFromChunks([
        'data: {"status":"pulling manifest"}\n\n',
        'data: {"error":"model not found"}\n\n',
      ]));

      expect(values.length).toBe(2);
      expect(values[1].error).toBe('model not found');
    });

    test('should parse workspace files stream with progress and final done event', async () => {
      type WorkspaceFilesStreamEvent =
        | { progress: number; done?: false }
        | { done: true; files: Array<{ name: string; type: string }>; progress?: number };

      const values = await collect<WorkspaceFilesStreamEvent>(streamFromChunks([
        'data: {"progress":10}\n\n',
        'data: {"progress":50}\n\n',
        'data: {"progress":90}\n\n',
        'data: {"done":true,"files":[{"name":"src","type":"directory"},{"name":"package.json","type":"file"}]}\n\n',
      ]));

      expect(values.length).toBe(4);
      expect(values[0]).toEqual({ progress: 10 });
      expect(values[1]).toEqual({ progress: 50 });
      const done = values[3] as { done: true; files: Array<{ name: string; type: string }> };
      expect(done.done).toBe(true);
      expect(done.files.length).toBe(2);
      expect(done.files[0].name).toBe('src');
    });

    test('should handle workspace files stream arriving in realistic fragmented chunks', async () => {
      type WorkspaceFilesStreamEvent =
        | { progress: number }
        | { done: true; files: Array<{ name: string; type: string }> };

      const values = await collect<WorkspaceFilesStreamEvent>(streamFromChunks([
        'data: {"progr',
        'ess":25}\n\ndata: {"progress":75}\n',
        '\ndata: {"done":true,"files":[{"name":"in',
        'dex.ts","type":"file"}]}\n\n',
      ]));

      expect(values.length).toBe(3);
      expect(values[0]).toEqual({ progress: 25 });
      expect(values[1]).toEqual({ progress: 75 });
      expect(values[2]).toMatchObject({ done: true, files: [{ name: 'index.ts' }] });
    });

    test('should handle LM Studio download stream with interleaved comments', async () => {
      type LMStudioDownloadProgress = {
        status: string;
        progress?: number;
        done?: boolean;
        error?: string;
      };

      const values = await collect<LMStudioDownloadProgress>(streamFromChunks([
        ': keepalive\n',
        'data: {"status":"downloading","progress":0}\n\n',
        ': keepalive\n',
        'data: {"status":"downloading","progress":50}\n\n',
        ': keepalive\n',
        'data: {"status":"success","done":true}\n\n',
      ]));

      expect(values.length).toBe(3);
      expect(values[0].progress).toBe(0);
      expect(values[1].progress).toBe(50);
      expect(values[2]).toMatchObject({ status: 'success', done: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-byte / encoding edge cases
  // ---------------------------------------------------------------------------

  describe('encoding', () => {
    test('should handle multi-byte UTF-8 characters split across chunks', async () => {
      const encoder = new TextEncoder();
      const fullPayload = 'data: {"emoji":"\u{1F600}"}\n\n';
      const bytes = encoder.encode(fullPayload);
      const midpoint = Math.floor(bytes.byteLength / 2);

      const values = await collect<{ emoji: string }>(streamFromByteChunks([
        bytes.slice(0, midpoint),
        bytes.slice(midpoint),
      ]));

      expect(values).toEqual([{ emoji: '\u{1F600}' }]);
    });

    test('should handle CJK characters in JSON values', async () => {
      const values = await collect<{ text: string }>(streamFromChunks([
        'data: {"text":"你好世界"}\n\n',
      ]));
      expect(values).toEqual([{ text: '你好世界' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // Regression guards for the old split-based parser bugs
  // ---------------------------------------------------------------------------

  describe('regression: old split-based parser pitfalls', () => {
    test('should not break on JSON values containing literal \\n (old split("\\n") would break)', async () => {
      const payload = JSON.stringify({ code: 'line1\nline2\nline3' });
      const values = await collect<{ code: string }>(streamFromChunks([
        `data: ${payload}\n\n`,
      ]));
      expect(values).toEqual([{ code: 'line1\nline2\nline3' }]);
    });

    test('should not confuse "data: " inside a JSON string value with an SSE field', async () => {
      const payload = JSON.stringify({ msg: 'the prefix data: is part of the value' });
      const values = await collect<{ msg: string }>(streamFromChunks([
        `data: ${payload}\n\n`,
      ]));
      expect(values).toEqual([{ msg: 'the prefix data: is part of the value' }]);
    });

    test('should handle many rapid small events without losing any', async () => {
      const count = 200;
      const chunks: string[] = [];
      for (let i = 0; i < count; i++) {
        chunks.push(`data: {"i":${i}}\n\n`);
      }
      const values = await collect<{ i: number }>(streamFromChunks(chunks));
      expect(values.length).toBe(count);
      expect(values.map((v) => v.i)).toEqual(Array.from({ length: count }, (_, i) => i));
    });

    test('should handle all events packed into one big chunk', async () => {
      const count = 100;
      let bigChunk = '';
      for (let i = 0; i < count; i++) {
        bigChunk += `data: {"i":${i}}\n\n`;
      }
      const values = await collect<{ i: number }>(streamFromChunks([bigChunk]));
      expect(values.length).toBe(count);
      expect(values[0].i).toBe(0);
      expect(values[count - 1].i).toBe(count - 1);
    });
  });
});
