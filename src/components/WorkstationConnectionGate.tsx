import { FormEvent, useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import type { WorkstationConnectionDescriptor } from '../../shared/types/workstationConnection';
import {
  getBrowserWorkstationConnection,
  isPublicWorkstationPublication,
  isRemoteWorkstationHost,
  resolveWorkstationApiUrl,
} from '../remote/workstationConnection';

function isDescriptor(value: unknown): value is WorkstationConnectionDescriptor {
  if (!value || typeof value !== 'object') return false;
  const descriptor = value as Partial<WorkstationConnectionDescriptor>;
  return descriptor.schemaVersion === 1
    && (descriptor.host === 'local' || descriptor.host === 'remote')
    && (descriptor.access === 'read-only' || descriptor.access === 'read-write')
    && typeof descriptor.authentication === 'object'
    && descriptor.authentication !== null
    && (descriptor.authentication.method === 'none' || descriptor.authentication.method === 'password')
    && typeof descriptor.authentication.required === 'boolean'
    && typeof descriptor.authentication.authenticated === 'boolean';
}

type GateState =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'login'; error?: string }
  | { kind: 'error'; message: string };

export function WorkstationConnectionGate({ children }: { children: React.ReactNode }) {
  const connection = getBrowserWorkstationConnection();
  const requiresHandshake = isRemoteWorkstationHost() && !isPublicWorkstationPublication();
  const [state, setState] = useState<GateState>(() => (
    requiresHandshake ? { kind: 'checking' } : { kind: 'ready' }
  ));
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const checkConnection = useCallback(async () => {
    if (!requiresHandshake) {
      setState({ kind: 'ready' });
      return;
    }
    try {
      const response = await fetch(resolveWorkstationApiUrl('/api/workstation-connection'), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Connection check failed (${response.status})`);
      const payload: unknown = await response.json();
      if (!isDescriptor(payload)) throw new Error('The Workstation host returned an invalid connection descriptor.');
      if (payload.host !== 'remote') throw new Error('The endpoint is not configured as a remote Workstation host.');
      if (payload.access !== connection.access) {
        throw new Error(`The browser requests ${connection.access} access, but the host is configured for ${payload.access}.`);
      }
      if (payload.authentication.method !== connection.authentication) {
        throw new Error(
          `The browser requests ${connection.authentication} authentication, but the host is configured for ${payload.authentication.method}.`,
        );
      }
      setState(payload.authentication.required && !payload.authentication.authenticated
        ? { kind: 'login' }
        : { kind: 'ready' });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not connect to Workstation.',
      });
    }
  }, [connection.access, connection.authentication, requiresHandshake]);

  useEffect(() => {
    document.documentElement.dataset.workstationAccess = connection.access;
    document.documentElement.dataset.workstationHost = connection.host;
    void checkConnection();
  }, [checkConnection, connection.access, connection.host]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setState({ kind: 'login' });
    try {
      const response = await fetch(resolveWorkstationApiUrl('/api/workstation-connection/session'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Sign in failed (${response.status})`);
      }
      setPassword('');
      await checkConnection();
    } catch (error) {
      setState({
        kind: 'login',
        error: error instanceof Error ? error.message : 'Could not sign in.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === 'ready') return children;

  if (state.kind === 'checking') {
    return (
      <main className="flex h-dvh items-center justify-center bg-background text-foreground" aria-busy="true">
        <div className="flex items-center gap-2 text-ui-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Connecting to Workstation
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-dvh items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-sm rounded-xl bg-[var(--oa-bg-subtle)] p-6" style={{ border: 'var(--border-width) solid var(--border)' }}>
        <div className="mb-5 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
          <KeyRound className="size-4" />
        </div>
        <h1 className="text-balance text-ui-base font-medium">
          {state.kind === 'login' ? 'Open this Workstation' : 'Workstation is unavailable'}
        </h1>
        <p className="mt-2 text-pretty text-ui-sm leading-5 text-muted-foreground">
          {state.kind === 'login'
            ? 'Enter the password for the computer this workspace is connected to.'
            : state.message}
        </p>

        {state.kind === 'login' ? (
          <form className="mt-5 space-y-3" onSubmit={(event) => void submit(event)}>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value="Workstation"
              readOnly
              hidden
            />
            <div>
              <label htmlFor="workstation-password" className="mb-1.5 block text-ui-sm font-medium">
                Password
              </label>
              <input
                id="workstation-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={state.error ? 'workstation-password-help workstation-login-error' : 'workstation-password-help'}
                aria-invalid={state.error ? true : undefined}
                autoFocus
                className="h-10 w-full rounded-lg bg-[var(--oa-bg-input)] px-3 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
                style={{ border: 'var(--border-width) solid var(--border)' }}
              />
              <p id="workstation-password-help" className="sr-only">
                Enter the host password to enable the Open Workstation button.
              </p>
            </div>
            {state.error ? (
              <p id="workstation-login-error" className="text-pretty text-ui-sm text-destructive" role="alert">
                {state.error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={!password || submitting}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-ui-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            >
              {submitting ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {submitting ? 'Opening' : 'Open Workstation'}
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setState({ kind: 'checking' });
              void checkConnection();
            }}
            className="mt-5 h-10 rounded-lg bg-primary px-4 text-ui-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary"
          >
            Try again
          </button>
        )}
      </section>
    </main>
  );
}
