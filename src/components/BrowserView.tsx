/**
 * BrowserView Component
 *
 * Displays browser content for a browser tab using Electron's WebContentsView.
 * Includes address bar with navigation controls.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, RotateCw, X, Globe } from 'lucide-react';
import { useLayoutActions } from '../hooks/useLayout';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { browser as browserIpc, getWindowId } from '@/ipc';
import { BROWSER_VIEW_CONTAINER_ID } from '../../shared/element-ids';
import { clearNativeDropTargetBounds, setNativeDropTargetBounds } from '../utils/nativeDropTargets';

interface BrowserViewProps {
  tabId: string;
  initialUrl: string;
  browserId?: string;
  faviconUrl?: string;
  isVisible?: boolean;
}

interface BrowserState {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export function BrowserView({ tabId, initialUrl, browserId, faviconUrl, isVisible = true }: BrowserViewProps) {
  "use no memo";

  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const visibilityEffectVersionRef = useRef(0);
  const [addressValue, setAddressValue] = useState(initialUrl);
  const [browserState, setBrowserState] = useState<BrowserState>({
    url: initialUrl,
    title: 'Loading...',
    isLoading: true,
    canGoBack: false,
    canGoForward: false,
  });
  const { updateBrowserTabLabel } = useLayoutActions();

  const updateBounds = useCallback(() => {
    if (!containerRef.current || !isVisible) return;

    const rect = containerRef.current.getBoundingClientRect();
    setNativeDropTargetBounds(tabId, rect);

    browserIpc.setBounds(tabId, {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, [tabId, isVisible]);

  useEffect(() => {
    browserIpc.create(tabId, initialUrl, browserId, faviconUrl);

    return () => {
      browserIpc.detach(tabId);
      clearNativeDropTargetBounds(tabId);
    };
  }, [tabId, initialUrl, browserId, faviconUrl]);

  useEffect(() => {
    visibilityEffectVersionRef.current += 1;
    const effectVersion = visibilityEffectVersionRef.current;

    if (!isVisible) {
      browserIpc.detach(tabId);
      clearNativeDropTargetBounds(tabId);
      return;
    }

    let isCancelled = false;
    const timeoutId = setTimeout(async () => {
      try {
        const windowId = await getWindowId();
        if (isCancelled || visibilityEffectVersionRef.current !== effectVersion) return;
        await browserIpc.attach(tabId, windowId);
        if (isCancelled || visibilityEffectVersionRef.current !== effectVersion) {
          browserIpc.detach(tabId);
          clearNativeDropTargetBounds(tabId);
          return;
        }
        updateBounds();
      } catch (err) {
        console.error('[BrowserView] Failed to attach:', err);
      }
    }, 100);

    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
    };
  }, [tabId, isVisible, updateBounds]);

  useEffect(() => {
    const unsubscribe = browserIpc.onEvent((event: any) => {
      if (event.id !== tabId) return;

      switch (event.type) {
        case 'url-changed':
          setBrowserState((prev) => ({ ...prev, url: event.data.url }));
          setAddressValue(event.data.url);
          break;
        case 'title-changed':
          setBrowserState((prev) => ({ ...prev, title: event.data.title }));
          updateBrowserTabLabel(tabId, event.data.title);
          break;
        case 'loading-changed':
          setBrowserState((prev) => ({ ...prev, isLoading: event.data.isLoading }));
          break;
        case 'navigation-state-changed':
          setBrowserState((prev) => ({
            ...prev,
            canGoBack: event.data.canGoBack,
            canGoForward: event.data.canGoForward,
          }));
          break;
      }
    });

    return unsubscribe;
  }, [tabId, updateBrowserTabLabel]);

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      updateBounds();
    });

    resizeObserver.observe(containerRef.current);
    if (isVisible) {
      updateBounds();
    } else {
      clearNativeDropTargetBounds(tabId);
    }

    return () => {
      resizeObserver.disconnect();
      clearNativeDropTargetBounds(tabId);
    };
  }, [updateBounds, tabId, isVisible]);

  const handleNavigate = useCallback((url: string) => {
    let finalUrl = url.trim();
    if (!finalUrl) return;

    if (finalUrl.startsWith('http://') || finalUrl.startsWith('https://')) {
      // Already a full URL
    } else if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
      finalUrl = `https://${finalUrl}`;
    } else {
      finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
    }

    browserIpc.navigate(tabId, finalUrl);
    setAddressValue(finalUrl);
  }, [tabId]);

  const handleAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleNavigate(addressValue);
    }
  };

  const handleGoBack = () => {
    browserIpc.goBack(tabId);
  };

  const handleGoForward = () => {
    browserIpc.goForward(tabId);
  };

  const handleReload = () => {
    if (browserState.isLoading) {
      browserIpc.stop(tabId);
    } else {
      browserIpc.reload(tabId);
    }
  };

  return (
    <div className="flex h-full flex-col bg-transparent">
      {/* Address Bar */}
      <div
        className="flex items-center gap-2 px-2 py-1.5 bg-transparent"
        style={{ borderBottom: 'var(--border-width) solid color-mix(in oklch, var(--oa-border, var(--border)) 72%, transparent)' }}
      >
        {/* Navigation Buttons */}
        <Button
          onClick={handleGoBack}
          disabled={!browserState.canGoBack}
          variant="ghost"
          size="icon-sm"
          title={t('help.browser.back.title')}
          data-help-title={t('help.browser.back.title')}
          data-help-description={t('help.browser.back.description')}
        >
          <ArrowLeft />
        </Button>
        <Button
          onClick={handleGoForward}
          disabled={!browserState.canGoForward}
          variant="ghost"
          size="icon-sm"
          title={t('help.browser.forward.title')}
          data-help-title={t('help.browser.forward.title')}
          data-help-description={t('help.browser.forward.description')}
        >
          <ArrowRight />
        </Button>
        <Button
          onClick={handleReload}
          variant="ghost"
          size="icon-sm"
          title={browserState.isLoading ? t('help.browser.stop.title') : t('help.browser.reload.title')}
          data-help-title={browserState.isLoading ? t('help.browser.stop.title') : t('help.browser.reload.title')}
          data-help-description={browserState.isLoading ? t('help.browser.stop.description') : t('help.browser.reload.description')}
        >
          {browserState.isLoading ? <X /> : <RotateCw />}
        </Button>

        {/* Address Input */}
        <div className="flex-1 flex items-center gap-2">
          <Globe className="size-4 text-muted-foreground flex-shrink-0 ml-3" />
          <Input
            type="text"
            value={addressValue}
            onChange={(e) => setAddressValue(e.target.value)}
            onKeyDown={handleAddressKeyDown}
            className="flex-1"
            placeholder={t('help.browser.address.placeholder')}
            data-help-title={t('help.browser.address.title')}
            data-help-description={t('help.browser.address.description')}
          />
        </div>
      </div>

      {/* Browser Content Container */}
      <div
        ref={containerRef}
        data-testid={BROWSER_VIEW_CONTAINER_ID}
        className="flex-1 relative"
        style={{ minHeight: 0 }}
      >
        {/* WebContentsView will be positioned here by the main process */}
        {browserState.isLoading && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: 'color-mix(in oklch, var(--oa-surface-center) 40%, transparent)' }}
          >
            <div className="animate-spin size-6 border-2 border-muted-foreground border-t-foreground rounded-full" />
          </div>
        )}
      </div>
    </div>
  );
}
