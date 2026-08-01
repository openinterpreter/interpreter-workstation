import type { ReasoningEffort } from '../../shared/types/reasoning';
import { isReasoningEffort } from '../../shared/types/reasoning';

const STORAGE_KEY = 'workstation.defaultReasoningEffort.v1';

export function getStoredDefaultReasoningEffort(): ReasoningEffort | undefined {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isReasoningEffort(stored) ? stored : undefined;
  } catch (error) {
    console.error('Failed to load default reasoning effort:', error);
    return undefined;
  }
}

export function setStoredDefaultReasoningEffort(reasoningEffort: ReasoningEffort): void {
  try {
    localStorage.setItem(STORAGE_KEY, reasoningEffort);
  } catch (error) {
    console.error('Failed to save default reasoning effort:', error);
  }
}

export function clearStoredDefaultReasoningEffort(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear default reasoning effort:', error);
  }
}
