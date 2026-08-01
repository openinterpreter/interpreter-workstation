import { describe, expect, test } from 'bun:test';

import { buildOverlayMainAgentSystemPrompt } from './main-agent-prompt';

describe('buildOverlayMainAgentSystemPrompt', () => {
  test('requires capture-only AX tasks to detach before any non-overlay work', () => {
    const prompt = buildOverlayMainAgentSystemPrompt({
      mode: 'ax',
      grantedSquare: '(x=10, y=20, width=300, height=200)',
      displayId: 'display-1',
      elementCount: 14,
      initialScreenshotPath: '/tmp/overlay-scope.png',
    });

    expect(prompt).toContain('Before doing any non-overlay work');
    expect(prompt).toContain('The live overlay remains attached until you explicitly call `overlay_detach` or `overlay_complete` during the task.');
    expect(prompt).toContain('Treat the live overlay session as explicitly owned state.');
    expect(prompt).toContain('Run overlay tool commands directly with `interpreter-app tools ...`.');
    expect(prompt).toContain('Do NOT wrap them in `/bin/zsh -lc`, `bash -lc`, or another nested shell.');
    expect(prompt).toContain('For multi-action `computer_batch` calls, write the full args object to `/tmp/interpreter-overlay-computer-batch.json`');
    expect(prompt).toContain('computer_batch --json-file /tmp/interpreter-overlay-computer-batch.json');
    expect(prompt).toContain('Generate the args file by calling Node `fs.writeFileSync("/tmp/interpreter-overlay-computer-batch.json", JSON.stringify({ actions }))`');
    expect(prompt).toContain('Do not use bare `JSON.stringify(...)` without `console.log` or `fs.writeFileSync`; that writes nothing.');
    expect(prompt).toContain('Do not use Python, heredocs, or manually balanced raw JSON for multi-action batches.');
    expect(prompt).toContain('live overlay reads return AX text plus a saved screenshot file reference');
    expect(prompt).toContain('`computer_batch`');
    expect(prompt).not.toContain('query_attachment');
    expect(prompt).not.toContain('query_screen');
    expect(prompt).toContain('It uses the shared overlay batch executor.');
    expect(prompt).not.toContain('It is the same batch executor used by a separate form-fill mode.');
    expect(prompt).toContain('your first tool call must be `interpreter-app tools builtin-interpreter-overlay overlay_detach --json \'{}\'`');
    expect(prompt).toContain('Do that before running shell commands, workspace tools, or any other non-overlay tool');
    expect(prompt).toContain('It does NOT revoke the initial AX snapshot or the initial screenshot path listed above.');
    expect(prompt).toContain('Do NOT keep the overlay attached just to preserve the initial context. That remains available after detaching.');
    expect(prompt).toContain('Keep the overlay attached only while you actively need more screenshots, AX rereads, or direct interaction inside the granted square.');
    expect(prompt).toContain('You must not end a turn while the live overlay session is still attached.');
    expect(prompt).toContain('Detaching or completing is terminal for the live overlay session.');
    expect(prompt).toContain('For live UI-completion tasks such as filling or submitting a form, do NOT call `overlay_detach` or `overlay_complete` until the final visible completion action in that square has succeeded');
    expect(prompt).toContain('If the live overlay tools are your only granted tools, detaching or completing before the UI task is fully done throws away your only path to continue that on-screen task.');
    expect(prompt).toContain('If the UI shows a visible validation error, incomplete-state warning, or "required fields" message after you try to save or submit, the task is not complete.');
    expect(prompt).toContain('first build a private checklist from the user\'s exact request');
    expect(prompt).toContain('every named text field, dropdown, radio choice, checkbox, note/body field');
    expect(prompt).toContain('before saying the task is done, compare each checklist item against the latest visible state or tool result');
    expect(prompt).toContain('If any prior approved batch in this task already ended with the intended save/submit action');
    expect(prompt).toContain('A still-visible unchanged save/submit button is not by itself evidence that the submit failed.');
    expect(prompt).toContain('Preserve user-provided field values literally.');
    expect(prompt).toContain('Do not normalize dates, abbreviate addresses, change punctuation, change casing, or rewrite prose');
    expect(prompt).toContain('Batch as much as possible in each `computer_batch` call');
    expect(prompt).toContain('Do not spend your first live overlay tool call on `overlay_read_context`');
    expect(prompt).toContain('start with `computer_batch` immediately instead of rereading first');
    expect(prompt).toContain('A stable visible form should normally require one reviewed `computer_batch`.');
    expect(prompt).toContain('Known AX/native dropdown values are stable `type` actions on their dropdown controls');
    expect(prompt).toContain('Do not announce "two passes", "stages", "first text then dropdowns"');
    expect(prompt).toContain('Batch as much as possible in each `computer_batch` call');
    expect(prompt).toContain('If the same form can be completed from the current context and its save/submit control is already visible, include the text fields, note/body fields, standard dropdown/radio/checkbox choices, and final save/submit action in that same batch.');
    expect(prompt).toContain('do not split them into a later batch just because they are dropdowns.');
    expect(prompt).toContain('or similar staged form work when the current context already identifies the requested controls and values.');
    expect(prompt).toContain('Stop before submit only when the current batch leaves uncertain state');
    expect(prompt).toContain('Do not do one batch for text fields and another batch for dropdowns, checkboxes, notes, or submit when those controls are already visible and their requested values are known.');
    expect(prompt).toContain('Do not announce staged form work; act with one complete batch when the current context supports one complete batch.');
    expect(prompt).toContain('include all stable field edits, standard dropdown/radio/checkbox choices, note/body edits, and the final visible save/submit click in the first `computer_batch` call');
    expect(prompt).toContain('A stable visible form is not a reason to plan stages; it is the reason to submit one complete reviewed batch.');
    expect(prompt).toContain('Additional unified computer API tools may also be available');
    expect(prompt).toContain('`builtin-cua-driver`: app/window inspection and window lifecycle primitives');
    expect(prompt).toContain('`builtin-interpreter`: whole-computer state plus browser tab/page primitives');
    expect(prompt).toContain('Use `computer_batch` for reviewed actions inside the currently granted overlay square.');
    expect(prompt).toContain('Do not call direct CUA element-control tools such as `builtin-cua-driver set_value`');
    expect(prompt).toContain('those actions belong in `computer_batch` so the overlay review UI stays authoritative.');
    expect(prompt).toContain('Use direct computer API tools only for window/tab/app operations, browser-page control, selection reads, and agent-window handoff.');
    expect(prompt).toContain('use one `computer_batch` `type` action for that element with `clear_first:true`');
    expect(prompt).toContain('Do not emulate replacement with a separate click, `cmd+a`, Backspace/Delete, or targetless typing sequence');
  });

  test('describes screenshot-first behavior in vision mode', () => {
    const prompt = buildOverlayMainAgentSystemPrompt({
      mode: 'vision',
      grantedSquare: '(x=10, y=20, width=300, height=200)',
      displayId: 'display-2',
      elementCount: 0,
      initialScreenshotPath: '/tmp/overlay-scope-vision.png',
    });

    expect(prompt).toContain('It does NOT revoke the initial screenshot path listed above.');
    expect(prompt).toContain('Do not spend your first live overlay tool call on `overlay_read_context` or `overlay_screenshot`');
    expect(prompt).toContain('live overlay reads return a saved screenshot file reference');
    expect(prompt).toContain('Treat that screenshot as the primary source of truth for what is on screen in vision mode.');
    expect(prompt).toContain('No accessibility-tree text is provided in the first user message in vision mode.');
    expect(prompt).toContain('Vision-mode rules for the attached overlay tool session:');
    expect(prompt).toContain('Prefer `element_description` for visible targets.');
    expect(prompt).toContain('you may also provide `x` and `y` screenshot coordinates');
    expect(prompt).toContain('call `overlay_screenshot` or `overlay_read_context` before acting again');
  });
});
