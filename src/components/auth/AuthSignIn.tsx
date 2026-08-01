import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../utils/supabase/client';
import { AUTH_SIGN_IN_ID } from '../../../shared/element-ids';
import { Button } from '../ui/button';
import { FieldGroup, FieldDescription, FieldError } from '../ui/field';
import { openExternal, apiRequest, auth } from '@/ipc';
import { isMarketingDemoMode } from '../../demo/marketingDemo';
import {
  AUTH_URL_COPIED_MESSAGE,
  AUTH_URL_OPEN_FAILED_MESSAGE,
  openAuthUrl,
} from '../../utils/authUrl';

const PRIVACY_POLICY_URL = 'https://www.openinterpreter.com/legal/privacy';
const MARKETING_DEMO_AUTH_DISABLED_MESSAGE = 'Account sign-in is unavailable in this browser demo.';

// Type for session transfer API response
interface SessionTransferResponse {
  authenticated?: boolean;
  session?: {
    access_token: string;
    refresh_token: string;
  };
}

interface AuthSignInProps {
  onAuthSuccess?: () => void;
  variant?: 'default' | 'onboardingCompact';
}

const ONBOARDING_SIGN_IN_BUTTON_CLASS = 'w-full rounded-full border-black bg-black text-white hover:border-black hover:bg-black hover:text-white dark:border-white dark:bg-white dark:text-black dark:hover:border-white dark:hover:bg-white dark:hover:text-black';

export function AuthSignIn({ onAuthSuccess, variant = 'default' }: AuthSignInProps = {}) {
  "use no memo";

  const [authError, setAuthError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const marketingDemoMode = isMarketingDemoMode();

  // Refs for cleanup of OAuth polling
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  const handleAuthCallback = async (url: string) => {
    try {
      const urlObj = new URL(url);
      const hashParams = new URLSearchParams(urlObj.hash.substring(1));

      const access_token = hashParams.get('access_token');
      const refresh_token = hashParams.get('refresh_token');

      if (access_token && refresh_token) {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);

        const { error } = await supabase.auth.setSession({
          access_token,
          refresh_token,
        });

        if (error) {
          console.error('[Auth] Failed to set session:', error);
          setAuthError('Failed to complete authentication. Please try again.');
        } else {
          console.log('[Auth] Session set successfully via deep link');
          setAuthError(null);
          onAuthSuccess?.();
        }
        setIsLoading(false);
      }
    } catch (error) {
      console.error('[Auth] Error handling auth callback:', error);
      setAuthError('Failed to process authentication. Please try again.');
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const unsubscribe = auth.onDeepLink((event: { url: string }) => {
      console.log('[Auth] Received deep link:', event.url);
      handleAuthCallback(event.url);
    });
    return unsubscribe;
  }, []);

  const handleSignInWithGoogle = async () => {
    if (marketingDemoMode) {
      setAuthError(MARKETING_DEMO_AUTH_DISABLED_MESSAGE);
      setIsLoading(false);
      return;
    }

    try {
      setAuthError(null);
      setIsLoading(true);
      console.log('[Auth] Starting Google OAuth sign in...');

      const sessionId = crypto.randomUUID();

      // NOTE(victor): Use custom protocol for OAuth callback - works in production Electron
      // where window.location.origin is file:// or null. Falls back to HTTP callback in dev
      // since protocol handler isn't registered when running via pnpm dev.
      // @ts-expect-error - import.meta.env is provided by Vite
      const redirectTo = import.meta.env.DEV
        ? `${window.location.origin}/auth/complete?sessionId=${sessionId}`
        : 'workstation://auth/callback';

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });

      console.log('[Auth] OAuth response:', { data, error });

      if (error) {
        console.error('[Auth] Google sign-in error:', error);
        setAuthError(error.message ?? JSON.stringify(error));
        setIsLoading(false);
        return;
      }

      // Open URL in external browser via Electron
      if (data?.url) {
        console.log('[Auth] Opening OAuth URL in external browser:', data.url);

        const openResult = await openAuthUrl(data.url);
        if (openResult.status === 'failed') {
          console.error('[Auth] Failed to open or copy authentication URL:', openResult);
          setAuthError(AUTH_URL_OPEN_FAILED_MESSAGE);
          setIsLoading(false);
          return;
        }

        // Show polling message
        setAuthError(
          openResult.status === 'copied'
            ? AUTH_URL_COPIED_MESSAGE
            : 'Please complete authentication in your browser...',
        );

        // Clear any existing polling
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);

        // Start polling for the session
        pollIntervalRef.current = setInterval(async () => {
          try {
            const response = await apiRequest({
              method: 'GET',
              path: `/api/auth/transfer-session?sessionId=${sessionId}`,
            });

            const data = response.data as SessionTransferResponse;
            if (response.ok && data?.authenticated && data?.session) {
              if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
              if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
              setIsLoading(false);
              setAuthError(null);

              const sessionData = data.session;

              // Use Supabase's setSession to properly trigger auth state change
              // This updates React state without reloading the page
              const { error: setSessionError } = await supabase.auth.setSession({
                access_token: sessionData.access_token,
                refresh_token: sessionData.refresh_token,
              });

              if (setSessionError) {
                console.error('[Auth] Failed to set session:', setSessionError);
                setAuthError('Failed to complete authentication. Please try again.');
              } else {
                console.log('[Auth] Session set successfully, UI should update via onAuthStateChange');
                onAuthSuccess?.();
              }
            }
          } catch (error) {
            console.error('[Auth] Error polling for session:', error);
          }
        }, 2000); // Poll every 2 seconds

        // Stop polling after 5 minutes
        pollTimeoutRef.current = setTimeout(() => {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setAuthError('Authentication timed out. Please try again.');
          setIsLoading(false);
        }, 5 * 60 * 1000);
      }
    } catch (error: unknown) {
      const err = error as Error;
      console.error('[Auth] Google sign-in error:', err);
      setAuthError(err?.message ?? JSON.stringify(err));
      setIsLoading(false);
    }
  };

  if (marketingDemoMode) {
    if (variant === 'onboardingCompact') {
      return (
        <div data-testid={AUTH_SIGN_IN_ID} className="w-full">
          <p className="text-ui-xs text-center text-muted-foreground">
            {MARKETING_DEMO_AUTH_DISABLED_MESSAGE}
          </p>
        </div>
      );
    }

    return (
      <div data-testid={AUTH_SIGN_IN_ID}>
        <FieldGroup>
          <FieldDescription>{MARKETING_DEMO_AUTH_DISABLED_MESSAGE}</FieldDescription>
        </FieldGroup>
      </div>
    );
  }

  if (variant === 'onboardingCompact') {
    return (
      <div data-testid={AUTH_SIGN_IN_ID} className="w-full">
        <div className="space-y-2.5 text-center">
          <Button
            onClick={handleSignInWithGoogle}
            disabled={isLoading}
            variant="outline"
            size="sm"
            className={ONBOARDING_SIGN_IN_BUTTON_CLASS}
            style={{ borderWidth: 'var(--border-width)' }}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Sign in with Google
          </Button>
          <p className="py-1 text-[9px] leading-tight text-muted-foreground/60">
            By continuing, you agree to{' '}
            <button
              type="button"
              className="rounded-sm underline decoration-muted-foreground/40 underline-offset-2 transition-[color,decoration-color] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:text-foreground hover:decoration-foreground/70"
              onClick={() => void openExternal(PRIVACY_POLICY_URL)}
            >
              our policies
            </button>.
          </p>
        </div>

        {authError && (
          <p className={
            authError === 'Please complete authentication in your browser...'
              ? 'text-ui-xs text-center text-muted-foreground'
              : 'text-ui-xs text-center text-destructive'
          }
          >
            {authError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div data-testid={AUTH_SIGN_IN_ID}>
      <FieldGroup>
        <FieldDescription>Sign in to access hosted models</FieldDescription>

        {/* Google OAuth */}
        <Button
          onClick={handleSignInWithGoogle}
          disabled={isLoading}
          variant="outline"
          className="w-full"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Continue with Google
        </Button>

        {authError && (
          <FieldError>{authError}</FieldError>
        )}

        <FieldDescription>
          By continuing, you agree to our{' '}
          <a
            href={PRIVACY_POLICY_URL}
            onClick={async (e) => {
              e.preventDefault();
              await openExternal(PRIVACY_POLICY_URL);
            }}
          >
            privacy policy
          </a>
        </FieldDescription>
      </FieldGroup>
    </div>
  );
}
