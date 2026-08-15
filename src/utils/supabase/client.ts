import { createClient } from '@supabase/supabase-js';
import { distributionProductConfig, hasHostedAccountProvider } from '../../../shared/productConfig';

// =============================================================================
// NOTE(victor): OAUTH REDIRECT URLs - AUTH WILL BREAK IF THESE ARE NOT CONFIGURED
// =============================================================================
//
// Supabase supports custom URL schemes for native apps. The following URLs
// MUST be whitelisted in Supabase Dashboard > Authentication > URL Configuration
// > Redirect URLs:
//
//   1. http://localhost:5173/auth/complete   (DEV - Vite dev server)
//   2. workstation://auth/callback           (PROD - Electron custom protocol)
//
// If either URL is removed or changed in the dashboard, OAuth will fail with
// a redirect error. The code in AuthSignIn.tsx uses DEV URL when running via
// `pnpm dev` (protocol handler not registered) and PROD URL in packaged builds.
//
// =============================================================================

const authConfig = distributionProductConfig.auth;
export const HOSTED_AUTH_ENABLED = hasHostedAccountProvider();
// Supabase requires a syntactically valid URL even when the distribution has
// no hosted account provider. Keep the inert fallback on a safe closed
// loopback port; AuthProvider never initializes or refreshes a session in this
// mode.
const SUPABASE_URL = authConfig.url || 'http://127.0.0.1:65535';
const SUPABASE_ANON_KEY = authConfig.anonKey || 'hosted-auth-disabled';

// Custom storage key for auth token
export const AUTH_STORAGE_KEY = authConfig.storageKey;

// No-op lock for Electron - Navigator LockManager doesn't work properly in Electron
// and causes getSession/setSession to hang indefinitely
const noopLock = async <R>(
  _name: string,
  _acquireTimeout: number,
  fn: () => Promise<R>
): Promise<R> => {
  return fn();
};

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: HOSTED_AUTH_ENABLED,
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
      storageKey: AUTH_STORAGE_KEY,
      autoRefreshToken: HOSTED_AUTH_ENABLED,
      detectSessionInUrl: HOSTED_AUTH_ENABLED,
      lock: noopLock,
    }
  }
);
