import { useState, useEffect } from 'react';
import type { ProfileSetupStatus } from '../../shared/types/profile';
import { profiles, providers } from '@/ipc';
import { useAuth } from '../contexts/AuthContext';
import { isMarketingDemoMode } from '../demo/marketingDemo';

let cachedStatuses: Record<string, ProfileSetupStatus> = {};
let cachedAuthState: boolean | null = null;
let cacheReady = false;
let cacheLoading = false;
let inflightRefresh: Promise<void> | null = null;

const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(isAuthenticated: boolean) {
  const hasMatchingCache = cachedAuthState === isAuthenticated;
  return {
    statuses: hasMatchingCache ? cachedStatuses : {},
    loading: hasMatchingCache ? cacheLoading || !cacheReady : true,
  };
}

async function refreshProfileStatuses(
  isAuthenticated: boolean,
  options?: { force?: boolean; background?: boolean },
) {
  const authChanged = cachedAuthState !== isAuthenticated;
  const shouldReuse = !options?.force && !authChanged && (cacheReady || cacheLoading);

  if (shouldReuse) {
    return inflightRefresh ?? Promise.resolve();
  }

  if (authChanged) {
    cachedStatuses = {};
    cacheReady = false;
  }

  cachedAuthState = isAuthenticated;

  if (!options?.background || !cacheReady) {
    cacheLoading = true;
    emitChange();
  }

  const request = providers
    .getAllProfileStatuses(isAuthenticated)
    .then((result) => {
      cachedStatuses = result;
      cacheReady = true;
    })
    .catch((err) => {
      console.error('[useProfileStatuses] Failed to fetch statuses:', err);
      cacheReady = true;
    })
    .finally(() => {
      cacheLoading = false;
      inflightRefresh = null;
      emitChange();
    });

  inflightRefresh = request;
  return request;
}

export function useProfileStatuses() {
  const isDemoMode = isMarketingDemoMode();
  const { isAuthenticated } = useAuth();
  const [state, setState] = useState(() => getSnapshot(isAuthenticated));

  useEffect(() => {
    if (isDemoMode) {
      return;
    }

    const syncState = () => {
      setState(getSnapshot(isAuthenticated));
    };

    const hasMatchingCache = cacheReady && cachedAuthState === isAuthenticated;
    const unsubscribeCache = subscribe(syncState);
    const unsubscribeProfiles = profiles.onChanged(() => {
      void refreshProfileStatuses(isAuthenticated, {
        force: true,
        background: cacheReady && cachedAuthState === isAuthenticated,
      });
    });

    syncState();
    void refreshProfileStatuses(isAuthenticated, {
      force: true,
      background: hasMatchingCache,
    });

    return () => {
      unsubscribeCache();
      unsubscribeProfiles();
    };
  }, [isAuthenticated, isDemoMode]);

  if (isDemoMode) {
    return {
      statuses: {
        'demo-smart': {
          profileId: 'demo-smart',
          ready: true,
          detail: 'Available in the browser demo.',
          badge: 'Ready',
        } satisfies ProfileSetupStatus,
      },
      loading: false,
    };
  }

  return state;
}
