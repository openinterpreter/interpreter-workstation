/**
 * Query parameter that carries a short-lived Simple preview ticket. The
 * preview origin exchanges it for its own cookie and redirects to the same URL
 * without it.
 */
export const SIMPLE_PREVIEW_TICKET_PARAM = 'interpreter_preview_ticket';

/** The preview URL without its ticket, so a renewed ticket is not a new target. */
export function simplePreviewTarget(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete(SIMPLE_PREVIEW_TICKET_PARAM);
    return parsed.toString();
  } catch {
    return url;
  }
}
