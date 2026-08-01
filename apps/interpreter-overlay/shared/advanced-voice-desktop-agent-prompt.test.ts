import { describe, expect, test } from 'bun:test';
import { buildAdvancedVoiceDesktopAgentSystemPrompt } from './advanced-voice-desktop-agent-prompt';

describe('advanced voice no-target desktop agent prompt', () => {
  test('keeps the delegated desktop agent on the narrow CUA tool contract', () => {
    const prompt = buildAdvancedVoiceDesktopAgentSystemPrompt();

    expect(prompt).toContain('use only these CUA tools: get_app_state, get_ui_elements, set_value, select_option, click, press_key, and scroll');
    expect(prompt).toContain('interpreter-app tools builtin-cua-driver TOOL_NAME --json JSON_ARGS');
    expect(prompt).toContain('Do not call interpreter-app tools list');
    expect(prompt).toContain('interpreter-app tools find');
    expect(prompt).toContain('--help');
    expect(prompt).toContain('Do not write get_app_state output to files');
    expect(prompt).toContain('--save-to-disk');
    expect(prompt).toContain('Read the returned <interactive_elements> block directly');
    expect(prompt).toContain('numeric element_index values');
  });

  test('preserves general desktop CUA behavior without benchmark-specific field hints', () => {
    const prompt = buildAdvancedVoiceDesktopAgentSystemPrompt();

    expect(prompt).toContain('Treat the currently visible desktop and foreground application as the target');
    expect(prompt).toContain('For browser and web-rendered forms, work from concrete controls in the live app state.');
    expect(prompt).toContain('Do not use Tab to traverse the form.');
    expect(prompt).not.toContain('Endorsement Type');
    expect(prompt).not.toContain('Policy Number');
    expect(prompt).not.toContain('Harbor Avenue');
  });
});
