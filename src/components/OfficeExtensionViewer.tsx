import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { OFFICE_EXTENSION_VIEWER_ID } from '../../shared/element-ids';
import { clearNativeDropTargetBounds, setNativeDropTargetBounds } from '../utils/nativeDropTargets';
import { getRuntimeSystemInfo, pathBasename, theme as themeIpc } from '@/ipc';
import { buildOfficeExtensionOpenUrl } from '@/lib/officeExtensionUrl';
import { mapOfficeExtensionSelectionMessage } from '@/lib/officeExtensionSelection';
import { useFileRefresh } from '../hooks/useFileRefresh';
import type { ThemeChangedEvent } from '../../electron/ipc/registry';
import { isOfficeExtensionSupportedPlatform } from '../../shared/constants/interpreter-overlay-platform';
import { OfficeReadOnlyViewer } from './OfficeReadOnlyViewer';

interface OfficeExtensionViewerProps {
  filePath: string;
  refreshKey?: number;
}

interface IframeState {
  key: string;
  url: string;
}

type ViewerState =
  | { status: 'checking' }
  | { status: 'unsupported-platform' }
  | { status: 'not-installed' }
  | { status: 'downloading'; bytesDownloaded: number; totalBytes: number }
  | { status: 'extracting' }
  | { status: 'configuring' }
  | { status: 'starting-server' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

const OO_EDITORS_PORT = 38123;
const OO_EDITORS_ORIGIN = `http://localhost:${OO_EDITORS_PORT}`;

function resolveOfficeEditorTheme(
  theme: 'light' | 'dark' | 'system',
  prefersDark: boolean,
): 'light' | 'dark' {
  if (theme === 'system') {
    return prefersDark ? 'dark' : 'light';
  }

  return theme;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function OfficeExtensionViewer({ filePath, refreshKey = 0 }: OfficeExtensionViewerProps) {
  "use no memo";

  const [viewerState, setViewerState] = useState<ViewerState>({ status: 'checking' });
  const [installationCheckKey, setInstallationCheckKey] = useState(0);
  const [reloadRevision, setReloadRevision] = useState(0);

  const [activeIframe, setActiveIframe] = useState<IframeState | null>(null);
  const [appTheme, setAppTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');
  const [themeLoaded, setThemeLoaded] = useState(false);

  const activeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { i18n } = useTranslation();

  const buildUrl = useCallback((path: string, bustCache = false) => {
    return buildOfficeExtensionOpenUrl({
      port: OO_EDITORS_PORT,
      filePath: path,
      language: i18n.language,
      theme: resolvedTheme,
      bustCache,
    });
  }, [i18n.language, resolvedTheme]);

  const waitForServerReady = useCallback(async () => {
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      try {
        const response = await fetch(`http://localhost:${OO_EDITORS_PORT}/healthcheck`);
        if (response.ok) {
          const text = await response.text();
          if (text.includes('true')) {
            return;
          }
        }
      } catch {
        // Server not ready yet.
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    throw new Error('Server failed to become ready');
  }, []);

  const startOfficeViewer = useCallback(async (cancelledRef?: { current: boolean }) => {
    if (!window.electron?.officeExtension?.ensureRunning) {
      throw new Error('OfficeExtension IPC not available');
    }

    setViewerState({ status: 'starting-server' });

    const result = await window.electron.officeExtension.ensureRunning();
    if (cancelledRef?.current) {
      return;
    }

    if (!result.success) {
      throw new Error(result.error || 'Failed to start server');
    }

    await waitForServerReady();
    if (cancelledRef?.current) {
      return;
    }

    setViewerState({ status: 'ready' });
  }, [waitForServerReady]);

  useEffect(() => {
    let cancelled = false;

    const loadTheme = async () => {
      try {
        const response = await themeIpc.get();
        if (!cancelled) {
          setAppTheme(response.theme);
        }
      } catch (error) {
        console.error('[OfficeExtensionViewer] Failed to load theme:', error);
      }

      if (!cancelled) {
        setThemeLoaded(true);
      }
    };

    void loadTheme();

    const unsubscribe = themeIpc.onChanged((event: ThemeChangedEvent) => {
      if (cancelled) return;
      setAppTheme(event.theme);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const applyResolvedTheme = () => {
      setResolvedTheme(resolveOfficeEditorTheme(appTheme, mediaQuery.matches));
    };

    applyResolvedTheme();

    if (appTheme !== 'system') {
      return;
    }

    mediaQuery.addEventListener('change', applyResolvedTheme);
    return () => mediaQuery.removeEventListener('change', applyResolvedTheme);
  }, [appTheme]);

  useEffect(() => {
    const cancelledRef = { current: false };

    const checkInstallation = async () => {
      const platform = getRuntimeSystemInfo().platform;
      if (!isOfficeExtensionSupportedPlatform(platform)) {
        setViewerState({ status: 'unsupported-platform' });
        return;
      }

      if (!window.electron?.officeExtension?.checkInstalled) {
        setViewerState({ status: 'error', message: 'OfficeExtension IPC not available' });
        return;
      }

      try {
        const result = await window.electron.officeExtension.checkInstalled();
        if (cancelledRef.current) {
          return;
        }

        if (!result.installed) {
          setViewerState({ status: 'not-installed' });
          return;
        }

        await startOfficeViewer(cancelledRef);
      } catch (error: any) {
        if (!cancelledRef.current) {
          setViewerState({ status: 'error', message: error.message || 'Failed to load Office extension' });
        }
      }
    };

    void checkInstallation();

    return () => {
      cancelledRef.current = true;
    };
  }, [installationCheckKey, startOfficeViewer]);

  useEffect(() => {
    if (!window.electron?.officeExtension?.onInstallProgress) return;

    const unsubscribe = window.electron.officeExtension.onInstallProgress((event) => {
      switch (event.stage) {
        case 'downloading':
          setViewerState({
            status: 'downloading',
            bytesDownloaded: event.bytesDownloaded || 0,
            totalBytes: event.totalBytes || 0,
          });
          break;
        case 'extracting':
          setViewerState({ status: 'extracting' });
          break;
        case 'configuring':
          setViewerState({ status: 'configuring' });
          break;
        case 'complete':
          setViewerState({ status: 'checking' });
          setInstallationCheckKey(key => key + 1);
          break;
        case 'error':
          setViewerState({ status: 'error', message: event.error || 'Installation failed' });
          break;
      }
    });

    return unsubscribe;
  }, []);

  useFileRefresh(filePath, () => {
    setReloadRevision((current) => current + 1);
  });

  useEffect(() => {
    if (viewerState.status !== 'ready' || !themeLoaded) return;

    const nextKey = `${filePath}:${refreshKey}:${reloadRevision}:${resolvedTheme}`;

    if (nextKey === activeIframe?.key) {
      return;
    }

    setActiveIframe({
      key: nextKey,
      url: buildUrl(filePath, activeIframe !== null),
    });
  }, [viewerState.status, refreshKey, reloadRevision, filePath, activeIframe, buildUrl, resolvedTheme, themeLoaded]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const officeSelection = mapOfficeExtensionSelectionMessage(event.data, filePath);
      if (officeSelection !== undefined) {
        const isOfficeFrame = event.source === activeIframeRef.current?.contentWindow;
        if (!isOfficeFrame || event.origin !== OO_EDITORS_ORIGIN) {
          return;
        }
        window.dispatchEvent(new CustomEvent('selection:changed', { detail: officeSelection }));
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [filePath]);

  useEffect(() => {
    if (!containerRef.current) return;

    const updateBounds = () => {
      if (!containerRef.current) return;
      setNativeDropTargetBounds('office-extension', containerRef.current.getBoundingClientRect());
    };

    updateBounds();
    const resizeObserver = new ResizeObserver(updateBounds);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      clearNativeDropTargetBounds('office-extension');
    };
  }, []);

  if (viewerState.status === 'checking') {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
          Checking installation...
        </div>
      </div>
    );
  }

  const handleInstall = async () => {
    if (!window.electron?.officeExtension?.install) return;

    setViewerState({ status: 'downloading', bytesDownloaded: 0, totalBytes: 0 });

    try {
      const result = await window.electron.officeExtension.install();
      if (!result.success) {
        setViewerState({ status: 'error', message: result.error || 'Installation failed' });
      }
      if (result.success) {
        setViewerState({ status: 'checking' });
        setInstallationCheckKey(key => key + 1);
      }
    } catch (err: any) {
      setViewerState({ status: 'error', message: err.message || 'Installation failed' });
    }
  };

  if (viewerState.status === 'not-installed') {
    return <OfficeReadOnlyViewer filePath={filePath} refreshKey={refreshKey} editingUnavailable onInstallEditor={handleInstall} />;
  }

  if (viewerState.status === 'unsupported-platform') {
    return <OfficeReadOnlyViewer filePath={filePath} refreshKey={refreshKey} />;
  }

  if (viewerState.status === 'downloading') {
    const progress = viewerState.totalBytes > 0
      ? (viewerState.bytesDownloaded / viewerState.totalBytes) * 100
      : 0;

    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="text-center">
          <p className="text-foreground mb-2">Installing Office extensions</p>
          <p className="text-sm">
            {formatBytes(viewerState.bytesDownloaded)}
            {viewerState.totalBytes > 0 && ` / ${formatBytes(viewerState.totalBytes)}`}
            {viewerState.totalBytes > 0 && ` (${Math.round(progress)}%)`}
          </p>
        </div>
        <div className="w-64 h-2 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-foreground"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    );
  }

  if (viewerState.status === 'extracting') {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
          Preparing Office extensions...
        </div>
      </div>
    );
  }

  if (viewerState.status === 'configuring') {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
          Finishing installation...
        </div>
      </div>
    );
  }

  if (viewerState.status === 'starting-server') {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
          Opening your document...
        </div>
      </div>
    );
  }

  if (viewerState.status === 'error') {
    return <OfficeReadOnlyViewer filePath={filePath} refreshKey={refreshKey} editingUnavailable />;
  }

  return (
    <div ref={containerRef} className="relative w-full h-full" data-testid={OFFICE_EXTENSION_VIEWER_ID}>
      {activeIframe && (
        <iframe
          ref={(el) => {
            activeIframeRef.current = el;
          }}
          key={activeIframe.key}
          src={activeIframe.url}
          className="absolute inset-0 w-full h-full border-0"
          title={pathBasename(filePath)}
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
