import { useEffect, useState } from 'react';
import { supabase } from '../../utils/supabase/client';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { isMarketingDemoMode } from '../../demo/marketingDemo';
import { getApiUrl } from '@/ipc';

/*
 * Why we don't auto-close this tab
 * ---------------------------------
 * This callback page runs in the user's system browser (Chrome, Firefox, Safari),
 * opened via Electron's shell.openExternal(). Browsers only allow window.close()
 * on tabs that were created by JavaScript (window.open()). A tab opened by the OS
 * via shell.openExternal() is NOT script-closable -- the browser treats it
 * identically to a tab the user opened manually.
 *
 * The previous implementation tried three workarounds:
 *   1. window.open('', '_self') -- patched/dead in Chrome since ~2022
 *   2. window.close() -- blocked by the spec (HTML "script-closable" check)
 *   3. location.assign('workstation://focus') -- navigates away, destroying
 *      the page context before close() could even run
 *
 * This is NOT a bug we can fix. It is a fundamental browser security boundary.
 * Every major Electron app handles it the same way:
 *
 *   - VS Code: shows "All done. You can close this tab now."
 *   - GitHub Desktop: shows "Sign-in successful, return to the app."
 *   - Slack: shows an "Open Slack" interstitial page
 *   - Discord: uses WebSocket + custom protocol, tab stays open
 *   - Figma: shows "Return to Figma" page
 *   - 1Password: custom protocol redirect, tab stays open
 *   - Firebase CLI: serves a static "login success" HTML page
 *   - Stripe CLI: uses remote confirm page (no callback tab at all)
 *   - gh CLI: uses device flow (no callback tab at all)
 *
 * Zero production desktop apps auto-close the system browser tab.
 * The correct pattern is: transfer the session, redirect focus to the app
 * via custom protocol, and show a "you can close this tab" message.
 *
 * In production builds, this page is never shown -- the OAuth redirect goes
 * directly to workstation://auth/callback, which the OS routes to the
 * Electron app without ever loading a browser tab.
 *
 * References:
 *   - MDN Window.close(): https://developer.mozilla.org/en-US/docs/Web/API/Window/close
 *   - RFC 8252 (OAuth 2.0 for Native Apps): https://www.rfc-editor.org/rfc/rfc8252.html
 *   - Chromium window.close() restrictions: https://issues.chromium.org/issues/41128226
 */

const WORKSTATION_FOCUS_URL = 'workstation://focus';

/**
 * AuthCallback handles the OAuth redirect from Supabase.
 * It uses Supabase's built-in URL hash detection to get the session
 * and posts it to the server for transfer back to the Electron app.
 *
 * This matches the implementation in old_workstation/agent-panel/app/auth/complete/page.tsx
 */
export function AuthCallback() {
  const [status, setStatus] = useState('Processing authentication...');
  const marketingDemoMode = isMarketingDemoMode();

  useEffect(() => {
    async function handleAuthComplete() {
      if (marketingDemoMode) {
        setStatus('Authentication is unavailable in this browser demo.');
        return;
      }

      try {
        // Get sessionId from URL params
        const urlParams = new URLSearchParams(window.location.search);
        const sessionId = urlParams.get('sessionId');

        if (!sessionId) {
          setStatus('Missing session ID. Please try signing in again.');
          return;
        }

        // The Supabase client will automatically detect and handle the session from the URL hash
        // due to detectSessionInUrl: true in the client configuration

        // Wait a bit for Supabase to process the hash
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Check if we have a session
        const { data: { session }, error } = await supabase.auth.getSession();

        if (error) {
          console.error('[AuthCallback] Error getting session:', error);
          setStatus('Authentication failed. Please try again.');
          return;
        }

        if (session) {
          console.log('[AuthCallback] Authentication successful! Transferring session...');
          setStatus('Authentication successful! Transferring to Interpreter...');

          // Send session data to the transfer endpoint
          const response = await fetch(await getApiUrl('/api/auth/transfer-session'), {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              sessionId,
              access_token: session.access_token,
              refresh_token: session.refresh_token,
              expires_at: session.expires_at,
              expires_in: session.expires_in,
              user: session.user,
            }),
          });

          if (response.ok) {
            setStatus('Authentication complete! You can close this tab and return to Interpreter.');
            try {
              window.location.href = WORKSTATION_FOCUS_URL;
            } catch {
              // Custom protocol navigation may fail in some browsers; harmless.
            }
          } else {
            setStatus('Failed to transfer session. Please try again.');
          }
        } else {
          console.error('[AuthCallback] No session found');
          setStatus('No session found. Please try signing in again.');
        }
      } catch (error) {
        console.error('[AuthCallback] Unexpected error:', error);
        setStatus('An unexpected error occurred. Please try again.');
      }
    }

    handleAuthComplete();
  }, [marketingDemoMode]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
      <Card className="max-w-md mx-4">
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-ui-base text-foreground">{status}</p>
        </CardContent>
      </Card>
    </div>
  );
}
