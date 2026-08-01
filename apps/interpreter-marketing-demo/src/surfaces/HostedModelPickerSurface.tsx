import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { HostedModelPicker } from '../../../../src/components/HostedModelPicker';
import i18n from '../../../../src/i18n';
import '../../../../src/index.css';
import { GENERATED_OPENROUTER_CATALOG } from '../../../../src/utils/generatedOpenRouterCatalog';
import { MODEL_OPTIONS } from '../../../../shared/types/model';

const READY_EVENT_TYPE = 'interpreter-marketing-demo-ready';
const DEFAULT_MODEL_ID = MODEL_OPTIONS.hosted[0]?.id ?? 'interpreter-smart';

function useAnnounceEmbedReady(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;

    const announceReady = () => {
      if (cancelled) return;
      window.parent.postMessage({ type: READY_EVENT_TYPE }, '*');
    };

    firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(announceReady, 120);
      });
    });

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId);
      }
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
      }
    };
  }, []);
}

function HostedModelPickerSurfaceContent() {
  const { t } = useTranslation();
  const [selectedModelId, setSelectedModelId] = useState(DEFAULT_MODEL_ID);

  useAnnounceEmbedReady();

  return (
    <div className="mx-auto min-h-screen max-w-[440px] bg-transparent px-4 py-5 sm:px-5 sm:py-6">
      <HostedModelPicker
        label={t('settings.profiles.provider.model.label')}
        description={t('settings.profiles.provider.hosted.modelDescription')}
        modelId={selectedModelId}
        catalog={GENERATED_OPENROUTER_CATALOG}
        loading={false}
        showBrowseToggle={false}
        onModelChange={(modelId) => setSelectedModelId(modelId)}
        onRefresh={() => {}}
      />
    </div>
  );
}

function HostedModelPickerSurfaceApp() {
  return (
    <I18nextProvider i18n={i18n}>
      <HostedModelPickerSurfaceContent />
    </I18nextProvider>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Marketing demo surface root element "#root" not found.');
}

createRoot(rootElement).render(<HostedModelPickerSurfaceApp />);
