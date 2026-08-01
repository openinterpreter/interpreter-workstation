import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

function readContractSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

function readAdvancedVoiceController(): string {
  return readContractSource(path.join(import.meta.dir, 'advanced-voice-controller.ts'));
}

function readOverlayControllerPrompt(): string {
  return readContractSource(path.join(import.meta.dir, 'overlay-controller-prompt.ts'));
}

function readOverlayRenderer(): string {
  return readContractSource(path.join(import.meta.dir, '../renderer/overlay.tsx'));
}

function readAdvancedVoiceTestAudio(): string {
  return readContractSource(path.join(import.meta.dir, 'advanced-voice-test-audio.ts'));
}

function extractMethod(source: string, methodName: string): string {
  const methodStart = source.indexOf(methodName);
  expect(methodStart).toBeGreaterThanOrEqual(0);
  const methodEnd = source.indexOf('\n  private ', methodStart + 1);
  expect(methodEnd).toBeGreaterThan(methodStart);
  return source.slice(methodStart, methodEnd);
}

describe('advanced voice action gating contract', () => {
  test('streams synthesized test audio through the realtime input buffer path', () => {
    const testAudioSource = readAdvancedVoiceTestAudio();
    const rendererSource = readOverlayRenderer();
    const inputStreamStart = rendererSource.indexOf('const createAdvancedVoiceInputStream = useCallback(async () => {');
    const inputStreamEnd = rendererSource.indexOf('\n  useEffect(() => {', inputStreamStart);
    expect(inputStreamStart).toBeGreaterThanOrEqual(0);
    expect(inputStreamEnd).toBeGreaterThan(inputStreamStart);
    const inputStream = rendererSource.slice(inputStreamStart, inputStreamEnd);

    expect(testAudioSource).toContain('INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_MANIFEST');
    expect(testAudioSource).toContain('INTERPRETER_OVERLAY_ADVANCED_VOICE_TEST_AUDIO_FILE');
    expect(testAudioSource).toContain("dataUrlForAudioPath(absolutePath, data)");
    expect(inputStream).toContain('const testAudio = await window.overlay.getAdvancedVoiceTestAudio();');
    expect(inputStream).toContain('navigator.mediaDevices.getUserMedia({ audio: true })');
    expect(inputStream).toContain('const response = await fetch(segment.dataUrl);');
    expect(inputStream).toContain('audioContext.decodeAudioData(audioData.slice(0))');
    expect(inputStream).toContain("sendIfOpen(channel, { type: 'input_audio_buffer.clear' })");
    expect(inputStream).toContain("sendIfOpen(channel, { type: 'input_audio_buffer.commit' })");
    expect(inputStream).toContain('requestAdvancedVoiceResponse(channel)');
    expect(inputStream).toContain("recordAdvancedVoiceAudioEvent({\n            type: 'segment_started'");
    expect(inputStream).toContain("recordAdvancedVoiceAudioEvent({\n            type: 'input_committed'");
    expect(inputStream).toContain("recordAdvancedVoiceAudioEvent({\n            type: 'response_requested'");
  });

  test('tracks realtime speech state from renderer audio events', () => {
    const serviceSource = readAdvancedVoiceController();
    const audioEventHandler = extractMethod(serviceSource, 'private handleAdvancedVoiceAudioEvent');
    const rendererSource = readOverlayRenderer();

    expect(serviceSource).toContain('private advancedVoiceSpeechInputOpen = false;');
    expect(audioEventHandler).toContain("type === 'input_audio_buffer.speech_started'");
    expect(audioEventHandler).toContain("type === 'input_audio_buffer.speech_stopped'");
    expect(audioEventHandler).toContain("type === 'input_audio_buffer.committed'");
    expect(audioEventHandler).toContain('this.advancedVoiceSpeechInputOpen = true;');
    expect(audioEventHandler).toContain('this.advancedVoiceSpeechInputOpen = false;');
    expect(rendererSource).toContain("eventType === 'input_audio_buffer.speech_started'");
    expect(rendererSource).toContain("eventType === 'input_audio_buffer.speech_stopped'");
    expect(rendererSource).toContain("eventType === 'input_audio_buffer.committed'");
    expect(rendererSource).toContain('recordAdvancedVoiceAudioEvent({ type: eventType })');
  });

  test('does not send late realtime events after the voice session closes', () => {
    const rendererSource = readOverlayRenderer();
    expect(rendererSource).toContain(
      "const requestAdvancedVoiceResponse = useCallback((channel: RTCDataChannel) => {\n    if (channel.readyState !== 'open')",
    );
    expect(rendererSource).toContain(
      "const result = await window.overlay.handleAdvancedVoiceToolCall({",
    );
    expect(rendererSource).toContain(
      "if (channel.readyState !== 'open') {\n      return;\n    }\n    channel.send(JSON.stringify({",
    );
    expect(rendererSource).toContain(
      'void handleAdvancedVoiceEvent(parsed, channel).catch((error) => {',
    );
  });

  test('blocks immediate actionful tools while speech input is open', () => {
    const serviceSource = readAdvancedVoiceController();
    const toolHandler = extractMethod(serviceSource, 'private handleAdvancedVoiceToolCall');
    const speakingBlockHelper = extractMethod(serviceSource, 'private getAdvancedVoiceSpeakingBlockResponse');

    const sendBranchStart = toolHandler.indexOf("if (request.name === 'send_message_to_agent')");
    const computerBatchBranchStart = toolHandler.indexOf('if (request.name === REALTIME_COMPUTER_BATCH_TOOL_NAME)');
    const queryBranchStart = toolHandler.indexOf("if (request.name === 'query_attachments')");
    const hiddenBranchStart = toolHandler.indexOf("if (request.name === 'call_hidden_agent')");
    expect(sendBranchStart).toBeGreaterThanOrEqual(0);
    expect(computerBatchBranchStart).toBeGreaterThan(sendBranchStart);
    expect(queryBranchStart).toBeGreaterThan(computerBatchBranchStart);
    expect(hiddenBranchStart).toBeGreaterThan(queryBranchStart);

    const sendBranch = toolHandler.slice(sendBranchStart, computerBatchBranchStart);
    const computerBatchBranch = toolHandler.slice(computerBatchBranchStart, queryBranchStart);
    const queryBranch = toolHandler.slice(queryBranchStart, hiddenBranchStart);
    const hiddenBranch = toolHandler.slice(hiddenBranchStart);

    expect(sendBranch).toContain('this.getAdvancedVoiceSpeakingBlockResponse(request.name)');
    expect(sendBranch).toContain('return speakingBlock;');
    expect(computerBatchBranch).toContain('this.getAdvancedVoiceSpeakingBlockResponse(request.name)');
    expect(computerBatchBranch).toContain('return speakingBlock;');
    expect(hiddenBranch).toContain('this.getAdvancedVoiceSpeakingBlockResponse(request.name)');
    expect(hiddenBranch).toContain('return speakingBlock;');
    expect(computerBatchBranch.indexOf('this.getAdvancedVoiceSpeakingBlockResponse(request.name)'))
      .toBeLessThan(computerBatchBranch.indexOf('this.callAdvancedVoiceComputerBatchTool'));
    expect(computerBatchBranch).not.toContain('overlaySessionManager.computerBatch');
    expect(queryBranch).not.toContain('getAdvancedVoiceSpeakingBlockResponse');
    expect(speakingBlockHelper).toContain("status: 'not_executed_user_still_speaking'");
    expect(speakingBlockHelper).toContain('requestResponse: false');
    expect(speakingBlockHelper).not.toContain('countdown');
    expect(speakingBlockHelper).not.toContain('auto_fire');
    const promptSource = readOverlayControllerPrompt();
    expect(promptSource).toContain('After the user finishes speaking, if the request still applies, call the needed tool then.');
    expect(promptSource).toContain('computer_batch proposes through review when needed and executes reviewed actions only after approval; there is no auto-fire mode in v1.');
    expect(promptSource).toContain('If computer_batch, send_message_to_agent, or call_hidden_agent returns status not_executed_user_still_speaking');
    expect(serviceSource).not.toContain('interpreter_tool');
  });
});
