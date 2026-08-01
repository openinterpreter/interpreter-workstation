/**
 * Centered logo shown when an agent has no messages.
 * Shared between AgentSidebar and editor pane agent views.
 */
import { ACTIVE_APP_BRAND } from '../../src/branding';

export function AgentLogo({
  visible,
  size = 40,
  centerY,
}: {
  visible: boolean;
  size?: number;
  centerY?: string;
}) {
  const sharedClassName = `absolute pointer-events-none z-10 transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`;
  const BrandMark = ACTIVE_APP_BRAND.SymbolMark;
  const width = size * 1.05;
  const height = width * (15.8 / 18.4);

  return (
    <div
      className={centerY ? sharedClassName : `${sharedClassName} inset-0 flex items-center justify-center`}
      style={centerY ? { top: centerY, left: '50%', transform: 'translate(-50%, -50%)' } : undefined}
    >
      <BrandMark
        width={width}
        height={height}
        focusable="false"
        style={{
          color: 'var(--brand-logo-color)',
          opacity: 0.14,
        }}
      />
    </div>
  );
}
