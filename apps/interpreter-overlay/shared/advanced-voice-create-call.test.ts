import { describe, expect, test } from 'bun:test';
import {
  buildAdvancedVoiceCreateCallRequestBody,
  postAdvancedVoiceCreateCall,
} from './advanced-voice-create-call';

describe('advanced voice create-call request', () => {
  test('posts selected-context instructions to the realtime create-call endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const body = buildAdvancedVoiceCreateCallRequestBody({
      offerSdp: 'offer-sdp',
      instructions: [
        'Current overlay context packet follows.',
        '<overlay_context_packet>',
        'selected_context_snapshot_id: selected-context-1',
        'target_identity_id: overlay-target-1',
        'permission_scope_target_window_session_key: window-1',
        '</overlay_context_packet>',
      ].join('\n'),
      agentModel: 'interpreter-fast',
      workspacePath: '/workspace',
    });
    const fetchFn: typeof fetch = (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        success: true,
        answerSdp: 'answer-sdp',
        callId: 'call-1',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(postAdvancedVoiceCreateCall({
      fetchFn,
      baseUrl: 'https://api.example.test',
      bearerToken: 'token-secret',
      body,
    })).resolves.toEqual({
      answerSdp: 'answer-sdp',
      callId: 'call-1',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.test/realtime/calls');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({
      Authorization: 'Bearer token-secret',
      'Content-Type': 'application/json',
    });
    const postedBody = JSON.parse(String(calls[0].init.body));
    expect(postedBody).toEqual(body);
    expect(postedBody.instructions).toContain('selected_context_snapshot_id: selected-context-1');
    expect(postedBody.instructions).toContain('target_identity_id: overlay-target-1');
    expect(postedBody.instructions).toContain('permission_scope_target_window_session_key: window-1');
  });

  test('includes onboarding session kind only when requested', () => {
    expect(buildAdvancedVoiceCreateCallRequestBody({
      offerSdp: 'offer-sdp',
      instructions: 'instructions',
      agentModel: 'interpreter-fast',
      workspacePath: '/workspace',
    })).not.toHaveProperty('sessionKind');

    expect(buildAdvancedVoiceCreateCallRequestBody({
      offerSdp: 'offer-sdp',
      instructions: 'instructions',
      agentModel: 'interpreter-fast',
      workspacePath: '/workspace',
      sessionKind: 'onboarding_voice_interview',
    })).toMatchObject({
      sessionKind: 'onboarding_voice_interview',
    });
  });

  test('fails loudly when realtime create-call returns no answer SDP', async () => {
    const fetchFn: typeof fetch = (async () => new Response(JSON.stringify({
      success: false,
      error: 'denied',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    await expect(postAdvancedVoiceCreateCall({
      fetchFn,
      baseUrl: 'https://api.example.test',
      bearerToken: 'token-secret',
      body: buildAdvancedVoiceCreateCallRequestBody({
        offerSdp: 'offer-sdp',
        instructions: 'instructions',
        agentModel: 'interpreter-fast',
        workspacePath: '/workspace',
      }),
    })).rejects.toThrow('denied');
  });
});
