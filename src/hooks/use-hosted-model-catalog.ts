import { useCallback, useEffect, useRef, useState } from 'react';

import { providers as providersIpc } from '../ipc';
import type { OpenRouterModelCatalogResult } from '../../shared/types/provider';
import { interpreterModelsToOpenRouterModels } from '../utils/hostedOpenRouterPicker';

// The hosted picker browses OpenRouter slug models. The runtime is the source of
// truth via `interpreter/model/list` for the `openrouter` provider, which lists
// the bundled OpenRouter catalog without a key or network call.
const HOSTED_OPENROUTER_PROVIDER_ID = 'openrouter';

export interface HostedModelCatalogState {
  catalog: OpenRouterModelCatalogResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch the hosted OpenRouter model catalog from the Interpreter runtime.
 *
 * Replaces the baked-in `GENERATED_OPENROUTER_CATALOG` snapshot so the picker
 * reflects whatever the bundled runtime can serve. On failure the catalog stays
 * null and `error` is set (no silent hardcoded fallback); callers surface the
 * error and offer retry via `refresh`.
 */
export function useHostedModelCatalog(): HostedModelCatalogState {
  const [catalog, setCatalog] = useState<OpenRouterModelCatalogResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const { models } = await providersIpc.listInterpreterModels(HOSTED_OPENROUTER_PROVIDER_ID);
      if (requestId !== requestIdRef.current) return;
      setCatalog({
        models: interpreterModelsToOpenRouterModels(models),
        fetchedAt: Date.now(),
        stale: false,
      });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[hosted-catalog] listInterpreterModels(openrouter) failed: ${message}`);
      setCatalog(null);
      setError(message);
    }

    if (requestId === requestIdRef.current) {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { catalog, loading, error, refresh: () => void load() };
}
