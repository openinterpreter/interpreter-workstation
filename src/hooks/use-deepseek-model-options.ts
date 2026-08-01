import { useCallback, useEffect, useRef, useState } from 'react';

import { providers as providersIpc } from '../ipc';
import type { ApiProviderModelOption } from '../utils/apiProviderModelOptions';

const DEEPSEEK_PROVIDER_ID = 'deepseek';
const FETCH_DEBOUNCE_MS = 400;

export interface DeepSeekModelOptionsState {
  options: ApiProviderModelOption[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Resolve the DeepSeek model dropdown options.
 *
 * The model list always comes from the Interpreter app-server: the bundled
 * `deepseek` catalog when no key is present, refined by an authenticated
 * GET /models once the user pastes a key. There is no hardcoded fallback — on
 * failure `options` is empty and `error` is set so the caller can surface it and
 * retry via `refresh`. Shared so Settings and onboarding reuse the same behavior.
 */
export function useDeepSeekModelOptions(
  apiKey: string,
  enabled: boolean,
): DeepSeekModelOptionsState {
  const [options, setOptions] = useState<ApiProviderModelOption[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) {
      requestIdRef.current += 1;
      setOptions([]);
      setLoading(false);
      setError(null);
      return;
    }

    const trimmedKey = apiKey.trim();
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    // Select the request outside the try so the try body holds a single straight
    // await: babel-plugin-react-compiler cannot yet lower a conditional value
    // block (ternary) inside a try/catch.
    const modelsRequest = trimmedKey
      ? providersIpc.listDeepSeekModels(trimmedKey)
      : providersIpc.listInterpreterModels(DEEPSEEK_PROVIDER_ID);
    try {
      const { models } = await modelsRequest;
      if (requestId !== requestIdRef.current) return;
      setOptions(models.map((model) => ({ id: model.id, name: model.name })));
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[deepseek-models] list failed: ${message}`);
      setOptions([]);
      setError(message);
    }

    if (requestId === requestIdRef.current) {
      setLoading(false);
    }
  }, [apiKey, enabled]);

  useEffect(() => {
    if (!enabled) {
      void load();
      return;
    }
    const timer = setTimeout(() => {
      void load();
    }, FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, load]);

  return { options, loading, error, refresh: () => void load() };
}
