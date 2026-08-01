/**
 * McpServerForm - Form for configuring MCP servers
 *
 * Extracted from ToolsSection for reusability.
 * Uses useMcpServerForm hook for state management.
 */

import { useState } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSet, FieldLegend } from '../ui/field';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import type { useMcpServerForm } from '../../hooks/useMcpServerForm';

export interface McpServerFormProps {
  /** Form hook instance from useMcpServerForm */
  form: ReturnType<typeof useMcpServerForm>;
  /** Whether this is a new server (vs editing existing) */
  isNew: boolean;
  /** Called when delete button is clicked */
  onDelete?: () => void;
  /** Whether delete confirmation is active */
  confirmingDelete?: boolean;
  /** Auto-focus name field for new servers */
  autoFocus?: boolean;
  /** Called when cancel button is clicked (for new servers) */
  onCancel?: () => void;
}

export function McpServerForm({
  form,
  isNew,
  onDelete,
  confirmingDelete,
  autoFocus = true,
  onCancel,
}: McpServerFormProps) {
  const { formState, isSaving, saveServer } = form;
  const [saved, setSaved] = useState(false);
  const [showStdioWarning, setShowStdioWarning] = useState(false);

  const handleSave = async () => {
    // Show warning dialog for stdio transport when adding new server
    if (isNew && formState.transport === 'stdio') {
      setShowStdioWarning(true);
      return;
    }
    await doSave();
  };

  const doSave = async () => {
    const success = await saveServer();
    if (success) {
      setSaved(true);
      // Brief delay to show checkmark before any navigation
      setTimeout(() => {
        setSaved(false);
      }, 300);
    }
  };

  return (
    <>
      {/* Warning dialog for local/stdio servers */}
      <AlertDialog open={showStdioWarning} onOpenChange={setShowStdioWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
              <TriangleAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>Local Tool Server</AlertDialogTitle>
            <AlertDialogDescription>
              This tool server will run code locally on your computer.
              Only add servers from sources you trust.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setShowStdioWarning(false);
              doSave();
            }}>
              Add Server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FieldGroup>
      <Field>
        <FieldLabel htmlFor="mcp-server-name">Server Name</FieldLabel>
        <Input
          id="mcp-server-name"
          type="text"
          value={formState.name}
          onChange={(e) => form.setName(e.target.value)}
          placeholder="My Tool Server"
          autoFocus={isNew && autoFocus}
        />
      </Field>

      <FieldSet>
        <FieldLegend variant="label">Transport</FieldLegend>
        <div className="flex gap-1 p-1 rounded-control bg-muted">
          {(['stdio', 'http', 'sse', 'websocket'] as const).map((t) => (
            <Button
              key={t}
              type="button"
              onClick={() => form.setTransport(t)}
              variant={formState.transport === t ? 'secondary' : 'ghost'}
              className={cn(
                'flex-1 text-ui-sm',
                formState.transport === t
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              size="sm"
            >
              {t === 'stdio' ? 'Stdio' : t === 'http' ? 'HTTP' : t === 'sse' ? 'SSE' : 'WebSocket'}
            </Button>
          ))}
        </div>
      </FieldSet>

      {formState.transport === 'stdio' && (
        <>
          <Field>
            <FieldLabel htmlFor="mcp-command">Command</FieldLabel>
            <Input
              id="mcp-command"
              type="text"
              value={formState.command}
              onChange={(e) => form.setCommand(e.target.value)}
              placeholder="node, npx, python, etc."
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mcp-args">Arguments</FieldLabel>
            <Input
              id="mcp-args"
              type="text"
              value={formState.args}
              onChange={(e) => form.setArgs(e.target.value)}
              placeholder="path/to/server.js --option value"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mcp-env">Environment Variables</FieldLabel>
            <Textarea
              id="mcp-env"
              value={formState.env}
              onChange={(e) => form.setEnv(e.target.value)}
              placeholder={"API_KEY=your-key\nOTHER_VAR=value"}
              rows={3}
              className="font-mono resize-none"
            />
            <FieldDescription>One per line: KEY=VALUE</FieldDescription>
          </Field>
        </>
      )}

      {formState.transport !== 'stdio' && (
        <Field>
          <FieldLabel htmlFor="mcp-url">
            {formState.transport === 'websocket' ? 'WebSocket URL' : 'URL'}
          </FieldLabel>
          <Input
            id="mcp-url"
            type="text"
            value={formState.url}
            onChange={(e) => form.setUrl(e.target.value)}
            placeholder={formState.transport === 'websocket' ? 'ws://localhost:3000/mcp' : 'http://localhost:3000/mcp'}
          />
        </Field>
      )}

      {(formState.transport === 'http' || formState.transport === 'sse') && (
        <Field>
          <FieldLabel htmlFor="mcp-headers">HTTP Headers</FieldLabel>
          <Textarea
            id="mcp-headers"
            value={formState.headers}
            onChange={(e) => form.setHeaders(e.target.value)}
            placeholder={"Authorization: Bearer <token>\nX-Custom-Header: value"}
            rows={4}
            className="font-mono resize-none"
          />
          <FieldDescription>One per line: Header-Name: value</FieldDescription>
        </Field>
      )}

      <FieldSet>
        <FieldLegend variant="label">Tool approval</FieldLegend>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ['auto', 'Auto', 'Allow tool calls without asking.'],
            ['prompt', 'Prompt', 'Ask before tool calls run.'],
            ['approve', 'Approve', 'Require the model to request approval first.'],
          ] as const).map(([mode, label, description]) => (
            <button
              key={mode}
              type="button"
              onClick={() => form.setDefaultToolsApprovalMode(mode)}
              className={cn(
                'rounded-control border px-3 py-2 text-left transition-colors',
                formState.defaultToolsApprovalMode === mode
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
            >
              <span className="block text-ui-sm font-medium">{label}</span>
              <span className="mt-1 block text-ui-xs leading-5">{description}</span>
            </button>
          ))}
        </div>
        <FieldDescription>
          Uses the same approval modes as app tools.
        </FieldDescription>
      </FieldSet>

      {/* Action buttons */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={handleSave}
            disabled={!formState.name.trim() || isSaving || saved}
            size="sm"
          >
            {saved ? <Check className="size-4" /> : isSaving ? 'Saving...' : isNew ? 'Add' : 'Save'}
          </Button>
          {onCancel && (
            <Button
              type="button"
              onClick={onCancel}
              variant="outline"
              size="sm"
              disabled={isSaving || saved}
            >
              Cancel
            </Button>
          )}
        </div>

        {/* Delete button - only for existing servers */}
        {!isNew && onDelete && (
          <Button
            type="button"
            onClick={onDelete}
            variant="destructive"
            size="sm"
            disabled={isSaving || saved}
          >
            {confirmingDelete ? 'Confirm?' : 'Delete'}
          </Button>
        )}
      </div>
    </FieldGroup>
    </>
  );
}
