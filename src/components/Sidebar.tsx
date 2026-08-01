import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { PanelLeft } from 'lucide-react';
import { Explorer } from './Explorer';
import { InboxSidebar } from './InboxSidebar';
import { HelpPanel } from './HelpPanel';
import { SkillsPanel } from './SkillsPanel';
import { useLayout } from '../hooks/useLayout';
import { useHelp } from '../contexts/HelpContext';
import { EXPLORER_BUTTON_ID, EXPLORER_SIDEBAR_ID } from '../../shared/element-ids';
import { getSidebarFooterMotion } from './sidebarFooterMotion';
import { isMarketingDemoMode } from '../demo/marketingDemo';
import { TooltipButton } from './ui/tooltip-button';
import { cn } from '@/lib/utils';

interface SidebarProps {
  onFileOpen: (path: string) => void;
}

export function Sidebar({ onFileOpen }: SidebarProps) {
  const { t } = useTranslation();
  const { state, toggleLeftSidebar } = useLayout();
  const { isHelpPanelOpen } = useHelp();
  const marketingDemoMode = isMarketingDemoMode();
  const reducedMotion = useReducedMotion() ?? false;
  const dividerMotion = getSidebarFooterMotion('divider', reducedMotion);
  const activeTab = state.leftSidebar.activeTab;
  const footerStackRef = useRef<HTMLDivElement>(null);
  const [isSkillsPanelOpen, setIsSkillsPanelOpen] = useState(false);
  const showCollapsedFooterDivider = activeTab === 'explorer' && !isHelpPanelOpen && !isSkillsPanelOpen;
  const titlebarButtonClassName = cn(
    'oa-hover-chip titlebar-button min-w-[34px] border border-transparent bg-transparent text-[#5f6673] shadow-none transition-colors duration-150',
    'hover:text-[#202123]',
    'dark:text-[#bdbdbd] dark:hover:text-[#f5f5f5]',
  );

  useEffect(() => {
    const footerStack = footerStackRef.current;
    if (!footerStack || typeof document === 'undefined') {
      return;
    }

    const updateFooterHeight = () => {
      const height = Math.ceil(footerStack.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--left-sidebar-footer-stack-height', `${height}px`);
    };

    updateFooterHeight();

    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => updateFooterHeight())
      : null;
    observer?.observe(footerStack);
    window.addEventListener('resize', updateFooterHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateFooterHeight);
      document.documentElement.style.removeProperty('--left-sidebar-footer-stack-height');
    };
  }, [activeTab]);

  return (
    <div
      className="app-sidebar-surface relative flex h-full w-full flex-col overflow-x-hidden overflow-y-visible bg-transparent text-[#202123] dark:text-[#f5f5f5]"
      style={{ zIndex: 1, paddingTop: 'var(--unit-height)', paddingBottom: '8px' }}
    >
      <div
        className="absolute right-2 top-0 z-20 flex h-[var(--unit-height)] items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <TooltipButton
          variant="ghost"
          size="icon-element"
          onClick={toggleLeftSidebar}
          className={titlebarButtonClassName}
          data-testid={EXPLORER_BUTTON_ID}
          tooltip={t('help.sidebar.explorer.closeTitle')}
          helpDescription={t('help.sidebar.explorer.description')}
          tooltipSide="bottom"
        >
          <PanelLeft />
        </TooltipButton>
      </div>
      {/* Sidebar content */}
      <div className="flex-1 min-h-0 px-2.5">
        <div id="explorer-sidebar" className="h-full" style={{ display: activeTab === 'explorer' ? 'block' : 'none' }} data-testid={EXPLORER_SIDEBAR_ID}>
          <div className="h-full min-h-0">
            <Explorer onFileOpen={onFileOpen} />
          </div>
        </div>

        {!marketingDemoMode ? (
          <div id="inbox-sidebar" className="h-full" style={{ display: activeTab === 'inbox' ? 'block' : 'none' }}>
            <InboxSidebar />
          </div>
        ) : null}
      </div>

      <div ref={footerStackRef} className="flex-shrink-0">
        {activeTab === 'explorer' ? (
          <div className="px-2.5">
            <SkillsPanel
              isOpen={isSkillsPanelOpen}
              onOpenChange={setIsSkillsPanelOpen}
              onFileOpen={onFileOpen}
            />
          </div>
        ) : null}

        <AnimatePresence initial={false}>
          {showCollapsedFooterDivider ? (
            <motion.div
              key="sidebar-footer-divider"
              initial={dividerMotion.initial}
              animate={dividerMotion.animate}
              exit={dividerMotion.exit}
              transition={dividerMotion.transition}
              style={{
                height: 'var(--border-width)',
                marginBottom: 'calc(-1 * var(--border-width))',
                background: 'color-mix(in srgb, var(--foreground) 12%, transparent)',
              }}
            />
          ) : null}
        </AnimatePresence>

        <div className="px-2.5">
          <HelpPanel />
        </div>
      </div>
    </div>
  );
}
