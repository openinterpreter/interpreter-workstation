import { useState } from 'react';
import { addToolServer, updateToolServer, ToolServer, ToolServerConfig } from '../api';
import { trackSkillInstalled, trackSkillInstallFailed } from '../utils/telemetry';

export type McpTransportType = 'stdio' | 'http' | 'sse' | 'websocket';

export interface McpServerFormState {
  name: string;
  transport: McpTransportType;
  command: string;
  args: string;
  url: string;
  env: string;  // KEY=VALUE pairs, one per line
  headers: string; // Header lines, one per line (Header: Value)
  defaultToolsApprovalMode: 'auto' | 'prompt' | 'approve';
  toolApprovalModes: Record<string, 'auto' | 'prompt' | 'approve'>;
}

export interface UseMcpServerFormOptions {
  onSuccess?: (savedServer?: SavedMcpServer) => void;
  onError?: (error: Error, attemptedServer?: { name: string }) => void;
  onSaveComplete?: () => void;
}

export interface SavedMcpServer {
  serverId: string;
  name: string;
}

export function useMcpServerForm(options: UseMcpServerFormOptions = {}) {
  "use no memo";

  const [isAdding, setIsAdding] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formState, setFormState] = useState<McpServerFormState>({
    name: '',
    transport: 'stdio',
    command: '',
    args: '',
    url: '',
    env: '',
    headers: '',
    defaultToolsApprovalMode: 'prompt',
    toolApprovalModes: {},
  });

  const toHeaderString = (headers?: Record<string, string>): string => {
    if (!headers) return '';
    return Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
  };

  const resetForm = () => {
    setFormState({
      name: '',
      transport: 'stdio',
      command: '',
      args: '',
      url: '',
      env: '',
      headers: '',
      defaultToolsApprovalMode: 'prompt',
      toolApprovalModes: {},
    });
    setIsAdding(false);
    setEditingServerId(null);
  };

  const updateField = <K extends keyof McpServerFormState>(
    field: K,
    value: McpServerFormState[K]
  ) => {
    setFormState((prev) => ({ ...prev, [field]: value }));
  };

  const saveServer = async (): Promise<boolean> => {
    if (!formState.name.trim()) return false;

    setIsSaving(true);
    try {
      let savedServerId = editingServerId;

      // Parse env vars from KEY=VALUE format (one per line)
      const envObj: Record<string, string> = {};
      if (formState.transport === 'stdio' && formState.env.trim()) {
        formState.env.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed && trimmed.includes('=')) {
            const eqIndex = trimmed.indexOf('=');
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            if (key) {
              envObj[key] = value;
            }
          }
        });
      }

      // Parse headers from "Header: Value" format (one per line)
      const headersObj: Record<string, string> = {};
      if ((formState.transport === 'http' || formState.transport === 'sse') && formState.headers.trim()) {
        formState.headers.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (!trimmed) return;

          const colonIndex = trimmed.indexOf(':');
          const eqIndex = trimmed.indexOf('=');
          const splitIndex = colonIndex >= 0 ? colonIndex : eqIndex;
          if (splitIndex < 0) return;

          const key = trimmed.slice(0, splitIndex).trim();
          const value = trimmed.slice(splitIndex + 1).trim();
          if (key) {
            headersObj[key] = value;
          }
        });
      }

      const config: ToolServerConfig = {
        name: formState.name,
        transport: formState.transport,
        enabled: true,
        defaultToolsApprovalMode: formState.defaultToolsApprovalMode,
        tools: Object.fromEntries(
          Object.entries(formState.toolApprovalModes).map(([toolName, approvalMode]) => [
            toolName,
            { approvalMode },
          ]),
        ),
        ...(formState.transport === 'stdio'
          ? {
              command: formState.command,
              args: formState.args.split(' ').filter(Boolean),
              ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}),
            }
          : {}),
        ...(formState.transport === 'http' || formState.transport === 'sse'
          ? {
              url: formState.url,
              ...(Object.keys(headersObj).length > 0 ? { headers: headersObj } : {}),
            }
          : {}),
        ...(formState.transport === 'websocket' ? { wsUrl: formState.url } : {}),
      };

      if (editingServerId) {
        // Update existing server
        await updateToolServer(editingServerId, config);
      } else {
        // Add new server
        const result = await addToolServer(config);
        savedServerId = result.serverId;
        trackSkillInstalled({ skillId: formState.name, source: 'manual' });
      }

      options.onSuccess?.(
        savedServerId ? { serverId: savedServerId, name: formState.name.trim() || savedServerId } : undefined,
      );
      resetForm();
      options.onSaveComplete?.();
      return true;
    } catch (error) {
      console.error('Failed to save MCP server:', error);
      if (!editingServerId) {
        trackSkillInstallFailed({
          skillId: formState.name,
          source: 'manual',
          error: error instanceof Error ? error.message : String(error),
          stage: 'add_tool',
        });
      }
      options.onError?.(error as Error, { name: formState.name.trim() || 'This' });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const startAdding = () => setIsAdding(true);
  const cancelAdding = () => resetForm();

  // Start editing an existing server
  const startEditing = (server: ToolServer) => {
    const config = server.config as any;
    if (!config) return;

    // Convert env object to KEY=VALUE string format
    let envString = '';
    if (config.env) {
      envString = Object.entries(config.env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    }

    setFormState({
      name: server.name,
      transport: (config.transport as McpTransportType) || 'stdio',
      command: config.command || '',
      args: Array.isArray(config.args) ? config.args.join(' ') : '',
      url: config.url || '',
      env: envString,
      headers: toHeaderString(config.headers),
      defaultToolsApprovalMode: config.defaultToolsApprovalMode ?? 'prompt',
      toolApprovalModes: Object.fromEntries(
        Object.entries(config.tools ?? {}).flatMap(([toolName, toolConfig]: [string, any]) => {
          const mode = toolConfig?.approvalMode ?? toolConfig?.approval_mode;
          return mode === 'auto' || mode === 'prompt' || mode === 'approve'
            ? [[toolName, mode]]
            : [];
        }),
      ),
    });
    setEditingServerId(server.id);
    setIsAdding(true);
  };

  // Start adding with prefilled config (e.g., from MCP Store)
  const startAddingWithConfig = (config: {
    name: string;
    transport: McpTransportType;
    url?: string;
    headers?: Record<string, string>;
  }) => {
    setFormState({
      name: config.name,
      transport: config.transport,
      command: '',
      args: '',
      url: config.url || '',
      env: '',
      headers: toHeaderString(config.headers),
      defaultToolsApprovalMode: 'prompt',
      toolApprovalModes: {},
    });
    setEditingServerId(null);
    setIsAdding(true);
  };

  return {
    // State
    isAdding,
    isEditing: !!editingServerId,
    editingServerId,
    isSaving,
    formState,
    // Actions
    startAdding,
    startEditing,
    cancelAdding,
    resetForm,
    updateField,
    saveServer,
    // Convenience setters
    setName: (value: string) => updateField('name', value),
    setTransport: (value: McpTransportType) => updateField('transport', value),
    setCommand: (value: string) => updateField('command', value),
    setArgs: (value: string) => updateField('args', value),
    setUrl: (value: string) => updateField('url', value),
    setEnv: (value: string) => updateField('env', value),
    setHeaders: (value: string) => updateField('headers', value),
    setDefaultToolsApprovalMode: (value: 'auto' | 'prompt' | 'approve') => updateField('defaultToolsApprovalMode', value),
    setToolApprovalMode: (toolName: string, value: 'auto' | 'prompt' | 'approve') => {
      setFormState((prev) => ({
        ...prev,
        toolApprovalModes: {
          ...prev.toolApprovalModes,
          [toolName]: value,
        },
      }));
    },
    startAddingWithConfig,
  };
}
