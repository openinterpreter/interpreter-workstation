import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

function readAdvancedVoiceController(): string {
  return fs.readFileSync(path.join(import.meta.dir, 'advanced-voice-controller.ts'), 'utf8');
}

function readOverlayRenderer(): string {
  return fs.readFileSync(path.join(import.meta.dir, '../renderer/overlay.tsx'), 'utf8');
}

function readOverlayService(): string {
  return fs.readFileSync(path.join(import.meta.dir, 'service.ts'), 'utf8');
}

function extractMethod(source: string, methodName: string): string {
  const methodStart = source.indexOf(methodName);
  expect(methodStart, `${methodName} should exist`).toBeGreaterThanOrEqual(0);
  const methodEnd = source.indexOf('\n  private ', methodStart + 1);
  expect(methodEnd, `${methodName} should end before the next private method`).toBeGreaterThan(methodStart);
  return source.slice(methodStart, methodEnd);
}

describe('advanced voice session kind contract', () => {
  test('passes overlay session kind into realtime create-call requests', () => {
    const rendererSource = readOverlayRenderer();
    expect(rendererSource).toContain('sessionKind: state.advancedVoiceSessionKind');
    expect(rendererSource).toContain('left.advancedVoiceSessionKind === right.advancedVoiceSessionKind');

    const createCallHandler = extractMethod(readAdvancedVoiceController(), 'private handleAdvancedVoiceCreateCall');
    expect(createCallHandler).toContain("const sessionKind = request.sessionKind ?? 'advanced_voice';");
    expect(createCallHandler).toContain('instructions: await this.buildAdvancedVoiceCreateCallInstructions(sessionKind)');
    expect(createCallHandler).toContain('sessionKind,');
  });

  test('allows the onboarding interview even when ordinary advanced voice is disabled', () => {
    const startWindowVoiceMode = extractMethod(readOverlayService(), 'async startWindowVoiceMode');
    expect(startWindowVoiceMode).toContain("const sessionKind = request?.sessionKind ?? 'advanced_voice';");
    expect(startWindowVoiceMode).toContain("const isOnboardingInterview = sessionKind === 'onboarding_voice_interview';");
    expect(startWindowVoiceMode).toContain('const activateOnboardingRuntime = isOnboardingInterview && !this.runtimeActive;');
    expect(startWindowVoiceMode).toContain('allowDisabledRuntime: isOnboardingInterview');
    expect(startWindowVoiceMode).toContain("this.advancedVoice.startAdvancedVoiceInput('button', sessionKind)");
  });

  test('tears down an onboarding-only runtime when advanced voice stops', () => {
    const serviceSource = readOverlayService();
    expect(serviceSource).toContain('onAdvancedVoiceStopped: (sessionKind) => {');
    expect(serviceSource).toContain("sessionKind !== 'onboarding_voice_interview'");
    expect(serviceSource).toContain('!this.onboardingVoiceRuntimeActivated');

    const stopAdvancedVoiceInput = extractMethod(readAdvancedVoiceController(), 'stopAdvancedVoiceInput(): void');
    expect(stopAdvancedVoiceInput).toContain('const sessionKind = this.overlayState.advancedVoiceSessionKind;');
    expect(stopAdvancedVoiceInput).toContain('this.host.onAdvancedVoiceStopped(sessionKind);');
  });

  test('keeps onboarding voice interview prompt separate from desktop voice tools', () => {
    const serviceSource = readAdvancedVoiceController();
    const selector = extractMethod(serviceSource, 'private async buildAdvancedVoiceCreateCallInstructions');
    expect(selector).toContain("sessionKind === 'onboarding_voice_interview'");
    expect(selector).toContain('this.buildOnboardingVoiceInterviewInstructions()');
    expect(selector).toContain('this.buildAdvancedVoiceInstructions()');

    const onboardingPrompt = extractMethod(serviceSource, 'private async buildOnboardingVoiceInterviewInstructions');
    expect(onboardingPrompt).toContain('complete_onboarding_voice_interview');
    expect(onboardingPrompt).not.toContain('computer_batch');
    expect(onboardingPrompt).not.toContain('send_message_to_agent');
    expect(onboardingPrompt).not.toContain('interpreter_tool');
    expect(onboardingPrompt).not.toContain('call_hidden_agent');
  });

  test('emits onboarding voice interview answers and stops voice after completion', () => {
    const serviceSource = readAdvancedVoiceController();
    const toolHandler = extractMethod(serviceSource, 'private handleAdvancedVoiceToolCall');
    expect(toolHandler).toContain("request.name === 'complete_onboarding_voice_interview'");
    expect(toolHandler).toContain("this.overlayState.advancedVoiceSessionKind !== 'onboarding_voice_interview'");
    expect(toolHandler).toContain('parseOnboardingVoiceInterviewToolArguments(request.argumentsJson)');
    expect(toolHandler).toContain('IPC_CHANNELS.INTERPRETER_OVERLAY_ONBOARDING_VOICE_INTERVIEW_COMPLETED');
    expect(toolHandler).toContain('this.stopAdvancedVoiceInput()');

    expect(serviceSource).toContain("from '../shared/onboarding-voice-interview.js'");
    expect(serviceSource).not.toContain('private parseOnboardingVoiceInterviewToolArguments');
  });
});
