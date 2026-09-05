/**
 * EmailView Component
 *
 * Displays email content for an email tab.
 * Fetches the full email via the Nylas API.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Paperclip, Download, Reply, Forward, Loader2, AlertCircle, AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';
import { showItemInFolder } from '@/ipc';
import { canUseHostNativeFileManager } from '../remote/workstationConnection';
import { callTool } from '@/api';
import { buildUntrustedEmailDocument, emailContainsRemoteAssets } from '../utils/untrustedHtml';
import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';

interface EmailViewProps {
  tabId: string;  // Reserved for future use (e.g., updating tab label)
  emailId: string;
}

interface EmailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
}

interface EmailData {
  id: string;
  subject: string;
  from: { email: string; name?: string }[];
  to: { email: string; name?: string }[];
  cc?: { email: string; name?: string }[];
  date: string;
  body: string;
  snippet: string;
  unread: boolean;
  starred: boolean;
  attachments?: EmailAttachment[];
}

export function EmailView({ tabId: _tabId, emailId }: EmailViewProps) {
  "use no memo";

  const { t } = useTranslation();
  const [email, setEmail] = useState<EmailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allowRemoteAssets, setAllowRemoteAssets] = useState(false);

  const fetchEmail = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const result = await callTool('builtin-nylas', 'nylas_read_message', { message_id: emailId });

      if (result.isError) {
        throw new Error(result.content?.[0]?.text || 'Failed to fetch email');
      }

      if (result.content?.[0]?.text) {
        const parsed = JSON.parse(result.content[0].text);
        setEmail(parsed);
        setAllowRemoteAssets(false);
      }
    } catch (err: any) {
      console.error('[EmailView] Failed to fetch email:', err);
      setError(err.message || 'Failed to load email');
    } finally {
      setLoading(false);
    }
  }, [emailId]);

  useEffect(() => {
    fetchEmail();
  }, [fetchEmail]);

  const handleDownloadAttachment = async (attachment: EmailAttachment) => {
    try {
      const result = await callTool('builtin-nylas', 'nylas_download_attachment', {
        message_id: emailId,
        attachment_id: attachment.id,
        filename: attachment.filename,
      });

      if (result.content?.[0]?.text) {
        const parsed = JSON.parse(result.content[0].text);
        if (parsed.saved_to && canUseHostNativeFileManager()) {
          // Open the file in finder/explorer
          showItemInFolder(parsed.saved_to);
        }
      }
    } catch (err: any) {
      console.error('[EmailView] Failed to download attachment:', err);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatParticipant = (participant: { email: string; name?: string }) => {
    if (participant.name) {
      return `${participant.name} <${participant.email}>`;
    }
    return participant.email;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const contentWidthClass = 'mx-auto w-full max-w-4xl';
  const hasRemoteAssets = useMemo(() => email ? emailContainsRemoteAssets(email.body) : false, [email]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6">
        <Loader2 className="size-8 animate-spin text-[var(--oa-text-faint)]" />
        <p className="mt-3 text-ui-sm text-[var(--oa-text-muted)]">{t('email.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6">
        <div className="flex size-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--destructive)_9%,transparent)] text-destructive">
          <AlertCircle className="size-6" />
        </div>
        <p className="mt-4 text-ui-base font-medium text-[var(--oa-text-strong)]">{t('email.loadErrorTitle')}</p>
        <p className="mt-2 max-w-md text-center text-ui-sm leading-6 text-[var(--oa-text-muted)]">{error}</p>
        <Button
          onClick={fetchEmail}
          variant="secondary"
          size="sm"
          className="mt-5 rounded-full"
        >
          {t('common.tryAgain')}
        </Button>
      </div>
    );
  }

  if (!email) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6">
        <Mail className="size-10 text-[var(--oa-text-faint)]" />
        <p className="mt-4 text-ui-sm text-[var(--oa-text-muted)]">{t('email.notFound')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <div
        className="shrink-0 px-6 py-5"
        style={{ borderBottom: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 72%, transparent)' }}
      >
        <div className={contentWidthClass}>
          <div className="flex items-start gap-3">
            <div
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full"
              style={{
                background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 74%, transparent)',
                border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 72%, transparent)',
              }}
            >
              <Mail className="size-4 text-[var(--oa-text-muted)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-ui-xs uppercase tracking-[0.08em] text-[var(--oa-text-faint)]">{t('email.header')}</p>
              <h1 className="mt-1 text-[1.45rem] font-medium leading-8 text-[var(--oa-text-strong)]">
                {email.subject || t('email.noSubject')}
              </h1>
            </div>
            <div className="hidden shrink-0 text-right text-ui-xs text-[var(--oa-text-faint)] sm:block">
              {formatDate(email.date)}
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
            <div className="min-w-0 space-y-3">
              <div>
                <div className="text-ui-xs uppercase tracking-[0.08em] text-[var(--oa-text-faint)]">{t('email.from')}</div>
                <div className="mt-1 text-ui-sm font-medium text-[var(--oa-text-strong)]">
                  {email.from?.[0]?.name || email.from?.[0]?.email || t('email.unknownSender')}
                </div>
                {email.from?.[0]?.email && (
                  <div className="mt-0.5 truncate text-ui-sm text-[var(--oa-text-muted)]">
                    {email.from[0].email}
                  </div>
                )}
              </div>

              <div>
                <div className="text-ui-xs uppercase tracking-[0.08em] text-[var(--oa-text-faint)]">{t('email.to')}</div>
                <div className="mt-1 text-ui-sm leading-6 text-[var(--oa-text-muted)]">
                  {email.to?.map(formatParticipant).join(', ')}
                </div>
              </div>

              {email.cc && email.cc.length > 0 && (
                <div>
                  <div className="text-ui-xs uppercase tracking-[0.08em] text-[var(--oa-text-faint)]">{t('email.cc')}</div>
                  <div className="mt-1 text-ui-sm leading-6 text-[var(--oa-text-muted)]">
                    {email.cc.map(formatParticipant).join(', ')}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full"
                data-help-title={t('help.email.reply.title')}
                data-help-description={t('help.email.reply.description')}
              >
                <Reply className="size-4" />
                {t('email.reply')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full"
                data-help-title={t('help.email.forward.title')}
                data-help-description={t('help.email.forward.description')}
              >
                <Forward className="size-4" />
                {t('email.forward')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {hasRemoteAssets && (
          <div
            className={`${contentWidthClass} mb-4 flex items-start justify-between gap-4 rounded-2xl px-4 py-3`}
            style={{
              border: 'var(--border-width) solid color-mix(in srgb, #f59e0b 35%, var(--oa-border, var(--border)))',
              background: 'color-mix(in srgb, #f59e0b 10%, transparent)',
            }}
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,#f59e0b_16%,transparent)] text-amber-700">
                <AlertTriangle className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-ui-sm font-medium text-[var(--oa-text-strong)]">
                  {allowRemoteAssets ? 'Remote content enabled for this email.' : 'This email contains remote content.'}
                </p>
                <p className="mt-1 text-ui-sm text-[var(--oa-text-muted)]">
                  {allowRemoteAssets
                    ? 'Only enable remote content when you trust the sender. Loading it can reveal that you opened the email.'
                    : 'Remote images are blocked by default. Loading them can reveal that you opened the email, so only do it if you trust the sender.'}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant={allowRemoteAssets ? 'outline' : 'secondary'}
              size="sm"
              className="shrink-0 rounded-full"
              onClick={() => setAllowRemoteAssets(value => !value)}
            >
              {allowRemoteAssets ? 'Block remote images' : 'Load remote images'}
            </Button>
          </div>
        )}

        <div className={`${contentWidthClass} h-full min-h-[24rem] overflow-hidden rounded-2xl border border-[color:var(--oa-border,var(--border))] bg-white`}>
          <SandboxedHtmlFrame
            title={email.subject || t('email.noSubject')}
            srcDoc={buildUntrustedEmailDocument(email.body, { allowRemoteAssets })}
            className="h-full"
          />
        </div>
      </div>

      {email.attachments && email.attachments.length > 0 && (
        <div
          className="shrink-0 px-6 py-4"
          style={{ borderTop: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 72%, transparent)' }}
        >
          <div className={`${contentWidthClass} space-y-3`}>
            <div className="flex items-center gap-2 text-ui-sm text-[var(--oa-text-muted)]">
              <Paperclip className="size-4" />
              <span>
                {email.attachments.length}{' '}
                {email.attachments.length === 1 ? t('email.attachment') : t('email.attachments')}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {email.attachments.map((attachment) => (
                <Button
                  key={attachment.id}
                  onClick={() => handleDownloadAttachment(attachment)}
                  variant="secondary"
                  size="sm"
                  className="gap-2 rounded-full"
                  data-help-title={t('help.email.downloadAttachment.title')}
                  data-help-description={t('help.email.downloadAttachment.description', { filename: attachment.filename })}
                >
                  <Download className="size-4" />
                  <span className="max-w-[220px] truncate">{attachment.filename}</span>
                  <span className="text-[var(--oa-text-faint)]">({formatFileSize(attachment.size)})</span>
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
