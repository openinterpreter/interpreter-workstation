/**
 * Vision Model Provider
 *
 * Routes all vision tasks through Codex.
 * Used by the read_image tool to support configurable vision models.
 */

import type { ModelConfig } from '../../shared/types/model';
import { getServerJWT } from '../lib/jwtStore';
import { getCodexService } from '../../src/lib/codex/service';
import type { StreamImageAttachment } from '../../src/lib/codex/api-types';
import { getServerPort } from './serverPort';
import { buildGroqProxyBaseUrl, routeGroqProfileThroughProxy } from './groqResponsesProxy';
import {
  buildProfileFromPreset,
  getCustomPreset,
  getProfile as getCodexProfile,
  type Profile as CodexProfile,
  withAuthToken,
} from '../../src/lib/codex/profiles';
import { inferProfileIdFromEndpoint } from '../../src/lib/codex/profile-options';
import { getCurrentWorkspace } from './workspace';

function resolveVisionCodexProfile(config: ModelConfig): CodexProfile {
  if (config.provider === 'hosted') {
    const profile = getCodexProfile('interpreter');
    const jwt = getServerJWT();
    return jwt ? withAuthToken(profile, jwt) : profile;
  }
  if (config.provider === 'openai-oauth') {
    return getCodexProfile('default');
  }
  const endpoint = config.baseURL || '';
  const presetId = inferProfileIdFromEndpoint(endpoint);
  const preset = getCustomPreset(presetId);
  if (!preset) {
    throw new Error(`No Codex preset for vision endpoint: ${endpoint || '<empty>'}`);
  }
  return routeGroqProfileThroughProxy(
    buildProfileFromPreset(preset, {
      baseUrl: config.baseURL,
      apiKey: config.apiKey,
      model: config.modelId,
    }),
    buildGroqProxyBaseUrl(getServerPort()),
  );
}

function detectMimeType(buffer: Buffer): string {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

export async function runVisionViaCodex(
  config: ModelConfig,
  prompt: string,
  imageBuffers: Buffer[],
  signal?: AbortSignal,
): Promise<string> {
  const profile = resolveVisionCodexProfile(config);
  const service = getCodexService();

  const workspace = getCurrentWorkspace() || '/tmp';
  const attachments: StreamImageAttachment[] = imageBuffers.map((buf, i) => {
    const mime = detectMimeType(buf);
    return {
      id: `vision-${i}`,
      kind: 'image' as const,
      name: `image-${i}`,
      mimeType: mime,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    };
  });

  let threadId = '';
  let turnId = '';
  await service.runTurn({
    message: prompt,
    attachments,
    model: config.modelId,
    modelProvider: profile.modelProvider!,
    providerConfig: profile.providerConfig,
    cwd: workspace,
    signal: signal ?? AbortSignal.timeout(60000),
    onEvent: (event) => {
      if (event.kind === 'thread') threadId = event.threadId;
      if (event.kind === 'turn') turnId = event.turnId;
    },
  });

  if (!threadId) {
    throw new Error('Vision via Codex failed: no thread created');
  }

  const thread = await service.readThread(threadId);
  const targetTurn = thread?.turns?.find((t: any) => t.id === turnId)
    ?? thread?.turns?.[thread.turns.length - 1];
  return targetTurn?.items
    ?.filter((item: any) => item.type === 'agentMessage')
    ?.map((item: any) => item.text || '')
    ?.join('') || '';
}
