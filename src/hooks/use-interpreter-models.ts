import { useCallback, useEffect, useRef, useState } from 'react';

import { providers as providersIpc } from '../ipc';
import type { SupportedOpenAIOAuthModel } from '../../shared/types/provider';
import type { v2 } from '../../server/handlers/codex-generated-types/index';

/**
 * use-interpreter-models.ts
 *
 * Shared hooks for fetching dynamic provider and model lists from the
 * Interpreter app-server. Both onboarding and settings consume these so the
 * lists shown to users always come from the runtime, never a hardcoded array.
 *
 * Mirrors the exact pattern and guarantees of use-hosted-model-catalog.ts:
 * - useState for data/loading/error
 * - requestId race guard to ignore stale async responses
 * - NO hardcoded fallback on failure; setData(null) + setError(message)
 * - expose refresh() for explicit retry
 */

export interface InterpreterProvidersState {
  data: v2.InterpreterProvider[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export interface InterpreterModelsState {
  data: SupportedOpenAIOAuthModel[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export interface InterpreterHarnessesState {
  data: v2.InterpreterHarness[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch the Interpreter provider list from the app-server.
 *
 * @param includeUnconfigured - if true, also list bundled quick-add presets so
 *   the user can browse providers before pasting a key.
 *
 * On failure the data stays null and `error` is set (no silent hardcoded
 * fallback); callers surface the error and offer retry via `refresh`.
 */
export function useInterpreterProviders(
  includeUnconfigured?: boolean,
): InterpreterProvidersState {
  const [data, setData] = useState<v2.InterpreterProvider[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const { providers } = await providersIpc.listInterpreterProviders(includeUnconfigured);
      if (requestId !== requestIdRef.current) return;
      setData(providers);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[interpreter-models] listInterpreterProviders failed: ${message}`);
      setData(null);
      setError(message);
    }

    if (requestId === requestIdRef.current) {
      setLoading(false);
    }
  }, [includeUnconfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: () => void load() };
}

/**
 * Fetch the Interpreter model list for a provider from the app-server.
 *
 * @param providerId - optional; if omitted, lists the active provider's models.
 * @param includeHidden - optional; if true, include hidden models.
 *
 * On failure the data stays null and `error` is set (no silent hardcoded
 * fallback); callers surface the error and offer retry via `refresh`.
 */
export function useInterpreterModels(
  providerId?: string,
  includeHidden?: boolean,
): InterpreterModelsState {
  const [data, setData] = useState<SupportedOpenAIOAuthModel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const { models } = await providersIpc.listInterpreterModels(providerId, includeHidden);
      if (requestId !== requestIdRef.current) return;
      setData(models);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[interpreter-models] listInterpreterModels(${providerId ?? 'active'}) failed: ${message}`);
      setData(null);
      setError(message);
    }

    if (requestId === requestIdRef.current) {
      setLoading(false);
    }
  }, [providerId, includeHidden]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: () => void load() };
}

/**
 * Fetch harnesses compatible with a concrete OIX provider/model pair. Passing
 * no provider keeps the hook idle for app-only providers such as Hosted and
 * terminal agents.
 */
export function useInterpreterHarnesses(
  providerId?: string,
  model?: string,
): InterpreterHarnessesState {
  const [data, setData] = useState<v2.InterpreterHarness[] | null>(null);
  const [loading, setLoading] = useState(Boolean(providerId));
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!providerId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const requestedModel = model?.trim() || undefined;
    try {
      const { harnesses } = await providersIpc.listInterpreterHarnesses(
        providerId,
        requestedModel,
      );
      if (requestId !== requestIdRef.current) return;
      setData(harnesses);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[interpreter-models] listInterpreterHarnesses(${providerId}) failed: ${message}`,
      );
      setData(null);
      setError(message);
    }

    if (requestId === requestIdRef.current) {
      setLoading(false);
    }
  }, [providerId, model]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: () => void load() };
}
