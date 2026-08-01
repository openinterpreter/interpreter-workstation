export type AdvancedVoiceSessionKind = 'advanced_voice' | 'onboarding_voice_interview';

export interface AdvancedVoiceCreateCallRequestBody {
  offerSdp: string;
  instructions: string;
  agentModel: string;
  workspacePath: string;
  sessionKind?: AdvancedVoiceSessionKind;
}

export interface AdvancedVoiceCreateCallPayload {
  success?: boolean;
  answerSdp?: string;
  callId?: string | null;
  error?: string;
}

export interface AdvancedVoiceCreateCallResult {
  answerSdp: string;
  callId: string | null;
}

export function buildAdvancedVoiceCreateCallRequestBody(input: AdvancedVoiceCreateCallRequestBody): AdvancedVoiceCreateCallRequestBody {
  return {
    offerSdp: input.offerSdp,
    instructions: input.instructions,
    agentModel: input.agentModel,
    workspacePath: input.workspacePath,
    ...(input.sessionKind ? { sessionKind: input.sessionKind } : {}),
  };
}

export async function postAdvancedVoiceCreateCall(input: {
  fetchFn: typeof fetch;
  baseUrl: string;
  bearerToken: string;
  body: AdvancedVoiceCreateCallRequestBody;
}): Promise<AdvancedVoiceCreateCallResult> {
  const response = await input.fetchFn(`${input.baseUrl}/realtime/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input.body),
  });
  const payload = await response.json() as AdvancedVoiceCreateCallPayload;
  if (!response.ok || !payload.answerSdp) {
    throw new Error(payload.error ?? `Advanced voice session failed (${response.status}).`);
  }
  return {
    answerSdp: payload.answerSdp,
    callId: payload.callId ?? null,
  };
}
