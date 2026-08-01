import { useCallback } from 'react';
import { RefInput } from './RefInput';
import { openPathDialog } from '../../ipc';
import type { AutomationBlock, BlockOutput, AutomationConstant } from '../../types/automation';

interface SchemaFieldProps {
  name: string;
  schema: any;
  value: any;
  onChange: (value: any) => void;
  blocksBefore: AutomationBlock[];
  blockOutputs: Record<string, BlockOutput>;
  required?: boolean;
  constants: AutomationConstant[];
  /** Workspace path used as the default location for file/folder pickers */
  workspacePath?: string | null;
}

/** Whether a field name looks like it wants a file or folder path */
function isPathField(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('path') || lower.includes('file') || lower.includes('directory') || lower.includes('folder');
}

/**
 * Recursive JSON Schema → form control renderer.
 * Supports string, number, integer, boolean, object, array, and enum types.
 * String/number fields use RefInput which supports @ mentions for block output references.
 * Path-like fields get an additional browse button for native file/folder selection.
 */
export function SchemaField({ name, schema, value, onChange, blocksBefore, blockOutputs, required, constants, workspacePath }: SchemaFieldProps) {
  const type = schema?.type;
  const description = schema?.description;
  const showBrowse = (type === 'string' || !type) && isPathField(name);

  const handleBrowse = useCallback(async () => {
    const lower = name.toLowerCase();
    const isFolder = lower.includes('directory') || lower.includes('folder');
    const result = await openPathDialog({
      type: isFolder ? 'folder' : 'both',
      defaultPath: workspacePath || undefined,
      title: `Select ${name}`,
    });
    if (!result.canceled && result.filePaths.length > 0) {
      onChange(result.filePaths[0]);
    }
  }, [name, workspacePath, onChange]);

  const label = (
    <label className="block text-ui-xs text-muted-foreground" style={{ marginBottom: 'var(--padding-sm)' }}>
      {name}
      {required && <span className="text-destructive ml-0.5">*</span>}
      {description && <span className="ml-1 opacity-60">— {description}</span>}
    </label>
  );

  if (type === 'boolean') {
    return (
      <div style={{ marginBottom: 'var(--spacing-xs)' }}>
        {label}
        <label className="flex items-center text-ui-sm" style={{ gap: 'var(--spacing-xs)' }}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="rounded"
          />
          <span>{value ? 'true' : 'false'}</span>
        </label>
      </div>
    );
  }

  if (type === 'number' || type === 'integer') {
    return (
      <div style={{ marginBottom: 'var(--spacing-xs)' }}>
        {label}
        <RefInput
          value={value != null ? String(value) : ''}
          onChange={(v) => {
            if (v.includes('@')) {
              onChange(v);
            } else {
              const num = type === 'integer' ? parseInt(v, 10) : parseFloat(v);
              onChange(isNaN(num) ? v : num);
            }
          }}
          blocksBefore={blocksBefore}
          blockOutputs={blockOutputs}
          constants={constants}
          placeholder={`${name}${type === 'integer' ? ' (integer)' : ' (number)'}`}
        />
      </div>
    );
  }

  if (type === 'object' && schema.properties) {
    const requiredFields: string[] = schema.required || [];
    return (
      <div style={{ marginBottom: 'var(--spacing-xs)' }}>
        {label}
        <div style={{ paddingLeft: 'var(--spacing-sm)', borderLeft: 'var(--border-width) solid var(--border)' }}>
          {Object.entries(schema.properties).map(([key, propSchema]: [string, any]) => (
            <SchemaField
              key={key}
              name={key}
              schema={propSchema}
              value={value?.[key] ?? ''}
              onChange={(v) => onChange({ ...value, [key]: v })}
              blocksBefore={blocksBefore}
              blockOutputs={blockOutputs}
              required={requiredFields.includes(key)}
              constants={constants}
              workspacePath={workspacePath}
            />
          ))}
        </div>
      </div>
    );
  }

  if (type === 'array') {
    return (
      <div style={{ marginBottom: 'var(--spacing-xs)' }}>
        {label}
        <RefInput
          value={typeof value === 'string' ? value : JSON.stringify(value ?? [], null, 2)}
          onChange={(v) => {
            if (v.includes('@')) {
              onChange(v);
            } else {
              try { onChange(JSON.parse(v)); } catch { onChange(v); }
            }
          }}
          blocksBefore={blocksBefore}
          blockOutputs={blockOutputs}
          constants={constants}
          placeholder={`${name} (JSON array)`}
        />
      </div>
    );
  }

  // Enum
  if (schema?.enum) {
    return (
      <div style={{ marginBottom: 'var(--spacing-xs)' }}>
        {label}
        <select
          className="w-full rounded text-ui-sm bg-background text-foreground"
          style={{
            border: 'var(--border-width) solid var(--border)',
            padding: `var(--padding-sm) var(--spacing-xs)`,
          }}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— select —</option>
          {schema.enum.map((opt: string) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  // Default: string (with optional browse button for path-like fields)
  return (
    <div style={{ marginBottom: 'var(--spacing-xs)' }}>
      {label}
      <div className="flex items-start" style={{ gap: 'var(--spacing-xs)' }}>
        <div className="flex-1">
          <RefInput
            value={value ?? ''}
            onChange={onChange}
            blocksBefore={blocksBefore}
            blockOutputs={blockOutputs}
            constants={constants}
            placeholder={name}
          />
        </div>
        {showBrowse && (
          <button
            className="shrink-0 text-ui-xs text-muted-foreground rounded bg-muted hover:bg-hover"
            style={{
              border: 'var(--border-width) solid var(--border)',
              padding: `var(--padding-sm) var(--spacing-xs)`,
              height: 'var(--unit-height-small)',
            }}
            onClick={handleBrowse}
            title="Browse..."
          >
            Browse
          </button>
        )}
      </div>
    </div>
  );
}
