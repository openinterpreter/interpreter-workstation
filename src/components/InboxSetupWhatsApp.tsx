/**
 * InboxSetupWhatsApp Component
 *
 * Inline sidebar component for WhatsApp QR code setup.
 * Opens SSE to /api/servers/whatsapp/setup/qr-stream.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, X, Phone } from 'lucide-react';
import { Button } from './ui/button';
import { getAppServerOrigin, isBrowserDevMode } from '@/ipc';
import {
  trackInboxSetupCancelled,
  trackInboxSetupCompleted,
  trackInboxSetupFailed,
} from '../utils/telemetry';

interface InboxSetupWhatsAppProps {
  onConnected: () => void;
  onCancel: () => void;
}

export function InboxSetupWhatsApp({ onConnected, onCancel }: InboxSetupWhatsAppProps) {
  "use no memo";

  const [qrCode, setQrCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const eventSourceRef = useRef<EventSource | null>(null);
  const qrTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedRef = useRef(false);

  const clearQrTimeout = useCallback(() => {
    if (qrTimeoutRef.current) {
      clearTimeout(qrTimeoutRef.current);
      qrTimeoutRef.current = null;
    }
  }, []);

  const closeEventSource = useCallback(() => {
    clearQrTimeout();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, [clearQrTimeout]);

  const startSetup = useCallback(async () => {
    try {
      closeEventSource();
      setError(null);
      setQrCode(null);
      setConnecting(true);

      const baseUrl = isBrowserDevMode()
        ? ''
        : await getAppServerOrigin();

      // Start the socket initialization
      const response = await fetch(`${baseUrl}/api/servers/whatsapp/setup`, { method: 'POST' });
      if (!response.ok) {
        let message = 'Failed to initialize WhatsApp setup.';
        try {
          const payload = await response.json();
          if (typeof payload?.error === 'string' && payload.error.trim().length > 0) {
            message = payload.error;
          }
        } catch {
          // Ignore malformed JSON error response.
        }
        throw new Error(message);
      }

      // Open SSE stream for QR codes
      const evtSource = new EventSource(`${baseUrl}/api/servers/whatsapp/setup/qr-stream`);
      eventSourceRef.current = evtSource;
      qrTimeoutRef.current = setTimeout(() => {
        setConnecting(false);
        const message = 'Unable to get a WhatsApp QR code. Check internet/proxy/firewall and try again.';
        setError(message);
        trackInboxSetupFailed({
          channel: 'whatsapp',
          error: message,
          stage: 'qr_timeout',
        });
      }, 30000);

      evtSource.addEventListener('connecting', () => {
        setConnecting(true);
      });

      evtSource.addEventListener('qr', (event) => {
        try {
          const data = JSON.parse(event.data);
          clearQrTimeout();
          setError(null);
          setQrCode(data.qrCode);
          setConnecting(false);
        } catch (err) {
          console.error('[WhatsApp Setup] Failed to parse QR event:', err);
        }
      });

      evtSource.addEventListener('disconnected', (event) => {
        clearQrTimeout();
        setQrCode(null);
        setConnecting(false);
        try {
          const data = JSON.parse(event.data);
          const message = typeof data?.message === 'string' ? data.message : null;
          const nextError = message || 'WhatsApp connection failed. Please try again.';
          setError(nextError);
          trackInboxSetupFailed({
            channel: 'whatsapp',
            error: nextError,
            stage: 'disconnected',
          });
        } catch {
          const nextError = 'WhatsApp connection failed. Please try again.';
          setError(nextError);
          trackInboxSetupFailed({
            channel: 'whatsapp',
            error: nextError,
            stage: 'disconnected',
          });
        }
      });

      evtSource.addEventListener('connected', () => {
        completedRef.current = true;
        closeEventSource();
        trackInboxSetupCompleted({ channel: 'whatsapp' });
        onConnected();
      });

      evtSource.addEventListener('logged_out', () => {
        closeEventSource();
        const message = 'Session was logged out. Please try again.';
        setError(message);
        setQrCode(null);
        setConnecting(false);
        trackInboxSetupFailed({
          channel: 'whatsapp',
          error: message,
          stage: 'logged_out',
        });
      });

      evtSource.onerror = () => {
        // SSE reconnects automatically, but if it persists we show an error
        setTimeout(() => {
          if (evtSource.readyState === EventSource.CLOSED) {
            const message = 'Connection lost. Please try again.';
            setError(message);
            setConnecting(false);
            trackInboxSetupFailed({
              channel: 'whatsapp',
              error: message,
              stage: 'sse_closed',
            });
          }
        }, 5000);
      };

      // Clean up on unmount
      return () => {
        closeEventSource();
      };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setConnecting(false);
      trackInboxSetupFailed({
        channel: 'whatsapp',
        error: message,
        stage: 'setup_start',
      });
    }
  }, [clearQrTimeout, closeEventSource, onConnected]);

  useEffect(() => {
    void startSetup();
    return () => {
      closeEventSource();
    };
  }, [startSetup, closeEventSource]);

  const dividerStyle = {
    borderColor:
      'color-mix(in srgb, var(--oa-border, var(--border)) 56%, transparent)',
  };

  const panelStyle = {
    border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 60%, transparent)',
    backgroundColor:
      'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 36%, transparent)',
  };

  return (
    <div className="flex h-full flex-col overflow-auto px-3 py-3 text-[var(--oa-text)]">
      <div
        className="flex items-start justify-between gap-4 px-1 pb-4"
        style={{ borderBottom: 'var(--border-width) solid', ...dividerStyle }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-[10px] bg-black/[0.04] dark:bg-white/[0.06]">
              <Phone className="size-4 text-[var(--oa-text-muted)]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-ui-base font-medium">Connect WhatsApp</h2>
              <p className="mt-1 text-ui-sm text-[var(--oa-text-muted)]">
                Scan a QR code from your phone to bring your chats into Inbox.
              </p>
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            if (!completedRef.current) {
              trackInboxSetupCancelled({ channel: 'whatsapp' });
            }
            onCancel();
          }}
          className="text-[var(--oa-text-muted)]"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-1 py-4">
        {error && (
          <div
            className="rounded-[14px] px-3 py-2.5 text-ui-sm text-destructive"
            style={{
              background: 'color-mix(in srgb, var(--destructive) 5%, transparent)',
              border:
                'var(--border-width) solid color-mix(in srgb, var(--destructive) 18%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        <div
          className="flex flex-col items-center gap-4 rounded-[18px] px-4 py-5 text-center"
          style={panelStyle}
        >
        {connecting && !qrCode && (
            <>
              <Loader2 className="mb-1 size-7 animate-spin text-[var(--oa-text-muted)]" />
              <div className="space-y-1">
                <p className="text-ui-base font-medium text-[var(--oa-text)]">
                  Generating QR code
                </p>
                <p className="text-ui-sm text-[var(--oa-text-muted)]">
                  Keep this view open while we establish the WhatsApp session.
                </p>
              </div>
            </>
        )}

        {qrCode && (
            <>
              <div
                className="rounded-[16px] bg-white p-3"
                style={{
                  border:
                    'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 60%, transparent)',
                }}
              >
                <img
                  src={qrCode}
                  alt="WhatsApp QR Code"
                  className="h-[192px] w-[192px] rounded-[12px]"
                />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-ui-base font-medium text-[var(--oa-text)]">
                  Scan with WhatsApp
                </h3>
                <p className="mx-auto max-w-[260px] text-ui-sm text-[var(--oa-text-muted)]">
                  Open WhatsApp on your phone, go to Settings {'>'} Linked Devices {'>'} Link a Device, and scan this QR code.
                </p>
              </div>
            </>
        )}
        </div>

        <div
          className="space-y-2 pt-4"
          style={{ borderTop: 'var(--border-width) solid', ...dividerStyle }}
        >
          <p className="text-ui-sm font-medium text-[var(--oa-text)]">After it connects</p>
          <ol className="space-y-1 pl-4 text-ui-sm text-[var(--oa-text-muted)]">
            <li>The setup view will close automatically.</li>
            <li>Send yourself a message to create your WhatsApp thread in Inbox.</li>
            <li>If the QR code expires, refresh and scan the newest one.</li>
          </ol>
        </div>
      </div>

      <div
        className="mt-auto flex items-center justify-between gap-3 px-1 pt-3"
        style={{ borderTop: 'var(--border-width) solid', ...dividerStyle }}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (!completedRef.current) {
              trackInboxSetupCancelled({ channel: 'whatsapp' });
            }
            onCancel();
          }}
          className="text-[var(--oa-text-muted)]"
        >
          Cancel
        </Button>
        {error ? (
          <Button variant="secondary" size="sm" onClick={() => void startSetup()}>
            Try again
          </Button>
        ) : (
          <span className="text-ui-xs text-[var(--oa-text-muted)]">
            Updates automatically
          </span>
        )}
      </div>
    </div>
  );
}
