import { describe, expect, test } from 'bun:test';

import {
  buildAdvancedVoiceNoTargetLaunchMessageBody,
  formatAdvancedVoiceNoTargetInitialContext,
} from './advanced-voice-no-target';

describe('advanced voice no-target launch message', () => {
  test('includes observed desktop identity and captured accessibility context', () => {
    const body = buildAdvancedVoiceNoTargetLaunchMessageBody({
      message: 'Fill out the visible form.',
      observedForegroundApp: 'Chromium',
      observedContextLabel: 'Active app: Chromium',
      observedBounds: 'x=40, y=70, width=1200, height=721',
      observedWindowName: 'Overlay Browser Form Demo Fixtures - Chromium',
      initialScreenshotPath: '/tmp/interpreter-overlay-context.png',
      initialAccessibilityText: '<window name="Overlay Browser Form Demo Fixtures - Chromium">\n<input id="name" />\n</window>',
    });

    expect(body).toContain('<desktop_context>');
    expect(body).toContain('observed_foreground_app: Chromium');
    expect(body).toContain('observed_context_label: Active app: Chromium');
    expect(body).toContain('observed_bounds: x=40, y=70, width=1200, height=721');
    expect(body).toContain('observed_window_name: Overlay Browser Form Demo Fixtures - Chromium');
    expect(body).toContain('initial_screenshot_path: /tmp/interpreter-overlay-context.png');
    expect(body).toContain('<initial_desktop_accessibility_context>');
    expect(body).toContain('<input id="name" />');
    expect(body).toContain('<user_request>\nFill out the visible form.\n</user_request>');
  });

  test('bounds long captured accessibility context', () => {
    const formatted = formatAdvancedVoiceNoTargetInitialContext(
      `${'a'.repeat(20)}\nimportant trailing text`,
      12,
    );

    expect(formatted).toBe(
      'aaaaaaaaaaaa\n[initial desktop accessibility context truncated after 12 chars; call get_app_state for live current state before acting]',
    );
  });

  test('omits empty initial context block', () => {
    const body = buildAdvancedVoiceNoTargetLaunchMessageBody({
      message: 'What is on screen?',
      initialAccessibilityText: '   ',
    });

    expect(body).not.toContain('<initial_desktop_accessibility_context>');
    expect(body).toContain('<user_request>\nWhat is on screen?\n</user_request>');
  });
});
