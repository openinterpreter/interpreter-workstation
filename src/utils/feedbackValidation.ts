const MIN_FEEDBACK_LENGTH = 10;

export function isMeaningfulFeedbackMessage(message: string): boolean {
  return message.trim().length >= MIN_FEEDBACK_LENGTH;
}
