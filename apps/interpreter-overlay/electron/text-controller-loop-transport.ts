import { getServerJWT } from '../../../server/lib/jwtStore';
import { resolveCodexProfileFromModelConfig } from '../../../server/utils/codexRuntime';
import {
  buildGroqProxyBaseUrl,
  routeGroqProfileThroughProxy,
} from '../../../server/utils/groqResponsesProxy';
import { getServerPort } from '../../../server/utils/serverPort';
import { withAuthToken } from '../../../src/lib/codex/profiles';
import { profileToModelConfig, type Profile } from '../../../shared/types/profile';
import type { OverlayTextControllerLoopTransport } from './text-controller-loop.js';

/**
 * Direct OpenAI-compatible chat.completions transport for the typed fast
 * controller loop. Profile resolution mirrors the computer_batch argument
 * repair model: interpreter profiles get the server JWT and Groq profiles
 * route through the local Groq proxy.
 */
export function createOverlayTextControllerLoopChatTransport(
  profile: Profile,
): OverlayTextControllerLoopTransport {
  const modelConfig = profileToModelConfig(profile);
  let codexProfile = resolveCodexProfileFromModelConfig(modelConfig);
  if (codexProfile.modelProvider === 'interpreter') {
    const jwt = getServerJWT();
    if (jwt) {
      codexProfile = withAuthToken(codexProfile, jwt);
    }
  }
  codexProfile = routeGroqProfileThroughProxy(
    codexProfile,
    buildGroqProxyBaseUrl(getServerPort()),
  );

  const baseUrl = codexProfile.providerConfig?.base_url?.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error(`Overlay fast text controller profile "${profile.id}" has no endpoint base URL.`);
  }
  const model = modelConfig.modelId;
  if (!model) {
    throw new Error(`Overlay fast text controller profile "${profile.id}" has no model id.`);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(codexProfile.providerConfig?.http_headers ?? {}),
  };
  const bearerToken = codexProfile.providerConfig?.experimental_bearer_token;
  const hasAuthorizationHeader = Object.keys(headers)
    .some((key) => key.toLowerCase() === 'authorization');
  if (bearerToken && !hasAuthorizationHeader) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  return async ({ messages, tools, signal }) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model,
        // The controller is a deterministic control loop over refs and
        // reported values; sampling variance directly causes dropped or
        // swapped field actions.
        temperature: 0,
        messages,
        tools: tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        tool_choice: 'auto',
      }),
    });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`fast controller chat completion failed (${response.status}): ${bodyText.slice(0, 400)}`);
    }

    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: unknown;
          tool_calls?: Array<{
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          }>;
        };
      }>;
    };
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new Error('fast controller chat completion returned no choices');
    }

    return {
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls: (message.tool_calls ?? []).map((toolCall, index) => ({
        id: typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : `call_${index}`,
        name: typeof toolCall.function?.name === 'string' ? toolCall.function.name : '',
        argumentsJson: typeof toolCall.function?.arguments === 'string'
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function?.arguments ?? {}),
      })),
    };
  };
}
