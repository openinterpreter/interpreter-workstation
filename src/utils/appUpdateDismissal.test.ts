import { beforeEach, describe, expect, it } from 'bun:test';
import {
  dismissAppUpdateForSession,
  resetAppUpdateDismissalForTests,
  shouldSuppressAppUpdateForSession,
} from '../components/AppUpdateDialog';

describe('appUpdateDismissal', () => {
  beforeEach(() => {
    resetAppUpdateDismissalForTests();
  });

  it('does not suppress updates before dismissal', () => {
    expect(shouldSuppressAppUpdateForSession()).toBe(false);
  });

  it('suppresses updates for the rest of the session after dismissal', () => {
    dismissAppUpdateForSession();

    expect(shouldSuppressAppUpdateForSession()).toBe(true);
  });

  it('stays suppressed when dismissed multiple times', () => {
    dismissAppUpdateForSession();
    dismissAppUpdateForSession();

    expect(shouldSuppressAppUpdateForSession()).toBe(true);
  });
});
