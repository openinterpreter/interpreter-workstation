import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  classifyOpenAIOAuthModelListError,
  getOpenAIOAuthModelListErrorMessage,
} from "./openaiOAuthErrors";

describe("getOpenAIOAuthModelListErrorMessage", () => {
  test("returns a sign-in message when the account is not connected", () => {
    assert.equal(
      getOpenAIOAuthModelListErrorMessage(new Error("OpenAI OAuth account is not connected")),
      "Sign in with ChatGPT to load models.",
    );
  });

  test("returns a supported-models message when the account has no models", () => {
    assert.equal(
      getOpenAIOAuthModelListErrorMessage(new Error("OpenAI OAuth account has no supported models")),
      "No supported ChatGPT models are available on this account.",
    );
  });

  test("returns null for unrelated errors", () => {
    assert.equal(
      getOpenAIOAuthModelListErrorMessage(new Error("network down")),
      null,
    );
  });

  test("classifies not connected errors", () => {
    assert.equal(
      classifyOpenAIOAuthModelListError(new Error("OpenAI OAuth account is not connected")),
      "not_connected",
    );
  });

  test("classifies no supported models errors", () => {
    assert.equal(
      classifyOpenAIOAuthModelListError(new Error("OpenAI OAuth account has no supported models")),
      "no_supported_models",
    );
  });

  test("classifies unknown errors as other", () => {
    assert.equal(
      classifyOpenAIOAuthModelListError(new Error("network down")),
      "other",
    );
  });
});
