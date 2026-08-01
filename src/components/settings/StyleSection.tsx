import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NativeSelect } from '../ui/NativeSelect';
import { Slider } from '../ui/slider';
import { Switch } from '../ui/switch';
import { SettingsPane, SettingsRow, SettingsSection } from './SettingsSection';
import { cn } from '@/lib/utils';
import { theme as themeIpc, backgroundOpacity as backgroundOpacityIpc, zoomFactor as zoomFactorIpc, primaryColor as primaryColorIpc, uiSettings } from '@/ipc';
import type {
  ThemeChangedEvent,
  BackgroundOpacityChangedEvent,
  PrimaryColorChangedEvent,
} from '../../../electron/ipc/registry';
import { PRIMARY_COLORS } from '../../../shared/types/colors';
import { DEFAULT_BACKGROUND_OPACITY } from '../../../shared/uiDefaults';
import { ColorCustomization } from './ColorCustomization';
import { trackSettingChanged } from '../../utils/telemetry';

const ZOOM_LEVELS = [75, 90, 100, 110, 125, 150, 200] as const;

export function StyleSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [theme, setThemeState] = useState<'light' | 'dark' | 'system'>('system');
  const [themeLoading, setThemeLoading] = useState(true);
  const [backgroundOpacity, setBackgroundOpacity] = useState(DEFAULT_BACKGROUND_OPACITY);
  const [opacityLoading, setOpacityLoading] = useState(true);
  const [zoomFactor, setZoomFactorState] = useState(1.0);
  const [zoomLoading, setZoomLoading] = useState(true);
  const [primaryColor, setPrimaryColorState] = useState<string>('gray');
  const [colorLoading, setColorLoading] = useState(true);
  const [showHelpPanelPreview, setShowHelpPanelPreviewState] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);

  useEffect(() => {
    async function loadTheme() {
      try {
        const response = await themeIpc.get();
        setThemeState(response.theme);
      } catch (error) {
        console.error('Failed to load theme:', error);
      } finally {
        setThemeLoading(false);
      }
    }
    loadTheme();

    const unsubscribe = themeIpc.onChanged((event: ThemeChangedEvent) => {
      setThemeState(event.theme);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    async function loadOpacity() {
      try {
        const response = await backgroundOpacityIpc.get();
        setBackgroundOpacity(response.opacity);
      } catch (error) {
        console.error('Failed to load background opacity:', error);
      } finally {
        setOpacityLoading(false);
      }
    }
    loadOpacity();

    const unsubscribe = backgroundOpacityIpc.onChanged((event: BackgroundOpacityChangedEvent) => {
      setBackgroundOpacity(event.opacity);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    async function loadZoomFactor() {
      try {
        const response = await zoomFactorIpc.get();
        setZoomFactorState(response.zoomFactor);
      } catch (error) {
        console.error('Failed to load zoom factor:', error);
      } finally {
        setZoomLoading(false);
      }
    }
    loadZoomFactor();

    const unsubscribe = zoomFactorIpc.onChanged((event: { zoomFactor: number }) => {
      setZoomFactorState(event.zoomFactor);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    async function loadPrimaryColor() {
      try {
        const response = await primaryColorIpc.get();
        setPrimaryColorState(response.color);
      } catch (error) {
        console.error('Failed to load primary color:', error);
      } finally {
        setColorLoading(false);
      }
    }
    loadPrimaryColor();

    const unsubscribe = primaryColorIpc.onChanged((event: PrimaryColorChangedEvent) => {
      setPrimaryColorState(event.color);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    async function loadShowHelpPanelPreview() {
      try {
        const response = await uiSettings.getShowHelpPanelPreview();
        setShowHelpPanelPreviewState(response.enabled);
      } catch (error) {
        console.error('Failed to load help panel preview setting:', error);
      } finally {
        setPreviewLoading(false);
      }
    }
    loadShowHelpPanelPreview();

    const unsubscribe = uiSettings.onShowHelpPanelPreviewChanged?.((event: { enabled: boolean }) => {
      setShowHelpPanelPreviewState(event.enabled);
    });

    return unsubscribe;
  }, []);

  async function handleThemeChange(newTheme: 'light' | 'dark' | 'system') {
    const oldValue = theme;
    setThemeState(newTheme);
    try {
      await themeIpc.set(newTheme);
      trackSettingChanged({
        settingKey: 'theme', tabId: 'style', sectionId: 'style',
        valueType: 'enum', oldValue, newValue: newTheme,
      });
    } catch (error) {
      console.error('Failed to save theme:', error);
    }
  }

  async function handleOpacityChange(newOpacity: number) {
    const oldValue = backgroundOpacity;
    setBackgroundOpacity(newOpacity);
    try {
      await backgroundOpacityIpc.set(newOpacity);
      trackSettingChanged({
        settingKey: 'backgroundOpacity', tabId: 'style', sectionId: 'style',
        valueType: 'number', oldValue, newValue: newOpacity,
      });
    } catch (error) {
      console.error('Failed to save background opacity:', error);
    }
  }

  async function handleZoomFactorChange(newZoomFactor: number) {
    const oldValue = zoomFactor;
    setZoomFactorState(newZoomFactor);
    try {
      await zoomFactorIpc.set(newZoomFactor);
      trackSettingChanged({
        settingKey: 'zoomFactor', tabId: 'style', sectionId: 'style',
        valueType: 'number', oldValue, newValue: newZoomFactor,
      });
    } catch (error) {
      console.error('Failed to save zoom factor:', error);
    }
  }

  async function handlePrimaryColorChange(newColor: string) {
    const oldValue = primaryColor;
    setPrimaryColorState(newColor);
    try {
      await primaryColorIpc.set(newColor);
      trackSettingChanged({
        settingKey: 'primaryColor', tabId: 'style', sectionId: 'style',
        valueType: 'enum', oldValue, newValue: newColor,
      });
    } catch (error) {
      console.error('Failed to save primary color:', error);
    }
  }

  async function handleShowHelpPanelPreviewChange(show: boolean) {
    setShowHelpPanelPreviewState(show);
    try {
      await uiSettings.setShowHelpPanelPreview(show);
    } catch (error) {
      console.error('Failed to save help panel preview setting:', error);
    }
  }

  const loading = themeLoading || opacityLoading || zoomLoading || colorLoading || previewLoading;
  const zoomPercent = Math.round(zoomFactor * 100);
  const zoomItems = Array.from(new Set([...ZOOM_LEVELS, zoomPercent]))
    .sort((a, b) => a - b)
    .map((value) => ({ label: `${value}%`, value: String(value) }));

  if (loading) {
    return <div className="py-3 text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <SettingsPane>
      <SettingsSection title={t('settings.style.appearanceSection')}>
        <SettingsRow label={t('settings.style.themeLabel')} description={t('settings.style.themeDescription')}>
          <NativeSelect
            value={theme}
            onValueChange={(value) => handleThemeChange(value as 'light' | 'dark' | 'system')}
            items={[
              { label: t('settings.style.themeLight'), value: 'light' },
              { label: t('settings.style.themeDark'), value: 'dark' },
              { label: t('settings.style.themeSystem'), value: 'system' },
            ]}
            size="sm"
            className="w-[132px]"
          />
        </SettingsRow>

        <SettingsRow label={t('settings.style.accentColorLabel')} description={t('settings.style.accentColorDescription')}>
          <div className="flex items-center gap-1.5">
            {PRIMARY_COLORS.map((colorOption) => (
              <button
                key={colorOption.id}
                type="button"
                onClick={() => handlePrimaryColorChange(colorOption.id)}
                className={cn(
                  'size-5 rounded-full transition-[transform,outline-color] hover:scale-[1.03]',
                  primaryColor === colorOption.id && 'outline outline-2 outline-offset-2 outline-foreground'
                )}
                style={{
                  backgroundColor: colorOption.color,
                  border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 52%, transparent)',
                }}
                title={colorOption.label}
                aria-label={t('settings.style.accentColorAriaLabel', { color: colorOption.label })}
                aria-pressed={primaryColor === colorOption.id}
              />
            ))}
          </div>
        </SettingsRow>

        <SettingsRow label={t('settings.style.windowOpacityLabel')} description={t('settings.style.windowOpacityDescription')}>
          <div className="flex items-center gap-3">
            <Slider
              min={0}
              max={100}
              step={1}
              value={[backgroundOpacity * 100]}
              onValueChange={(values) => handleOpacityChange(values[0] / 100)}
              className="w-36"
              aria-label={t('settings.style.windowOpacityAriaLabel')}
            />
            <span className="w-8 text-ui-sm text-muted-foreground">{Math.round(backgroundOpacity * 100)}%</span>
          </div>
        </SettingsRow>

        <SettingsRow label={t('settings.style.interfaceZoomLabel')} description={t('settings.style.interfaceZoomDescription')}>
          <NativeSelect
            value={String(zoomPercent)}
            onValueChange={(value) => handleZoomFactorChange(Number(value) / 100)}
            items={zoomItems}
            size="sm"
            className="w-[132px]"
          />
        </SettingsRow>

        <SettingsRow label={t('settings.style.filePreviewLabel')} description={t('settings.style.filePreviewDescription')}>
          <Switch
            size="sm"
            checked={showHelpPanelPreview}
            onCheckedChange={handleShowHelpPanelPreviewChange}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t('settings.style.customColorsSection')}>
        <div className="py-[18px]">
          <ColorCustomization />
        </div>
      </SettingsSection>
    </SettingsPane>
  );
}
