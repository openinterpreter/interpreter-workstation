import { useEffect, useRef, useState } from 'react';

import { vault } from '@/ipc';
import type { VaultSearchResult } from '../../shared/types/vault';

export interface VaultSearchState {
  matches: VaultSearchResult[];
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 120;
const MIN_QUERY_LENGTH = 1;

export function useVaultSearch(query: string, limit = 20): VaultSearchState {
  const [state, setState] = useState<VaultSearchState>({ matches: [], loading: false, error: null });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setState({ matches: [], loading: false, error: null });
      return;
    }

    const id = ++requestIdRef.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const timer = window.setTimeout(async () => {
      try {
        const response = await vault.searchNotes({ query: trimmed, limit });
        if (requestIdRef.current !== id) {
          return;
        }
        setState({ matches: response.results, loading: false, error: null });
      } catch (error) {
        if (requestIdRef.current !== id) {
          return;
        }
        setState({ matches: [], loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [limit, query]);

  return state;
}
