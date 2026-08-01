import { useState } from 'react';
import type { BlockOutput as BlockOutputType } from '../../types/automation';

interface BlockOutputProps {
  output: BlockOutputType;
}

export function BlockOutput({ output }: BlockOutputProps) {
  const [expanded, setExpanded] = useState(true);
  const hasError = !!output.error;

  return (
    <div
      className="rounded overflow-hidden"
      style={{
        border: 'var(--border-width) solid var(--border)',
        margin: `0 var(--spacing-sm) var(--spacing-sm)`,
        background: hasError ? 'color-mix(in oklch, var(--destructive) 10%, var(--background))' : 'var(--muted)',
      }}
    >
      <button
        className="w-full flex items-center text-ui-xs text-muted-foreground"
        style={{ gap: 'var(--spacing-xs)', padding: `var(--padding-sm) var(--spacing-sm)` }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span>{hasError ? 'Error' : 'Output'}</span>
        <span className="ml-auto text-muted-foreground">
          {new Date(output.timestamp).toLocaleTimeString()}
        </span>
      </button>
      {expanded && (
        <pre
          className="text-ui-xs overflow-auto whitespace-pre-wrap break-all"
          style={{ padding: `0 var(--spacing-sm) var(--spacing-sm)`, maxHeight: 256 }}
        >
          {hasError
            ? output.error
            : JSON.stringify(output.result, null, 2)}
        </pre>
      )}
    </div>
  );
}
