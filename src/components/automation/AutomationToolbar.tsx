interface AutomationToolbarProps {
  name: string;
  onNameChange: (name: string) => void;
  onRunAll: () => void;
  isRunning: boolean;
  saveStatus: 'saved' | 'unsaved' | 'saving';
  hasMissingProfile: boolean;
}

export function AutomationToolbar({
  name,
  onNameChange,
  onRunAll,
  isRunning,
  saveStatus,
  hasMissingProfile,
}: AutomationToolbarProps) {
  return (
    <div
      className="flex items-center bg-muted/30"
      style={{
        borderBottom: 'var(--border-width) solid var(--border)',
        gap: 'var(--spacing-sm)',
        padding: `0 var(--spacing-sm)`,
        height: 'var(--unit-height)',
      }}
    >
      <input
        className="flex-1 text-ui-base font-medium bg-transparent rounded"
        style={{
          border: 'var(--border-width) solid transparent',
          padding: `var(--padding-sm) var(--spacing-xs)`,
        }}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        onFocus={(e) => (e.target.style.borderColor = 'var(--border)')}
        onBlur={(e) => (e.target.style.borderColor = 'transparent')}
      />

      <span className="text-ui-xs text-muted-foreground">
        {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'unsaved' ? 'Unsaved' : 'Saved'}
      </span>

      {hasMissingProfile && (
        <span className="text-ui-xs text-muted-foreground">
          Select a model for agent blocks before running
        </span>
      )}

      <button
        className="text-ui-sm rounded bg-primary text-primary-foreground disabled:opacity-50"
        style={{ padding: `var(--padding-sm) var(--spacing-md)` }}
        onClick={onRunAll}
        disabled={isRunning}
      >
        {isRunning ? 'Running...' : 'Run All'}
      </button>
    </div>
  );
}
