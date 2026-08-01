/**
 * Telemetry enrichment context.
 *
 * Singleton that tracks ambient state the renderer can attach to every
 * telemetry event — current screen, previous screen, last user action,
 * active profile/model — so individual call sites don't have to pass
 * it and every error automatically becomes debuggable.
 */

const sessionStartedAt = Date.now();

type Profile = {
  profileId?: string;
  model?: string;
  provider?: string;
};

const state = {
  currentScreen: null as string | null,
  previousScreen: null as string | null,
  screenEnteredAt: sessionStartedAt,
  screenIndex: 0,

  lastUserActionEvent: null as string | null,
  lastUserActionAt: null as number | null,

  activeProfileId: null as string | null,
  activeModel: null as string | null,
  activeProvider: null as string | null,
};

export function setCurrentScreen(screen: string): { previousScreen: string | null; previousDurationMs: number } {
  const now = Date.now();
  const previousScreen = state.currentScreen;
  const previousDurationMs = now - state.screenEnteredAt;

  if (previousScreen === screen) {
    return { previousScreen, previousDurationMs: 0 };
  }

  state.previousScreen = previousScreen;
  state.currentScreen = screen;
  state.screenEnteredAt = now;
  state.screenIndex += 1;

  return { previousScreen, previousDurationMs };
}

export function getScreenIndex(): number {
  return state.screenIndex;
}

export function setActiveProfile(profile: Profile): void {
  if (profile.profileId !== undefined) state.activeProfileId = profile.profileId || null;
  if (profile.model !== undefined) state.activeModel = profile.model || null;
  if (profile.provider !== undefined) state.activeProvider = profile.provider || null;
}

export function noteUserAction(event: string): void {
  state.lastUserActionEvent = event;
  state.lastUserActionAt = Date.now();
}

export interface TelemetryEnrichment {
  currentScreen: string | null;
  previousScreen: string | null;
  screenIndex: number;
  lastUserActionEvent: string | null;
  lastUserActionMsAgo: number | null;
  sessionDurationMs: number;
  activeProfileId: string | null;
  activeModel: string | null;
  activeProvider: string | null;
}

export function getEnrichment(): TelemetryEnrichment {
  const now = Date.now();
  return {
    currentScreen: state.currentScreen,
    previousScreen: state.previousScreen,
    screenIndex: state.screenIndex,
    lastUserActionEvent: state.lastUserActionEvent,
    lastUserActionMsAgo: state.lastUserActionAt !== null ? now - state.lastUserActionAt : null,
    sessionDurationMs: now - sessionStartedAt,
    activeProfileId: state.activeProfileId,
    activeModel: state.activeModel,
    activeProvider: state.activeProvider,
  };
}

/** Test hook — resets the singleton between tests. */
export function __resetTelemetryContextForTests(): void {
  state.currentScreen = null;
  state.previousScreen = null;
  state.screenEnteredAt = Date.now();
  state.screenIndex = 0;
  state.lastUserActionEvent = null;
  state.lastUserActionAt = null;
  state.activeProfileId = null;
  state.activeModel = null;
  state.activeProvider = null;
}
