import { describe, expect, test } from 'bun:test';

import { OVERLAY_AGENT_ALLOWED_TOOL_NAMES } from './overlay-agent-tools';

describe('overlay agent allowed tools', () => {
  test('keeps direct CUA element-control tools out of visible overlay agents', () => {
    expect(OVERLAY_AGENT_ALLOWED_TOOL_NAMES).toContain('builtin-interpreter-overlay__computer_batch');
    expect(OVERLAY_AGENT_ALLOWED_TOOL_NAMES).toContain('builtin-cua-driver__list_windows');
    expect(OVERLAY_AGENT_ALLOWED_TOOL_NAMES).toContain('builtin-cua-driver__get_ui_elements');
    expect(OVERLAY_AGENT_ALLOWED_TOOL_NAMES).toContain('builtin-cua-driver__set_window_bounds');
    expect(OVERLAY_AGENT_ALLOWED_TOOL_NAMES).not.toContain('builtin-cua-driver__set_value');
    expect(OVERLAY_AGENT_ALLOWED_TOOL_NAMES).not.toContain('builtin-cua-driver__type_text');
    expect(OVERLAY_AGENT_ALLOWED_TOOL_NAMES).not.toContain('builtin-cua-driver__click');
    expect(OVERLAY_AGENT_ALLOWED_TOOL_NAMES).not.toContain('builtin-cua-driver__select_option');
  });
});
