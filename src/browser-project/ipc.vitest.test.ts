import { expect, test, vi } from 'vitest';
import { IpcUnavailableError, isIpcUnavailableError } from '../../shared/ipcAvailability';
import { BROWSER_PROJECT_CAPABILITIES, DESKTOP_HOST_CAPABILITIES } from '../../shared/types/hostCapabilities';
import { CLIENT_METHOD } from '../lib/codex/protocol';
import { shouldShowOnboarding } from '../lib/onboardingGate';

test('browser project apiRequest denies every native path before fetch', async () => {
  const { apiRequest, disableBrowserProjectNativeEvents, registerBrowserProjectIdentity,
    restoreBrowserProjectNativeEvents } = await import('../ipc');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  disableBrowserProjectNativeEvents();
  registerBrowserProjectIdentity('native-api-denied');
  try {
    for (const path of ['/api/servers/whatsapp/thread-binding', '/api/ipc/providers/getStatus',
      '/api/arbitrary-native-operation']) {
      expect(await apiRequest({ method: 'GET', path })).toMatchObject({
        ok: false, status: 501, data: { error: expect.stringContaining('unavailable') },
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    restoreBrowserProjectNativeEvents('native-api-denied');
    fetchSpy.mockRestore();
  }
});

test('ordinary browser desktop-host apiRequest still reaches its server', async () => {
  const { apiRequest } = await import('../ipc');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ native: true }));
  try {
    expect(await apiRequest({ method: 'GET', path: '/api/desktop-status' }))
      .toEqual({ ok: true, status: 200, data: { native: true } });
    expect(fetchSpy).toHaveBeenCalledOnce();
  } finally {
    fetchSpy.mockRestore();
  }
});

test('explicit browser host capability prevents native event subscription and reconnect', async () => {
  const events = vi.fn();
  vi.stubGlobal('EventSource', events);
  const { disableBrowserProjectNativeEvents, registerBrowserProjectLocalProfile,
    agentNotifications, files, profiles, topNotices, skills, apiRequest } = await import('../ipc');
  disableBrowserProjectNativeEvents();
  registerBrowserProjectLocalProfile('project_A', 'local_model_A', 'Local model A');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const missingDirectory = await files.isDirectory('browser-project:project_A')
    .catch((reason: unknown) => reason);
  expect(missingDirectory).toBeInstanceOf(IpcUnavailableError);
  expect((missingDirectory as IpcUnavailableError).operation).toBe('files.isDirectory');
  const missingNotices = await topNotices.list().catch((reason: unknown) => reason);
  const missingSkills = await skills.list({ workspacePath: null }).catch((reason: unknown) => reason);
  expect(isIpcUnavailableError(missingNotices)).toBe(true);
  expect((missingNotices as IpcUnavailableError).operation).toBe('topNotices.list');
  expect(isIpcUnavailableError(missingSkills)).toBe(true);
  expect((missingSkills as IpcUnavailableError).operation).toBe('skills.list');
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(await apiRequest({ method: 'GET', path: '/api/simple-interface/projects' }))
    .toMatchObject({ ok: false, status: 501 });
  expect(fetchSpy).not.toHaveBeenCalled();
  const local = await profiles.list();
  expect(local.defaultProfileId).toBe('browser-project_A');
  expect(local.profiles[0]).toMatchObject({ provider: 'local', modelId: 'local_model_A' });
  expect(fetchSpy).not.toHaveBeenCalled();
  await expect(profiles.create({})).rejects.toThrow('reference a local model');
  const unsubscribe = agentNotifications.onNotification(() => {});
  unsubscribe();
  expect(events).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  vi.unstubAllGlobals();
});

test('browser onboarding capabilities and namespaced state survive reload without HTTP', async () => {
  const { disableBrowserProjectNativeEvents, registerBrowserProjectLocalProfile,
    registerBrowserProjectHostCapabilities, restoreBrowserProjectNativeEvents,
    getHostCapabilities, onboardingState, userName, telemetry, uiSettings, profiles,
    providers } = await import('../ipc');
  localStorage.clear();
  disableBrowserProjectNativeEvents();
  registerBrowserProjectLocalProfile('setup_project', 'model_A', 'Active model');
  const request = vi.fn(async (method: string) => method === CLIENT_METHOD.interpreterProviderList
    ? { data: [{ id: 'local', name: 'Local', isCurrent: true, configured: true }] }
    : { data: [{ id: 'model_A', displayName: 'Active model', hidden: false, isDefault: true }] });
  registerBrowserProjectHostCapabilities(BROWSER_PROJECT_CAPABILITIES, undefined, request as any);
  expect(getHostCapabilities()).toEqual(BROWSER_PROJECT_CAPABILITIES);
  expect((await providers.listInterpreterProviders()).providers).toHaveLength(1);
  expect((await providers.listInterpreterModels('local')).models).toEqual([
    { id: 'model_A', name: 'Active model', isDefault: true },
  ]);
  const state = { ...(await onboardingState.get()).state, completed: true };
  await onboardingState.set(state);
  await userName.set('Browser user');
  await telemetry.set(false);
  await uiSettings.setAdvancedMode(false);
  const profile = { id: 'browser-profile', provider: 'local', modelId: 'model_A',
    name: 'Active model', isBuiltin: false } as const;
  await profiles.create(profile);
  await profiles.setDefault(profile.id);
  restoreBrowserProjectNativeEvents('setup_project');
  expect(getHostCapabilities()).toEqual(DESKTOP_HOST_CAPABILITIES);
  expect((await import('../ipc')).getBrowserProjectModelDownload()).toBeUndefined();
  disableBrowserProjectNativeEvents();
  registerBrowserProjectLocalProfile('setup_project', 'model_A', 'Active model');
  registerBrowserProjectHostCapabilities(BROWSER_PROJECT_CAPABILITIES);
  expect(shouldShowOnboarding((await onboardingState.get()).state)).toBe(false);
  const stale = { ...state, completed: false, completedStepIds: ['name'] };
  await onboardingState.set(stale);
  expect((await onboardingState.get()).state).toMatchObject({ completed: true,
    completedStepIds: ['name'] });
  expect((await userName.get()).userName).toBe('Browser user');
  expect((await profiles.list()).defaultProfileId).toBe(profile.id);
  expect((await profiles.list()).profiles.map(item => item.id)).toContain(profile.id);
  await expect(profiles.create({ ...profile, modelId: 'other', id: 'other' }))
    .resolves.toMatchObject({ success: true });
  await expect(profiles.create({ ...profile, provider: 'hosted', id: 'hosted' }))
    .rejects.toThrow('reference a local model');
  await expect(profiles.update(profile.id, { apiKey: 'unexpected' }))
    .rejects.toThrow('reference a local model');
  await expect(onboardingState.set({ ...state, interviewDraft: 'x'.repeat(256 * 1024) }))
    .rejects.toThrow('exceeds local storage limit');
  expect(shouldShowOnboarding((await onboardingState.get()).state)).toBe(false);
  restoreBrowserProjectNativeEvents('setup_project');
  disableBrowserProjectNativeEvents();
  registerBrowserProjectLocalProfile('setup_project', 'model_B', 'Changed model');
  expect((await profiles.list()).defaultProfileId).toBe(profile.id);
  expect((await profiles.list()).profiles.map(item => item.id)).toContain(profile.id);
  await expect(profiles.get(profile.id)).resolves.toMatchObject(profile);
  const newModelProfile = { ...profile, id: 'new-model-profile', modelId: 'model_B' };
  await profiles.create(newModelProfile);
  await profiles.setDefault(newModelProfile.id);
  expect((await profiles.list()).defaultProfileId).toBe(newModelProfile.id);
  restoreBrowserProjectNativeEvents('setup_project');
  localStorage.clear();
});

test('a blocked browser storage read uses onboarding defaults rather than starting a native request', async () => {
  const { disableBrowserProjectNativeEvents, registerBrowserProjectIdentity,
    restoreBrowserProjectNativeEvents, onboardingState } = await import('../ipc');
  disableBrowserProjectNativeEvents();
  registerBrowserProjectIdentity('blocked-store');
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Storage blocked', 'SecurityError');
  });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  try {
    const { state } = await onboardingState.get();
    expect(shouldShowOnboarding(state)).toBe(true);
    expect(state.completed).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('using default'),
      expect.any(DOMException));
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    logged.mockRestore();
    fetchSpy.mockRestore();
    restoreBrowserProjectNativeEvents('blocked-store');
  }
});

test('an earlier same-project activation cannot restore native IPC over a newer host', async () => {
  const { disableBrowserProjectNativeEvents, registerBrowserProjectIdentity,
    registerBrowserProjectHostCapabilities, restoreBrowserProjectNativeEvents,
    getHostCapabilities } = await import('../ipc');
  disableBrowserProjectNativeEvents();
  const previous = registerBrowserProjectIdentity('same-project');
  registerBrowserProjectHostCapabilities(BROWSER_PROJECT_CAPABILITIES);
  const current = registerBrowserProjectIdentity('same-project');
  registerBrowserProjectHostCapabilities(BROWSER_PROJECT_CAPABILITIES);
  restoreBrowserProjectNativeEvents('same-project', previous);
  expect(getHostCapabilities()).toEqual(BROWSER_PROJECT_CAPABILITIES);
  restoreBrowserProjectNativeEvents('same-project', current);
  expect(getHostCapabilities()).toEqual(DESKTOP_HOST_CAPABILITIES);
});

test('pre-session browser storage shares origin onboarding but isolates project profiles', async () => {
  const { disableBrowserProjectNativeEvents, registerBrowserProjectIdentity,
    restoreBrowserProjectNativeEvents, onboardingState, profiles, userName } = await import('../ipc');
  localStorage.clear();
  disableBrowserProjectNativeEvents();
  registerBrowserProjectIdentity('first');
  expect((await profiles.list()).profiles).toEqual([]);
  await userName.set('Browser user');
  await onboardingState.set({ ...(await onboardingState.get()).state, completed: true });
  const profile = { id: 'selected', name: 'Second model', modelId: 'model_two',
    provider: 'local', isBuiltin: false } as const;
  await profiles.create(profile);
  await profiles.setDefault(profile.id);
  restoreBrowserProjectNativeEvents('first');
  disableBrowserProjectNativeEvents();
  registerBrowserProjectIdentity('second');
  expect((await onboardingState.get()).state.completed).toBe(true);
  expect((await userName.get()).userName).toBe('Browser user');
  expect((await profiles.list()).profiles).toEqual([]);
  restoreBrowserProjectNativeEvents('second');
  disableBrowserProjectNativeEvents();
  registerBrowserProjectIdentity('first');
  expect((await profiles.list()).defaultProfileId).toBe('selected');
  expect((await profiles.get('selected')).modelId).toBe('model_two');
  localStorage.setItem('workstation:browser-project:origin:userName', '{not-json');
  expect((await userName.get()).userName).toBeNull();
  localStorage.setItem('workstation:browser-project:origin:onboardingState', '{}');
  expect((await onboardingState.get()).state.completed).toBe(false);
  localStorage.setItem('workstation:browser-project:origin:onboardingState', JSON.stringify({
    version: 1, completed: true, completedStepIds: [], interviewDraft: '',
    importedToolSummary: { generatedAt: null, sources: [], summary: '' },
  }));
  expect((await onboardingState.get()).state.completed).toBe(false);
  localStorage.setItem('workstation:browser-project:browser-first:profiles', '{}');
  expect((await profiles.list()).profiles).toEqual([]);
  localStorage.setItem('workstation:browser-project:browser-first:profiles',
    JSON.stringify([{ ...profile, apiKey: 'unexpected' }]));
  expect((await profiles.list()).profiles).toEqual([]);
  restoreBrowserProjectNativeEvents('first');
  localStorage.clear();
});
