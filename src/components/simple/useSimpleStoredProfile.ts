import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentModelConfig } from '../../../shared/types/model';
import { profileToModelConfig, type Profile } from '../../../shared/types/profile';
import { getProfiles, setDefaultProfile } from '../../api';
import { profiles as profilesIpc } from '@/ipc';

export interface SimpleStoredProfileOption {
  id: string;
  name: string;
  modelId: string;
}

type ProfileState =
  | { status: 'loading' | 'missing' | 'error'; profileId: null; modelConfig: null; availableProfiles: SimpleStoredProfileOption[] }
  | { status: 'ready'; profileId: string; modelConfig: AgentModelConfig; availableProfiles: SimpleStoredProfileOption[] };

export type SimpleStoredProfile = ProfileState & {
  selecting: boolean;
  selectionError: string | null;
  selectProfile: (profileId: string) => Promise<boolean>;
  refresh: () => void;
};

const INITIAL_STATE: ProfileState = {
  status: 'loading',
  profileId: null,
  modelConfig: null,
  availableProfiles: [],
};

/** Only a saved, non-terminal profile may configure the Simple conversation. */
export function useSimpleStoredProfile(): SimpleStoredProfile {
  const [state, setState] = useState<ProfileState>(INITIAL_STATE);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const live = useRef(false);
  const generation = useRef(0);
  const storedProfiles = useRef<Profile[]>([]);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    live.current = true;

    const refresh = () => {
      const request = ++generation.current;
      storedProfiles.current = [];
      setSelecting(false);
      setSelectionError(null);
      setState(INITIAL_STATE);

      void getProfiles().then(({ profiles, defaultProfileId }) => {
        if (!live.current || generation.current !== request) return;
        const eligible = profiles.filter((profile) => profile.provider !== 'terminal');
        storedProfiles.current = eligible;
        const availableProfiles = eligible.map(({ id, name, modelId }) => ({ id, name, modelId }));
        const selected = eligible.find((profile) => profile.id === defaultProfileId) ?? eligible[0];
        setState(selected
          ? { status: 'ready', profileId: selected.id, modelConfig: profileToModelConfig(selected, { reasoningEffort: selected.reasoningEffort }), availableProfiles }
          : { status: 'missing', profileId: null, modelConfig: null, availableProfiles });
      }).catch(() => {
        if (!live.current || generation.current !== request) return;
        storedProfiles.current = [];
        setState({ status: 'error', profileId: null, modelConfig: null, availableProfiles: [] });
      });
    };

    refreshRef.current = refresh;
    const unsubscribe = typeof profilesIpc.onChanged === 'function'
      ? profilesIpc.onChanged(refresh)
      : undefined;
    const unsubscribeDefault = profilesIpc.onDefaultChanged?.(refresh);
    refresh();
    return () => {
      live.current = false;
      ++generation.current;
      storedProfiles.current = [];
      refreshRef.current = () => {};
      unsubscribe?.();
      unsubscribeDefault?.();
    };
  }, []);

  const selectProfile = useCallback(async (profileId: string): Promise<boolean> => {
    const selected = storedProfiles.current.find((profile) => profile.id === profileId);
    if (!live.current || !selected || selecting) return false;

    const request = ++generation.current;
    setSelecting(true);
    setSelectionError(null);
    try {
      const result = await setDefaultProfile(profileId);
      if (!live.current) return false;
      if (generation.current !== request) return result.success && result.defaultProfileId === profileId;
      if (!result.success || result.defaultProfileId !== profileId) {
        setSelectionError('Could not save the selected model.');
        return false;
      }
      setState({
        status: 'ready',
        profileId: selected.id,
        modelConfig: profileToModelConfig(selected, { reasoningEffort: selected.reasoningEffort }),
        availableProfiles: storedProfiles.current.map(({ id, name, modelId }) => ({ id, name, modelId })),
      });
      return true;
    } catch {
      if (live.current && generation.current === request) {
        setSelectionError('Could not save the selected model.');
      }
      return false;
    } finally {
      if (live.current && generation.current === request) setSelecting(false);
    }
  }, [selecting]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...state, selecting, selectionError, selectProfile, refresh };
}
