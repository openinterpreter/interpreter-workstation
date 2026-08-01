import { describe, expect, test } from 'bun:test';

import { buildAdvancedVoiceDelegatedToolResponse } from '../shared/advanced-voice-tool-response';

describe('advanced voice delegated tool response', () => {
  test('keeps pending delegated work silent and user-facing', () => {
    const response = buildAdvancedVoiceDelegatedToolResponse('');
    const output = JSON.parse(response.output);

    expect(response.requestResponse).toBe(false);
    expect(response.followUpUserMessage).toBeUndefined();
    expect(output).toEqual({
      status: 'accepted_and_working',
      resultReady: false,
      responsePolicy: 'stay_silent_until_user_asks_for_progress_or_completion_notice',
      userFacingSpeechPolicy: 'do_not_speak',
    });
    expect(response.output).not.toContain('threadId');
    expect(response.output).not.toContain('normal_agent');
    expect(response.output).not.toContain('overlay_session');
  });

  test('requests one follow-up only when a user-visible result is ready', () => {
    const response = buildAdvancedVoiceDelegatedToolResponse('Done.');
    const output = JSON.parse(response.output);

    expect(response.requestResponse).toBe(true);
    expect(response.followUpUserMessage).toBe('The delegated work finished. Check the user-visible result now.');
    expect(output.status).toBe('finished');
    expect(output.resultReady).toBe(true);
    expect(output.userFacingSpeechPolicy).toContain('report_the_result');
  });
});
