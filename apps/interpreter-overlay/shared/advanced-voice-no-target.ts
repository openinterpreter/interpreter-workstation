export const ADVANCED_VOICE_NO_TARGET_CONTEXT_MAX_CHARS = 12_000;

export interface AdvancedVoiceNoTargetLaunchMessageOptions {
  message: string;
  observedForegroundApp?: string | null;
  observedContextLabel?: string | null;
  observedBounds?: string | null;
  observedWindowName?: string | null;
  initialScreenshotPath?: string | null;
  initialAccessibilityText?: string | null;
}

export function formatAdvancedVoiceNoTargetInitialContext(
  text: string | null | undefined,
  maxChars = ADVANCED_VOICE_NO_TARGET_CONTEXT_MAX_CHARS,
): string | null {
  const trimmedText = text?.trim();
  if (!trimmedText) {
    return null;
  }

  if (trimmedText.length <= maxChars) {
    return trimmedText;
  }

  return `${trimmedText.slice(0, maxChars).trimEnd()}\n[initial desktop accessibility context truncated after ${maxChars} chars; call get_app_state for live current state before acting]`;
}

export function buildAdvancedVoiceNoTargetLaunchMessageBody(
  options: AdvancedVoiceNoTargetLaunchMessageOptions,
): string {
  const contextLines = [
    '<desktop_context>',
    'No overlay target is attached. The user removed the active-app target chip, so this context is identity/evidence only, not a controllable overlay grant.',
  ];

  if (options.observedForegroundApp) {
    contextLines.push(`observed_foreground_app: ${options.observedForegroundApp}`);
  }
  if (options.observedContextLabel) {
    contextLines.push(`observed_context_label: ${options.observedContextLabel}`);
  }
  if (options.observedBounds) {
    contextLines.push(`observed_bounds: ${options.observedBounds}`);
  }
  if (options.observedWindowName) {
    contextLines.push(`observed_window_name: ${options.observedWindowName}`);
  }
  if (options.initialScreenshotPath) {
    contextLines.push(`initial_screenshot_path: ${options.initialScreenshotPath}`);
  }
  contextLines.push('</desktop_context>');

  const initialContext = formatAdvancedVoiceNoTargetInitialContext(
    options.initialAccessibilityText,
  );
  const initialContextBlock = initialContext
    ? `\n\n<initial_desktop_accessibility_context>\n${initialContext}\n</initial_desktop_accessibility_context>`
    : '';

  return `${contextLines.join('\n')}${initialContextBlock}\n\n<user_request>\n${options.message}\n</user_request>`;
}
