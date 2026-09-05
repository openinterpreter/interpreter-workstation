import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Phone, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { getAppServerOrigin, isBrowserDevMode } from '@/ipc';
import type { ChannelStatus } from '../../../shared/types/messaging';
import { InboxSetupWhatsApp } from '../InboxSetupWhatsApp';
import { SettingsPane, SettingsSection } from './SettingsSection';

const WHATSAPP_CHANNEL = 'whatsapp' as const;
export function InboxSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSetup, setExpandedSetup] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const getBaseUrl = useCallback(async () => {
    if (isBrowserDevMode()) return '';
    return getAppServerOrigin();
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const baseUrl = await getBaseUrl();
      const response = await fetch(`${baseUrl}/api/inbox/status`, { credentials: 'include' });
      const data = await response.json();
      setChannels(data.channels || []);
    } catch (err: any) {
      console.error('[InboxSection] Failed to fetch status:', err);
      setError(err.message || 'Failed to load channel status');
    } finally {
      setLoading(false);
    }
  }, [getBaseUrl]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleDisconnect = async () => {
    try {
      setDisconnecting(true);
      setError(null);
      const baseUrl = await getBaseUrl();
      const response = await fetch(`${baseUrl}/api/servers/whatsapp/disconnect`, { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error('Failed to disconnect WhatsApp');
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDisconnecting(false);
    }
  };

  const handleConnect = () => {
    setExpandedSetup(prev => !prev);
  };

  const handleSetupComplete = () => {
    setExpandedSetup(false);
    fetchStatus();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-ui-sm text-muted-foreground">{t('settings.inbox.loadingAccounts')}</span>
      </div>
    );
  }

  const status = channels.find(c => c.channel === WHATSAPP_CHANNEL);
  const isConnected = status?.configured ?? false;
  const dividerStyle = {
    borderTop:
      'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)',
  };

  return (
    <SettingsPane>
      <SettingsSection title={t('settings.inbox.channelsSection')}>
        <div className="py-[18px]">
          {error && (
            <div
              className="mb-4 rounded-[14px] px-3 py-2.5 text-ui-sm text-destructive"
              style={{
                background: 'color-mix(in srgb, var(--destructive) 5%, transparent)',
                border: 'var(--border-width) solid color-mix(in srgb, var(--destructive) 18%, transparent)',
              }}
            >
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-[10px] bg-black/[0.04] dark:bg-white/[0.06]">
                <Phone className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-ui-sm font-medium text-foreground">
                    {t('settings.inbox.whatsapp')}
                  </span>
                  <span
                    className={`size-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                  />
                </div>
                <div className="mt-0.5 truncate text-ui-sm text-muted-foreground">
                  {isConnected && status?.label
                    ? status.label
                    : 'Scan a QR code to connect this channel.'}
                </div>
              </div>
            </div>
            <div>
              {isConnected ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="text-ui-sm text-muted-foreground"
                >
                  {disconnecting ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : null}
                  {t('settings.inbox.signOut')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleConnect}
                  className="text-ui-sm"
                >
                  {t('common.connect')}
                </Button>
              )}
            </div>
          </div>

          {expandedSetup && (
            <div className="mt-4 pt-4" style={dividerStyle}>
              <div
                className="overflow-hidden rounded-[18px]"
                style={{
                  border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 58%, transparent)',
                  background:
                    'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 20%, transparent)',
                }}
              >
                <InboxSetupWhatsApp
                  onConnected={handleSetupComplete}
                  onCancel={() => setExpandedSetup(false)}
                />
              </div>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.inbox.helpSection')}>
        <div className="space-y-5 py-[18px]">
          <div className="space-y-2">
            {isConnected ? (
              <>
                <p className="text-ui-sm font-medium text-foreground">
                  {t('settings.inbox.whatsappConnected.title')}
                </p>
                <p className="text-ui-sm text-muted-foreground">
                  {t('settings.inbox.whatsappConnected.description')}
                </p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-ui-sm text-muted-foreground">
                  <li>{t('settings.inbox.whatsappConnected.step1')}</li>
                  <li>{t('settings.inbox.whatsappConnected.step2')}</li>
                  <li>{t('settings.inbox.whatsappConnected.step3')}</li>
                  <li>{t('settings.inbox.whatsappConnected.step4')}</li>
                </ol>
              </>
            ) : (
              <>
                <p className="text-ui-sm font-medium text-foreground">
                  {t('settings.inbox.whatsappDisconnected.title')}
                </p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-ui-sm text-muted-foreground">
                  <li>{t('settings.inbox.whatsappDisconnected.step1')}</li>
                  <li>{t('settings.inbox.whatsappDisconnected.step2')}</li>
                  <li>{t('settings.inbox.whatsappDisconnected.step3')}</li>
                  <li>{t('settings.inbox.whatsappDisconnected.step4')}</li>
                </ol>
              </>
            )}
          </div>

          <div className="space-y-1.5 pt-4" style={dividerStyle}>
            <p className="text-ui-sm text-foreground">{t('settings.inbox.moreComingSoon.title')}</p>
            <p className="text-ui-sm text-muted-foreground">
              {t('settings.inbox.moreComingSoon.description')}
            </p>
          </div>
        </div>
      </SettingsSection>
    </SettingsPane>
  );
}
