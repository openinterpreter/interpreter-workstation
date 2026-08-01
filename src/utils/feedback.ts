export const FEEDBACK_POPOVER_OPEN_EVENT = 'feedback:open' as const;
export const FEEDBACK_BUTTON_FLASH_EVENT = 'feedback-button:flash' as const;

export function openFeedbackPopover(): void {
  window.dispatchEvent(new CustomEvent(FEEDBACK_POPOVER_OPEN_EVENT));
}

export function flashFeedbackButton(): void {
  window.dispatchEvent(new CustomEvent(FEEDBACK_BUTTON_FLASH_EVENT));
}
