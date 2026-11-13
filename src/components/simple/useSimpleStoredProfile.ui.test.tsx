import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Profile } from '../../../shared/types/profile';
import type { ProfilesResponse } from '../../api';

const api = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  setDefaultProfile: vi.fn(),
}));
const ipc = vi.hoisted(() => ({ onChanged: vi.fn(), supported: true }));

vi.mock('../../api', () => api);
vi.mock('../../ipc', () => ({ profiles: { get onChanged() { return ipc.supported ? ipc.onChanged : undefined; } } }));

import { useSimpleStoredProfile } from './useSimpleStoredProfile';

const first: Profile = { id: 'saved-first', name: 'First model', provider: 'api', modelId: 'first-model', isBuiltin: false, reasoningEffort: 'low' };
const second: Profile = { id: 'saved-second', name: 'Second model', provider: 'api', modelId: 'second-model', isBuiltin: false };
const terminal: Profile = { id: 'saved-terminal', name: 'Terminal model', provider: 'terminal', modelId: 'terminal-model', isBuiltin: false };

function response(profiles: Profile[], defaultProfileId: string | null): ProfilesResponse {
  return { profiles, defaultProfileId, fastProfileId: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useSimpleStoredProfile', () => {
  const subscribers = new Set<() => void>();
  beforeEach(() => {
    vi.resetAllMocks();
    subscribers.clear();
    ipc.supported = true;
    api.getProfiles.mockResolvedValue(response([first, second], first.id));
    api.setDefaultProfile.mockImplementation(async (profileId: string) => ({ success: true, defaultProfileId: profileId, fastProfileId: null }));
    ipc.onChanged.mockImplementation((callback: () => void) => {
      subscribers.add(callback);
      return () => { subscribers.delete(callback); };
    });
  });

  test('stays loading without a profile-less model while the stored profiles are delayed', async () => {
    const load = deferred<ProfilesResponse>();
    api.getProfiles.mockReturnValue(load.promise);
    const { result } = renderHook(() => useSimpleStoredProfile());
    expect(result.current.status).toBe('loading');
    expect(result.current.modelConfig).toBeNull();
    expect(result.current.profileId).toBeNull();
    await act(async () => { load.resolve(response([first], first.id)); });
    expect(result.current.status).toBe('ready');
    expect(result.current.modelConfig?.profileId).toBe(first.id);
  });

  test('selects the persisted non-terminal default and offers only stored non-terminal models', async () => {
    api.getProfiles.mockResolvedValue(response([terminal, first, second], second.id));
    const { result } = renderHook(() => useSimpleStoredProfile());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.profileId).toBe(second.id);
    expect(result.current.modelConfig?.profileId).toBe(second.id);
    expect(result.current.availableProfiles).toEqual([{ id: first.id, name: first.name, modelId: first.modelId }, { id: second.id, name: second.name, modelId: second.modelId }]);
    expect(await result.current.selectProfile(terminal.id)).toBe(false);
    expect(api.setDefaultProfile).not.toHaveBeenCalled();
  });

  test.each([null, 'deleted-default', terminal.id])('falls back to the first stored non-terminal profile for default %s', async (defaultId) => {
    api.getProfiles.mockResolvedValue(response([terminal, first, second], defaultId));
    const { result } = renderHook(() => useSimpleStoredProfile());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.profileId).toBe(first.id);
    expect(result.current.modelConfig?.profileId).toBe(first.id);
    expect(result.current.modelConfig?.reasoningEffort).toBe('low');
  });

  test('reports missing when only terminal profiles are stored', async () => {
    api.getProfiles.mockResolvedValue(response([terminal], terminal.id));
    const { result } = renderHook(() => useSimpleStoredProfile());
    await waitFor(() => expect(result.current.status).toBe('missing'));
    expect(result.current.modelConfig).toBeNull();
    expect(result.current.availableProfiles).toEqual([]);
  });

  test('reports a load error without exposing a guessed model', async () => {
    api.getProfiles.mockRejectedValue(new Error('Unusable stored profile response'));
    const { result } = renderHook(() => useSimpleStoredProfile());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.modelConfig).toBeNull();
    expect(result.current.profileId).toBeNull();
  });

  test('persists explicit selection before using its stored profile configuration', async () => {
    const save = deferred<{ success: boolean; defaultProfileId: string; fastProfileId: null }>();
    api.setDefaultProfile.mockReturnValue(save.promise);
    const { result } = renderHook(() => useSimpleStoredProfile());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let selection!: Promise<boolean>;
    act(() => { selection = result.current.selectProfile(second.id); });
    expect(result.current.profileId).toBe(first.id);
    expect(result.current.selecting).toBe(true);
    await act(async () => { save.resolve({ success: true, defaultProfileId: second.id, fastProfileId: null }); });
    expect(await selection).toBe(true);
    expect(api.setDefaultProfile).toHaveBeenCalledWith(second.id);
    expect(result.current.status).toBe('ready');
    expect(result.current.modelConfig?.profileId).toBe(second.id);
    expect(result.current.selecting).toBe(false);
  });

  test.each(['rejected', 'unsuccessful'])('retains the prior ready model when selection is %s', async (failure) => {
    if (failure === 'rejected') api.setDefaultProfile.mockRejectedValue(new Error('Save unavailable'));
    else api.setDefaultProfile.mockResolvedValue({ success: false, defaultProfileId: first.id, fastProfileId: null });
    const { result } = renderHook(() => useSimpleStoredProfile());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const prior = result.current.modelConfig;
    let saved!: boolean;
    await act(async () => { saved = await result.current.selectProfile(second.id); });
    expect(saved).toBe(false);
    expect(result.current.status).toBe('ready');
    expect(result.current.profileId).toBe(first.id);
    expect(result.current.modelConfig).toBe(prior);
    expect(result.current.selectionError).toBe('Could not save the selected model.');
  });

  test('refreshes on changes and ignores an earlier load finishing after a newer one', async () => {
    const earlier = deferred<ProfilesResponse>();
    api.getProfiles.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(response([second], second.id));
    const { result } = renderHook(() => useSimpleStoredProfile());
    await act(async () => { for (const notify of subscribers) notify(); });
    await waitFor(() => expect(result.current.profileId).toBe(second.id));
    await act(async () => { earlier.resolve(response([first], first.id)); });
    expect(result.current.profileId).toBe(second.id);
    expect(result.current.modelConfig?.profileId).toBe(second.id);
    expect(api.getProfiles).toHaveBeenCalledTimes(2);
  });

  test('unsubscribes and discards pending load after unmount', async () => {
    const load = deferred<ProfilesResponse>();
    api.getProfiles.mockReturnValue(load.promise);
    const { unmount } = renderHook(() => useSimpleStoredProfile());
    expect(subscribers.size).toBe(1);
    unmount();
    expect(subscribers.size).toBe(0);
    await act(async () => { load.resolve(response([first], first.id)); });
    expect(api.getProfiles).toHaveBeenCalledTimes(1);
  });

  test('loads stored profiles even when the changed subscription is unavailable', async () => {
    ipc.supported = false;
    const { result } = renderHook(() => useSimpleStoredProfile());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.modelConfig?.profileId).toBe(first.id);
    expect(ipc.onChanged).not.toHaveBeenCalled();
  });

  test('discards a pending profile selection after unmount', async () => {
    const save = deferred<{ success: boolean; defaultProfileId: string; fastProfileId: null }>();
    api.setDefaultProfile.mockReturnValue(save.promise);
    const { result, unmount } = renderHook(() => useSimpleStoredProfile());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let selection!: Promise<boolean>;
    act(() => { selection = result.current.selectProfile(second.id); });
    unmount();
    await act(async () => { save.resolve({ success: true, defaultProfileId: second.id, fastProfileId: null }); });
    expect(await selection).toBe(false);
  });
});
