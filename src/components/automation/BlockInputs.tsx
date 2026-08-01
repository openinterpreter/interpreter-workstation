import { SchemaField } from './SchemaField';
import type { AutomationBlock, BlockOutput, AutomationConstant } from '../../types/automation';

interface BlockInputsProps {
  block: AutomationBlock;
  inputSchema: any;
  onUpdateInput: (key: string, value: any) => void;
  blocksBefore: AutomationBlock[];
  blockOutputs: Record<string, BlockOutput>;
  constants: AutomationConstant[];
  workspacePath?: string | null;
}

export function BlockInputs({ block, inputSchema, onUpdateInput, blocksBefore, blockOutputs, constants, workspacePath }: BlockInputsProps) {
  if (!inputSchema?.properties) {
    return (
      <div className="text-ui-xs text-muted-foreground italic" style={{ padding: `0 var(--spacing-sm) var(--spacing-xs)` }}>
        No input schema available for this tool.
      </div>
    );
  }

  const requiredFields: string[] = inputSchema.required || [];

  return (
    <div style={{ padding: `0 var(--spacing-sm) var(--spacing-xs)` }}>
      {Object.entries(inputSchema.properties).map(([key, schema]: [string, any]) => (
        <SchemaField
          key={key}
          name={key}
          schema={schema}
          value={block.inputs[key] ?? ''}
          onChange={(value) => onUpdateInput(key, value)}
          blocksBefore={blocksBefore}
          blockOutputs={blockOutputs}
          required={requiredFields.includes(key)}
          constants={constants}
          workspacePath={workspacePath}
        />
      ))}
    </div>
  );
}
