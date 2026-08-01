import { createPortal } from 'react-dom';
import { useMemo } from 'react';
import { useLowerLeftNotices } from '../contexts/LowerLeftNoticesContext';

const SIDEBAR_INSET_REM = 0.875;
const MIN_WIDTH_PX = 220;
const FOOTER_STACK_GAP_PX = 16;

interface LowerLeftNoticeViewportProps {
  leftSidebarOpen: boolean;
  leftSidebarWidth: number;
}

export function LowerLeftNoticeViewport({
  leftSidebarOpen,
  leftSidebarWidth,
}: LowerLeftNoticeViewportProps) {
  const { notices } = useLowerLeftNotices();

  const sortedNotices = useMemo(
    () => [...notices].sort((a, b) => a.createdAt - b.createdAt),
    [notices],
  );

  if (sortedNotices.length === 0 || typeof document === 'undefined' || !document.body) {
    return null;
  }

  return createPortal(
    <div
      className="pointer-events-none fixed z-[2147483000] flex flex-col items-start gap-2"
      style={leftSidebarOpen
        ? {
            left: `${SIDEBAR_INSET_REM}rem`,
            width: `min(calc(100vw - 32px), max(${MIN_WIDTH_PX}px, calc(${leftSidebarWidth}px - ${SIDEBAR_INSET_REM * 2}rem)))`,
            bottom: `calc(var(--left-sidebar-footer-stack-height, 0px) + ${FOOTER_STACK_GAP_PX}px)`,
          }
        : {
            left: '16px',
            width: 'min(calc(100vw - 32px), 320px)',
            bottom: '16px',
          }}
    >
      {sortedNotices.map((notice) => (
        <div key={notice.id} className="pointer-events-auto">
          {notice.content}
        </div>
      ))}
    </div>,
    document.body,
  );
}
