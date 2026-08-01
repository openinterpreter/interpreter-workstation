import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScenarioResponseBehavior =
  | { type: "text-success"; deltas: string[]; finalText: string }
  | { type: "error"; httpStatus: number; body: object }
  | { type: "auth-required" }
  | { type: "stream-disconnect"; afterDeltas: number }
  | { type: "malformed-stream" }
  | {
      type: "sequence";
      responses: Array<
        | { type: "sse"; body: string }
        | { type: "json"; httpStatus: number; body: object }
      >;
    };

export interface ScriptedScenario {
  name: string;
  modelsResponse: object;
  responseBehavior: ScenarioResponseBehavior;
}

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseData(data: object | "[DONE]"): string {
  return data === "[DONE]"
    ? "data: [DONE]\n\n"
    : `data: ${JSON.stringify(data)}\n\n`;
}

function buildTextSuccessStream(deltas: string[], finalText: string): string {
  let out = "";

  out += sseEvent({
    type: "response.created",
    response: {
      id: "resp_1",
      object: "response",
      status: "in_progress",
      output: [],
    },
  });

  out += sseEvent({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_1",
      type: "message",
      role: "assistant",
      content: [],
    },
  });

  out += sseEvent({
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  for (const delta of deltas) {
    out += sseEvent({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta,
    });
  }

  out += sseEvent({
    type: "response.content_part.done",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: finalText },
  });

  out += sseEvent({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "item_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: finalText }],
    },
  });

  out += sseEvent({
    type: "response.completed",
    response: {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          id: "item_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: finalText }],
        },
      ],
    },
  });

  return out;
}

function buildChatCompletionStream(model: string, deltas: string[]): string {
  const id = "chatcmpl_1";
  const created = 0;
  let out = "";

  out += sseData({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  });

  for (const delta of deltas) {
    out += sseData({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: null,
        },
      ],
    });
  }

  out += sseData({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  });
  out += sseData("[DONE]");

  return out;
}

function buildChatCompletionResponse(model: string, finalText: string): object {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: finalText },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function buildDisconnectStream(afterDeltas: number): string {
  let out = "";

  out += sseEvent({
    type: "response.created",
    response: {
      id: "resp_1",
      object: "response",
      status: "in_progress",
      output: [],
    },
  });

  out += sseEvent({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_1",
      type: "message",
      role: "assistant",
      content: [],
    },
  });

  out += sseEvent({
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  for (let i = 0; i < afterDeltas; i++) {
    out += sseEvent({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: `chunk_${i} `,
    });
  }

  // Connection drops here -- no completion events.
  return out;
}

function buildChatCompletionDisconnectStream(
  model: string,
  afterDeltas: number,
): string {
  const id = "chatcmpl_1";
  const created = 0;
  let out = "";

  out += sseData({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  });

  for (let i = 0; i < afterDeltas; i++) {
    out += sseData({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: `chunk_${i} ` },
          finish_reason: null,
        },
      ],
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class ScriptedLocalProvider {
  private _server: Server | null = null;
  private _scenario: ScriptedScenario | null = null;
  private _captured: CapturedRequest[] = [];
  private _responseIndex = 0;

  setScenario(scenario: ScriptedScenario): void {
    this._scenario = scenario;
    this._responseIndex = 0;
  }

  getCapturedRequests(): CapturedRequest[] {
    return [...this._captured];
  }

  clearCapturedRequests(): void {
    this._captured = [];
  }

  async start(): Promise<string> {
    if (this._server) {
      throw new Error("ScriptedLocalProvider already started");
    }

    this._server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
        }
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      this._server!.once("error", reject);
      this._server!.listen(0, "127.0.0.1", () => resolve());
    });

    const address = this._server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this._server) return;
    const server = this._server;
    this._server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // -----------------------------------------------------------------------
  // Request handling
  // -----------------------------------------------------------------------

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    this._captured.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: this.flattenHeaders(req),
      body,
    });

    const scenario = this._scenario;
    if (!scenario) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "No scenario configured" }));
      return;
    }

    const path = (req.url ?? "/").replace(/\?.*$/, "");

    if (path === "/v1/models" || path === "/models") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(scenario.modelsResponse));
      return;
    }

    if (path === "/v1/responses" || path === "/responses") {
      this.handleResponses(res, scenario.responseBehavior);
      return;
    }

    if (path === "/v1/chat/completions" || path === "/chat/completions") {
      this.handleChatCompletions(res, scenario.responseBehavior, body);
      return;
    }

    // Fallback: 404
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: `Unknown path: ${path}` }));
  }

  private handleResponses(
    res: ServerResponse,
    behavior: ScenarioResponseBehavior,
  ): void {
    switch (behavior.type) {
      case "sequence": {
        const response = behavior.responses[this._responseIndex];
        this._responseIndex += 1;

        if (!response) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: `No scripted response configured for /responses call #${this._responseIndex}`,
            }),
          );
          return;
        }

        if (response.type === "json") {
          res.statusCode = response.httpStatus;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(response.body));
          return;
        }

        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.write(response.body);
        res.end();
        return;
      }

      case "text-success": {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.write(buildTextSuccessStream(behavior.deltas, behavior.finalText));
        res.end();
        return;
      }

      case "error": {
        res.statusCode = behavior.httpStatus;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(behavior.body));
        return;
      }

      case "auth-required": {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              message: "An LM Studio API token is required",
              type: "auth_error",
              code: "auth_required",
            },
          }),
        );
        return;
      }

      case "stream-disconnect": {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.write(buildDisconnectStream(behavior.afterDeltas));
        // Destroy the socket to simulate abrupt disconnect.
        res.destroy();
        return;
      }

      case "malformed-stream": {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.write("data: {invalid json\n\n");
        res.end();
        return;
      }
    }
  }

  private handleChatCompletions(
    res: ServerResponse,
    behavior: ScenarioResponseBehavior,
    body: unknown,
  ): void {
    const model = readModelFromBody(body);
    const stream = isRecord(body) && body.stream === true;

    switch (behavior.type) {
      case "sequence": {
        const response = behavior.responses[this._responseIndex];
        this._responseIndex += 1;

        if (!response) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: `No scripted response configured for /chat/completions call #${this._responseIndex}`,
            }),
          );
          return;
        }

        if (response.type === "json") {
          res.statusCode = response.httpStatus;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(response.body));
          return;
        }

        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.write(response.body);
        res.end();
        return;
      }

      case "text-success": {
        res.statusCode = 200;
        if (!stream) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              buildChatCompletionResponse(model, behavior.finalText),
            ),
          );
          return;
        }
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.write(buildChatCompletionStream(model, behavior.deltas));
        res.end();
        return;
      }

      case "error": {
        res.statusCode = behavior.httpStatus;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(behavior.body));
        return;
      }

      case "auth-required": {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              message: "A Chat Completions API token is required",
              type: "auth_error",
              code: "auth_required",
            },
          }),
        );
        return;
      }

      case "stream-disconnect": {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.write(
          buildChatCompletionDisconnectStream(model, behavior.afterDeltas),
        );
        res.destroy();
        return;
      }

      case "malformed-stream": {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.write("data: {invalid json\n\n");
        res.end();
        return;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
      );
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  private flattenHeaders(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        out[key] = value;
      } else if (Array.isArray(value)) {
        out[key] = value.join(", ");
      }
    }
    return out;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModelFromBody(body: unknown): string {
  return isRecord(body) && typeof body.model === "string"
    ? body.model
    : "mock-model";
}
