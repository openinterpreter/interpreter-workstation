import { createContext, useContext, useState, useCallback, useEffect, useMemo, ReactNode } from 'react';
import i18n from '../i18n';

export interface HelpInfo {
  title: string;
  description: string;
  filePath?: string;
  itemType?: 'file' | 'directory';
}

interface HelpContextValue {
  helpInfo: HelpInfo | null;
  setHelpInfo: (info: HelpInfo | null) => void;
  isHelpPanelOpen: boolean;
  setIsHelpPanelOpen: (open: boolean) => void;
  helpPanelHeight: number;
  setHelpPanelHeight: (height: number) => void;
}

function getDefaultHelpInfo(): HelpInfo {
  return {
    title: i18n.t('help.default.title'),
    description: i18n.t('help.default.description'),
  };
}

const HelpContext = createContext<HelpContextValue | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [helpInfo, setHelpInfo] = useState<HelpInfo | null>(null);
  const [isHelpPanelOpen, setIsHelpPanelOpen] = useState(true);
  const [helpPanelHeight, setHelpPanelHeight] = useState(150);

  // Global hover detection for elements with data-help-title/data-help-description
  useEffect(() => {
    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Find the closest element with data-help-title
      const helpElement = target.closest('[data-help-title]') as HTMLElement | null;

      if (helpElement) {
        const title = helpElement.getAttribute('data-help-title') || '';
        const description = helpElement.getAttribute('data-help-description') || '';
        const filePath = helpElement.getAttribute('data-path') || undefined;
        const itemType = helpElement.getAttribute('data-help-item-type');

        if (title) {
          setHelpInfo({
            title,
            description,
            filePath,
            itemType: itemType === 'file' || itemType === 'directory' ? itemType : undefined,
          });
        }
      }
    };

    const handleMouseOut = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const relatedTarget = e.relatedTarget as HTMLElement | null;

      // Check if we're leaving a help element
      const helpElement = target.closest('[data-help-title]');

      if (helpElement) {
        // Check if we're moving to another element within the same help element
        if (relatedTarget && helpElement.contains(relatedTarget)) {
          return;
        }

        // Check if we're moving to another help element
        const newHelpElement = relatedTarget?.closest('[data-help-title]');
        if (!newHelpElement) {
          setHelpInfo(null);
        }
      }
    };

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseout', handleMouseOut);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('mouseout', handleMouseOut);
    };
  }, []);

  const value = useMemo(() => ({
    helpInfo,
    setHelpInfo,
    isHelpPanelOpen,
    setIsHelpPanelOpen,
    helpPanelHeight,
    setHelpPanelHeight,
  }), [helpInfo, setHelpInfo, isHelpPanelOpen, setIsHelpPanelOpen, helpPanelHeight, setHelpPanelHeight]);

  return (
    <HelpContext.Provider value={value}>
      {children}
    </HelpContext.Provider>
  );
}

export function useHelp() {
  const context = useContext(HelpContext);
  if (!context) {
    throw new Error('useHelp must be used within a HelpProvider');
  }
  return context;
}

// Safe version that returns null if not in a provider (for optional help)
export function useHelpOptional() {
  return useContext(HelpContext);
}

export function useHelpHover(title: string, description: string) {
  const { setHelpInfo } = useHelp();

  const onMouseEnter = useCallback(() => {
    setHelpInfo({ title, description });
  }, [title, description, setHelpInfo]);

  const onMouseLeave = useCallback(() => {
    setHelpInfo(null);
  }, [setHelpInfo]);

  return { onMouseEnter, onMouseLeave };
}

// Helper to generate help info for file types
export function getFileHelp(filename: string, type: 'file' | 'directory'): HelpInfo {
  if (type === 'directory') {
    return {
      title: filename,
      description: i18n.t('help.explorer.folderDescription'),
      itemType: 'directory',
    };
  }

  return {
    title: filename,
    description: i18n.t('help.explorer.fileDescription'),
    itemType: 'file',
  };
}

export { getDefaultHelpInfo };
