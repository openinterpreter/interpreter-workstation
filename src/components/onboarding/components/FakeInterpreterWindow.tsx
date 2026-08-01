import { type CSSProperties, type ReactNode } from 'react';
import { MousePointer2, PanelLeft, PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type FakeInterpreterPanelId = 'explorer' | 'interfaces' | 'agent';

export interface FakeCursorPosition {
  x: string;
  y: string;
}

interface FakeInterpreterWindowProps {
  explorerContent: ReactNode;
  interfacesContent: ReactNode;
  agentContent: ReactNode;
  spotlightPanel?: FakeInterpreterPanelId | null;
  cursorPosition?: FakeCursorPosition;
  className?: string;
  minHeightClassName?: string;
}

interface PanelShellProps {
  isActive: boolean;
  showDivider: boolean;
  children: ReactNode;
}

function PanelShell({ isActive, showDivider, children }: PanelShellProps) {
  return (
    <section
      className={cn(
        'relative flex min-w-0 flex-col overflow-hidden transition-[opacity,background-color] duration-500',
        isActive ? 'opacity-100' : 'opacity-78',
      )}
      style={{
        borderRight: showDivider
          ? 'var(--border-width) solid color-mix(in oklch, var(--oa-border, var(--border)) 32%, transparent)'
          : undefined,
        backgroundColor: isActive
          ? 'color-mix(in oklch, var(--oa-bg-app, var(--background)) 28%, transparent)'
          : 'color-mix(in oklch, var(--oa-bg-subtle, var(--inactive-bg)) 16%, transparent)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          boxShadow: isActive
            ? 'inset 0 1px 0 color-mix(in oklch, white 18%, transparent)'
            : 'none',
        }}
      />
      <div className="relative flex-1 min-h-0">{children}</div>
    </section>
  );
}

function TrafficLight({ color }: { color: string }) {
  return (
    <span
      className="size-[6px] rounded-full"
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 22%, var(--oa-bg-app, var(--background)) 78%)`,
      }}
    />
  );
}

export function FakeInterpreterWindow({
  explorerContent,
  interfacesContent,
  agentContent,
  spotlightPanel = null,
  cursorPosition,
  className,
  minHeightClassName = 'aspect-[16/10] min-h-[420px]',
}: FakeInterpreterWindowProps) {
  const isExplActive = !spotlightPanel || spotlightPanel === 'explorer';
  const isInterfacesActive = !spotlightPanel || spotlightPanel === 'interfaces';
  const isAgentActive = !spotlightPanel || spotlightPanel === 'agent';
  const cursorStyle = cursorPosition
    ? {
      '--fake-cursor-x': cursorPosition.x,
      '--fake-cursor-y': cursorPosition.y,
      transform: 'translate3d(calc(var(--fake-cursor-x) - 50%), calc(var(--fake-cursor-y) - 50%), 0)',
    } as CSSProperties
    : undefined;

  return (
    <div
      className={cn('w-full overflow-hidden rounded-[18px]', className)}
      style={{
        border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border, var(--border)) 36%, transparent)',
        backgroundColor: 'color-mix(in oklch, var(--oa-bg-app, var(--background)) 92%, var(--oa-bg-subtle, var(--inactive-bg)) 8%)',
        boxShadow: 'none',
      }}
    >
      <div
        className="relative flex items-center justify-between"
        style={{
          height: '30px',
          borderBottom: 'var(--border-width) solid color-mix(in oklch, var(--oa-border, var(--border)) 30%, transparent)',
          paddingLeft: '12px',
          paddingRight: '10px',
          backgroundColor: 'color-mix(in oklch, var(--oa-bg-app, var(--background)) 52%, transparent)',
        }}
      >
        <div className="flex items-center gap-1.5" aria-hidden>
          <TrafficLight color="#FF5F57" />
          <TrafficLight color="#FEBC2E" />
          <TrafficLight color="#28C840" />
        </div>

        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/65">
          Interpreter
        </div>

        <div className="flex items-center gap-0.5 text-muted-foreground/65">
          <span className="titlebar-button flex size-6 items-center justify-center">
            <PanelLeft className="size-3.5" />
          </span>
          <span className="titlebar-button flex size-6 items-center justify-center">
            <PanelRight className="size-3.5" />
          </span>
        </div>
      </div>

      <div
        className={cn('relative grid', minHeightClassName)}
        style={{
          gridTemplateColumns: 'minmax(176px, 0.9fr) minmax(280px, 1.5fr) minmax(220px, 1.05fr)',
          backgroundColor: 'color-mix(in oklch, var(--oa-bg-app, var(--background)) 80%, transparent)',
        }}
      >
        <PanelShell isActive={isExplActive} showDivider={true}>
          {explorerContent}
        </PanelShell>
        <PanelShell isActive={isInterfacesActive} showDivider={true}>
          {interfacesContent}
        </PanelShell>
        <PanelShell isActive={isAgentActive} showDivider={false}>
          {agentContent}
        </PanelShell>

        {cursorPosition && (
          <div
            className="pointer-events-none absolute left-0 top-0 z-30 transform-gpu transition-transform duration-700 ease-in-out motion-reduce:transition-none"
            style={cursorStyle}
            aria-hidden
          >
            <MousePointer2
              className="size-4 text-foreground drop-shadow-[0_1px_1px_rgba(0,0,0,0.18)]"
              fill="var(--background)"
              strokeWidth={2.2}
            />
          </div>
        )}
      </div>
    </div>
  );
}
