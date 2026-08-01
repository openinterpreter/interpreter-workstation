import { createParser, type EventSourceMessage } from 'eventsource-parser';

export type SseStreamDiagnostic = {
  streamName: string;
  chunks: number;
  bytes: number;
  events: number;
};

export type SseStreamDiagnosticEvent = 'complete' | 'invalid-json' | 'large-chunk' | 'read-error' | 'start';

export type ReadJsonSseStreamOptions = {
  streamName: string;
  addDiagnosticBreadcrumb?: (event: SseStreamDiagnosticEvent, diagnostic: SseStreamDiagnostic) => void;
};

const LARGE_CHUNK_BYTES = 1024 * 1024;

function addDefaultDiagnosticBreadcrumb(event: SseStreamDiagnosticEvent, diagnostic: SseStreamDiagnostic): void {
  console.info(
    `[SSE] ${event} stream=${diagnostic.streamName} chunks=${diagnostic.chunks} bytes=${diagnostic.bytes} events=${diagnostic.events}`,
  );
}

export async function* readJsonSseStream<T>(
  body: ReadableStream<Uint8Array>,
  options: ReadJsonSseStreamOptions,
): AsyncGenerator<T> {
  const addDiagnosticBreadcrumb = options.addDiagnosticBreadcrumb ?? addDefaultDiagnosticBreadcrumb;
  const diagnostic: SseStreamDiagnostic = {
    streamName: options.streamName,
    chunks: 0,
    bytes: 0,
    events: 0,
  };
  const queue: T[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      const data = event.data.trim();
      if (!data || data === '[DONE]') {
        return;
      }

      try {
        queue.push(JSON.parse(data) as T);
        diagnostic.events += 1;
      } catch {
        addDiagnosticBreadcrumb('invalid-json', { ...diagnostic });
      }
    },
  });

  addDiagnosticBreadcrumb('start', { ...diagnostic });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        parser.feed(decoder.decode());
        break;
      }

      diagnostic.chunks += 1;
      diagnostic.bytes += value.byteLength;
      if (value.byteLength >= LARGE_CHUNK_BYTES) {
        addDiagnosticBreadcrumb('large-chunk', { ...diagnostic });
      }

      parser.feed(decoder.decode(value, { stream: true }));

      while (queue.length > 0) {
        yield queue.shift() as T;
      }
    }
  } catch (error) {
    addDiagnosticBreadcrumb('read-error', { ...diagnostic });
    throw error;
  } finally {
    reader.releaseLock();
  }

  while (queue.length > 0) {
    yield queue.shift() as T;
  }
  addDiagnosticBreadcrumb('complete', { ...diagnostic });
}
