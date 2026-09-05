import { createRoot } from 'react-dom/client';
import { useCallback } from 'react';
import { I18nextProvider } from 'react-i18next';
import { RemoteThreadViewer } from '../../../../agent/components/RemoteThreadViewer';
import i18n from '../../../../src/i18n';
import '../../../../src/index.css';

const READY_EVENT_TYPE = 'interpreter-marketing-demo-ready';
const params = new URLSearchParams(window.location.search);
const endpoint = params.get('endpoint')?.trim();

if (!endpoint) {
  throw new Error('Remote thread viewer requires an endpoint query parameter.');
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Remote thread viewer root element "#root" not found.');
}
document.documentElement.dataset.remoteAccess = 'read-only';

function RemoteThreadSurface() {
  const notifyReady = useCallback(() => {
    window.parent?.postMessage({ type: READY_EVENT_TYPE }, '*');
  }, []);

  return <RemoteThreadViewer endpoint={endpoint} pageSize={10} onReady={notifyReady} />;
}

createRoot(rootElement).render(
  <I18nextProvider i18n={i18n}>
    <RemoteThreadSurface />
  </I18nextProvider>,
);
