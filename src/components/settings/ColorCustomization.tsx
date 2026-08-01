import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './SettingsSection';
import { Button } from '../ui/button';
import { RotateCcw } from 'lucide-react';

// CSS variables to expose for customization
// oklch values converted to approximate hex for default display
const COLOR_VARIABLES = [
  { name: '--background', label: 'Background', defaultLight: '#ffffff', defaultDark: '#121212' },
  { name: '--foreground', label: 'Foreground', defaultLight: '#242428', defaultDark: '#e5e5e5' },
  { name: '--muted', label: 'Muted', defaultLight: '#f4f4f5', defaultDark: '#2d2d2d' },
  { name: '--muted-foreground', label: 'Muted foreground', defaultLight: '#71717a', defaultDark: '#b8b8b8' },
  { name: '--border', label: 'Border', defaultLight: '#d4d4d8', defaultDark: '#2e2e2e' },
  { name: '--inactive-bg', label: 'App background', defaultLight: '#e4e4e7', defaultDark: '#1e1e1e' },
  { name: '--hover-bg', label: 'Hover background', defaultLight: '#e9e9e9', defaultDark: '#2a2a2a' },
  { name: '--primary', label: 'Primary', defaultLight: '#3b82f6', defaultDark: '#3b82f6' },
] as const;

const STORAGE_KEY = 'workstation-custom-colors';

interface CustomColors {
  light: Record<string, string>;
  dark: Record<string, string>;
}

function getStoredColors(): CustomColors {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load custom colors:', e);
  }
  return { light: {}, dark: {} };
}

function storeColors(colors: CustomColors) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch (e) {
    console.error('Failed to store custom colors:', e);
  }
}

function applyColors(colors: CustomColors) {
  const root = document.documentElement;
  const isDark = root.classList.contains('dark');
  const modeColors = isDark ? colors.dark : colors.light;

  // Apply custom colors
  Object.entries(modeColors).forEach(([name, value]) => {
    if (value) {
      root.style.setProperty(name, value);
    }
  });
}

function clearAppliedColors() {
  const root = document.documentElement;
  COLOR_VARIABLES.forEach(({ name }) => {
    root.style.removeProperty(name);
  });
}

// Apply colors on initial load
export function initCustomColors() {
  const colors = getStoredColors();
  applyColors(colors);

  // Re-apply when theme changes
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'class') {
        clearAppliedColors();
        applyColors(getStoredColors());
      }
    });
  });

  observer.observe(document.documentElement, { attributes: true });

  return () => observer.disconnect();
}

export function ColorCustomization() {
  const { t } = useTranslation();
  const [colors, setColors] = useState<CustomColors>({ light: {}, dark: {} });
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setColors(getStoredColors());
    setIsDark(document.documentElement.classList.contains('dark'));

    // Watch for theme changes
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true });

    return () => observer.disconnect();
  }, []);

  const currentMode = isDark ? 'dark' : 'light';
  const modeColors = colors[currentMode];

  function handleColorChange(varName: string, value: string) {
    const newColors = {
      ...colors,
      [currentMode]: {
        ...colors[currentMode],
        [varName]: value,
      },
    };
    setColors(newColors);
    storeColors(newColors);
    document.documentElement.style.setProperty(varName, value);
  }

  function handleReset(varName: string) {
    const newModeColors = { ...colors[currentMode] };
    delete newModeColors[varName];
    const newColors = {
      ...colors,
      [currentMode]: newModeColors,
    };
    setColors(newColors);
    storeColors(newColors);
    document.documentElement.style.removeProperty(varName);
  }

  function handleResetAll() {
    const newColors = {
      ...colors,
      [currentMode]: {},
    };
    setColors(newColors);
    storeColors(newColors);
    clearAppliedColors();
  }

  const colorLabelKeys: Record<string, string> = {
    '--background': 'settings.style.colors.background',
    '--foreground': 'settings.style.colors.foreground',
    '--muted': 'settings.style.colors.muted',
    '--muted-foreground': 'settings.style.colors.mutedForeground',
    '--border': 'settings.style.colors.border',
    '--inactive-bg': 'settings.style.colors.appBackground',
    '--hover-bg': 'settings.style.colors.hoverBackground',
    '--primary': 'settings.style.colors.primary',
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-ui-sm text-muted-foreground">
          {t('settings.style.colors.editingMode', { mode: isDark ? t('settings.style.colors.editingDark') : t('settings.style.colors.editingLight') })}
        </div>
        <Button variant="ghost" size="xs" onClick={handleResetAll}>
          <RotateCcw className="size-3" />
          {t('settings.style.colors.resetAll')}
        </Button>
      </div>

      {COLOR_VARIABLES.map(({ name, defaultLight, defaultDark }) => {
        const defaultValue = isDark ? defaultDark : defaultLight;
        const currentValue = modeColors[name] || defaultValue;
        const isCustomized = !!modeColors[name];

        return (
          <SettingsRow key={name} label={colorLabelKeys[name] ? t(colorLabelKeys[name]) : name}>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={currentValue}
                onChange={(e) => handleColorChange(name, e.target.value)}
                className="w-8 h-6 bg-transparent rounded-control"
                style={{ border: 'var(--border-width) solid var(--border)' }}
                title={currentValue}
              />
              {isCustomized && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => handleReset(name)}
                  title={t('settings.style.colors.resetToDefault')}
                >
                  <RotateCcw className="size-3" />
                </Button>
              )}
            </div>
          </SettingsRow>
        );
      })}
    </div>
  );
}
