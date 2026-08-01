import { useEffect, useRef, useState } from 'react';
import { searchWorkspaceContent, type WorkspaceContentMatch } from '../api';

export interface ContentSearchState {
  matches: WorkspaceContentMatch[];
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 180;
const MIN_QUERY_LENGTH = 2;

/**
 * Debounced full-text content search across the current workspace via ripgrep.
 * Returns `{ matches, loading, error }`. Empty query or queries shorter than
 * MIN_QUERY_LENGTH yield an empty result without calling the server.
 */
export function useContentSearch(query: string, limit = 50): ContentSearchState {
  const [state, setState] = useState<ContentSearchState>({ matches: [], loading: false, error: null });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setState({ matches: [], loading: false, error: null });
      return;
    }

    const id = ++requestIdRef.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const timer = setTimeout(async () => {
      try {
        const response = await searchWorkspaceContent(trimmed, limit);
        if (requestIdRef.current !== id) return;
        setState({ matches: response.matches, loading: false, error: null });
      } catch (error) {
        if (requestIdRef.current !== id) return;
        setState({ matches: [], loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, limit]);

  return state;
}
