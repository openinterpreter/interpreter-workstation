import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, AUTH_STORAGE_KEY } from '../utils/supabase/client';
import { apiRequest } from '@/ipc';
import { trackSignIn, trackSignOut } from '@/utils/telemetry';
import { isMarketingDemoMode } from '../demo/marketingDemo';
import { useToast } from './ToastContext';
import { useTranslation } from 'react-i18next';
import { DISK_SPACE_FULL_WARNING, type DiskSpaceFullWarning, isDiskSpaceFullError } from '../../shared/diskSpace';

// Type for stored tokens API response
interface StoredTokensResponse {
  access_token?: string;
  refresh_token?: string;
}

interface AuthUpdateJwtResponse {
  success?: boolean;
  warning?: DiskSpaceFullWarning;
}

function getAuthUpdateJwtWarning(data: AuthUpdateJwtResponse | null): DiskSpaceFullWarning | undefined {
  return data?.warning;
}

type AuthContextType = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAuthenticated: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  isAuthenticated: false,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

// Module-level dedup for the `signed_in` telemetry event. Persists across
// AuthProvider remounts within a renderer process so a single real
// authentication produces exactly one telemetry row, even though Supabase
// auth-js + multi-window broadcast cause SIGNED_IN to be observed many times.
let lastTrackedSignInUserId: string | null = null;

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Check if a session is expired
 */
function isSessionExpired(session: Session | null): boolean {
  if (!session?.expires_at) return true;
  // expires_at is in seconds, Date.now() is in milliseconds
  // Add 60 second buffer to avoid edge cases
  const expiresAtMs = session.expires_at * 1000;
  const now = Date.now();
  const isExpired = expiresAtMs < now + 60000;
  if (isExpired) {
    console.log('[AUTH] Session expired:', {
      expiresAt: new Date(expiresAtMs).toISOString(),
      now: new Date(now).toISOString(),
    });
  }
  return isExpired;
}

/**
 * Clear all auth state (localStorage, config file, server cache)
 */
async function clearAllAuthState() {
  console.log('[AUTH] Clearing all auth state...');
  // Reset signed-in dedup immediately so any subsequent recovery or re-login
  // for the same user is counted even if Supabase never emits SIGNED_OUT.
  lastTrackedSignInUserId = null;
  try {
    // Clear server-side cache and config file
    await apiRequest({
      method: 'POST',
      path: '/api/auth/logout',
    });
  } catch (e) {
    console.warn('[AUTH] Failed to clear server auth state:', e);
  }
  // Sign out from Supabase (clears localStorage)
  const { error } = await supabase.auth.signOut().catch((e) => ({ error: e }));
  if (error) {
    // NOTE(victor): 403 occurs when token is already expired/invalid - clear local storage manually
    console.warn('[AUTH] clearAllAuthState signOut error:', error);
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
}

export function AuthProvider({ children }: AuthProviderProps) {
  "use no memo";

  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const marketingDemoMode = isMarketingDemoMode();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const lastDiskSpaceToastAtRef = useRef(0);

  const showDiskSpaceFullToast = useCallback(() => {
    const now = Date.now();
    if (now - lastDiskSpaceToastAtRef.current < 30_000) {
      return;
    }
    lastDiskSpaceToastAtRef.current = now;
    showToast(t('errors.diskSpaceFull'), 'error', 7000);
  }, [showToast, t]);

  useEffect(() => {
    if (marketingDemoMode) {
      setUser(null);
      setSession(null);
      setLoading(false);
      return;
    }

    const updateServerJwtCache = async (activeSession: Session): Promise<void> => {
      try {
        const response = await apiRequest({
          method: 'POST',
          path: '/api/auth/update-jwt',
          body: {
            access_token: activeSession.access_token,
            refresh_token: activeSession.refresh_token,
          },
        });
        const data = response.data as AuthUpdateJwtResponse | null;
        if (getAuthUpdateJwtWarning(data) === DISK_SPACE_FULL_WARNING) {
          showDiskSpaceFullToast();
        }
        console.log('[AUTH] Server JWT cache updated');
      } catch (error) {
        if (isDiskSpaceFullError(error)) {
          showDiskSpaceFullToast();
        }
        throw error;
      }
    };

    // ==========================================================================
    // Auth Initialization
    // ==========================================================================
    // Priority order:
    // 1. Supabase localStorage (primary - handles most cases)
    // 2. Config file bootstrap (fallback - for CI/tests/cross-instance sharing)
    //
    // The config file fallback allows:
    // - CI to pre-populate tokens before running tests
    // - Different Electron instances to share auth (main app vs test app)
    // ==========================================================================
    const initializeAuth = async () => {
      try {
        // Step 1: Check Supabase localStorage (primary auth source)
        let { data: { session: existingSession }, error } = await supabase.auth.getSession();
        console.log('[AUTH] Initial session check from localStorage:', {
          hasSession: !!existingSession,
          email: existingSession?.user?.email,
          expiresAt: existingSession?.expires_at ? new Date(existingSession.expires_at * 1000).toISOString() : null,
          error,
        });

        // Handle expired session from localStorage
        if (existingSession && isSessionExpired(existingSession)) {
          console.log('[AUTH] Session from localStorage is expired, attempting refresh...');
          const { data: { session: refreshedSession }, error: refreshError } = await supabase.auth.refreshSession();
          if (refreshedSession && !refreshError && !isSessionExpired(refreshedSession)) {
            console.log('[AUTH] Session refreshed successfully');
            existingSession = refreshedSession;
          } else {
            console.log('[AUTH] Failed to refresh session, clearing auth state');
            await clearAllAuthState();
            existingSession = null;
          }
        }

        // Step 2: If no localStorage session, try config file bootstrap
        // This is the fallback for CI/tests where localStorage may be empty
        if (!existingSession) {
          console.log('[AUTH] No localStorage session, checking config file for bootstrap...');
          try {
            const response = await apiRequest({
              method: 'GET',
              path: '/api/auth/stored-tokens',
            });

            const tokens = response.data as StoredTokensResponse;
            if (tokens?.access_token && tokens?.refresh_token) {
              console.log('[AUTH] Found tokens in config file, attempting to restore session...');
              const { data: { session: restoredSession }, error: restoreError } = await supabase.auth.setSession({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
              });

              if (restoredSession && !restoreError) {
                if (isSessionExpired(restoredSession)) {
                  console.log('[AUTH] Restored session is expired, attempting refresh...');
                  const { data: { session: refreshedSession }, error: refreshError } = await supabase.auth.refreshSession();
                  if (refreshedSession && !refreshError && !isSessionExpired(refreshedSession)) {
                    console.log('[AUTH] Restored session refreshed successfully');
                    existingSession = refreshedSession;
                  } else {
                    console.log('[AUTH] Failed to refresh restored session');
                    await clearAllAuthState();
                  }
                } else {
                  console.log('[AUTH] Session restored from config file:', restoredSession.user?.email);
                  existingSession = restoredSession;
                }
              } else {
                console.warn('[AUTH] Failed to restore session from config:', restoreError);
              }
            } else {
              console.log('[AUTH] No tokens in config file');
            }
          } catch (configError) {
            console.warn('[AUTH] Error fetching stored tokens:', configError);
          }
        }

        // Step 3: Apply the session (if we have one)
        if (existingSession && !isSessionExpired(existingSession)) {
          setSession(existingSession);
          setUser(existingSession.user);

          // Update server JWT cache (and config file via write-through)
          try {
            await updateServerJwtCache(existingSession);
          } catch (e) {
            console.warn('[AUTH] Failed to update server JWT cache:', e);
          }
        } else if (existingSession) {
          console.log('[AUTH] Session exists but is expired, ensuring logged out state');
          await clearAllAuthState();
        }
        setLoading(false);
      } catch (error) {
        console.error('[AUTH] Error initializing auth:', error);
        setLoading(false);
      }
    };

    initializeAuth();

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[AUTH] Auth state changed:', event, '- session -', session?.user?.email,
        '- expires:', session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : null);

      if (event === 'SIGNED_IN') {
        // Supabase auth-js emits SIGNED_IN every time the client recovers a
        // session from localStorage (every renderer init), every setSession()
        // (OAuth flow calls it twice), and every BroadcastChannel
        // re-emission from another window. Combined with multi-window
        // Electron sharing the WORKSTATION_PARTITION, a single auth event
        // would fire 11+ trackSignIn() calls in 24% of sessions. Dedup
        // against the last-reported user id so the analytics signal reflects
        // actual sign-ins.
        const userId = session?.user?.id ?? null;
        if (userId && userId !== lastTrackedSignInUserId) {
          lastTrackedSignInUserId = userId;
          trackSignIn();
        }
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        // Check if the session is expired
        if (session && isSessionExpired(session)) {
          console.log('[AUTH] Received expired session in auth state change, clearing...');
          await clearAllAuthState();
          setSession(null);
          setUser(null);
          setLoading(false);
          return;
        }

        setSession(session);
        setUser(session?.user ?? null);

        // Update server-side JWT cache when auth state changes
        if (session?.access_token) {
          try {
            await updateServerJwtCache(session);
          } catch (error) {
            console.error('[AUTH] Failed to update server JWT cache:', error);
          }
        }
      } else if (event === 'SIGNED_OUT') {
        setSession(null);
        setUser(null);
        // Reset signed_in dedup so a re-signin (even as the same user)
        // produces a fresh `signed_in` telemetry row.
        lastTrackedSignInUserId = null;
      }

      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [marketingDemoMode, showDiskSpaceFullToast]);

  const signOut = async () => {
    if (marketingDemoMode) {
      setSession(null);
      setUser(null);
      setLoading(false);
      return;
    }

    trackSignOut();
    // Reset immediately so the next successful sign-in by the same user
    // produces telemetry even if the SIGNED_OUT event never arrives.
    lastTrackedSignInUserId = null;
    // Clear server-side JWT cache first
    try {
      await apiRequest({
        method: 'POST',
        path: '/api/auth/logout',
      });
    } catch (error) {
      // Log but continue - Supabase is the authoritative auth source
      // Server cache will be cleared on next startup anyway
      console.error('[AUTH] Failed to clear server cache:', error);
    }

    const { error } = await supabase.auth.signOut().catch((e) => ({ error: e }));
    if (error) {
      // NOTE(victor): 403 occurs when token is already expired/invalid - clear local storage manually
      console.warn('[AUTH] signOut error (session likely already invalid):', error);
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
    // Always clear state regardless of signOut success/failure
    setSession(null);
    setUser(null);
  };

  const isAuthenticated = !!session && !!user;

  return (
    <AuthContext.Provider value={{ user, session, loading, isAuthenticated, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
