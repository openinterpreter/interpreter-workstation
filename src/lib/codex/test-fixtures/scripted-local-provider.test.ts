import { afterEach, describe, expect, test } from "bun:test";

import {
  ScriptedLocalProvider,
  type ScriptedScenario,
} from "./scripted-local-provider";

const CHAT_COMPLETIONS_SCENARIO: ScriptedScenario = {
  name: "chat-completions-text-success",
  modelsResponse: {
    object: "list",
    data: [
      {
        id: "chat-compatible-model",
        object: "model",
        created: 0,
        owned_by: "test",
      },
    ],
  },
  responseBehavior: {
    type: "text-success",
    deltas: ["Hello", ", ", "chat", "!"],
    finalText: "Hello, chat!",
  },
};

describe("ScriptedLocalProvider Chat Completions", () => {
  const servers: ScriptedLocalProvider[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers.length = 0;
  });

  test("should_stream_openai_chat_completion_chunks_and_capture_request", async () => {
    const server = new ScriptedLocalProvider();
    servers.push(server);
    server.setScenario(CHAT_COMPLETIONS_SCENARIO);

    const baseUrl = await server.start();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat-compatible-model",
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const streamText = await response.text();
    expect(streamText).toContain('"object":"chat.completion.chunk"');
    expect(streamText).toContain('"content":"Hello"');
    expect(streamText).toContain('"content":"chat"');
    expect(streamText).toContain("data: [DONE]");

    const chatRequest = server
      .getCapturedRequests()
      .find((request) => request.path === "/v1/chat/completions");
    expect(chatRequest?.method).toBe("POST");
    expect(chatRequest?.body).toEqual({
      model: "chat-compatible-model",
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    });
  });

  test("should_return_openai_chat_completion_json_for_non_stream_request", async () => {
    const server = new ScriptedLocalProvider();
    servers.push(server);
    server.setScenario(CHAT_COMPLETIONS_SCENARIO);

    const baseUrl = await server.start();
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat-compatible-model",
        messages: [{ role: "user", content: "Say hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const json = await response.json();
    expect(json).toMatchObject({
      object: "chat.completion",
      model: "chat-compatible-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello, chat!" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });

    const chatRequest = server
      .getCapturedRequests()
      .find((request) => request.path === "/chat/completions");
    expect(chatRequest?.method).toBe("POST");
  });
});
