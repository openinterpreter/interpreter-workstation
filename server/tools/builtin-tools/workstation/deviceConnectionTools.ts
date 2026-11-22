/**
 * Connect a device tools.
 *
 * A paired device (first a phone's web browser) opens this Workstation's
 * normal interface against the same backend and conversation. These tools
 * share their implementation with the HTTP/IPC bridge.
 */
import type { BuiltinToolDefinition } from '../../builtinTools';
import type { ToolCallResponse } from '../../toolTypes';
import {
  createDeviceConnection,
  listDeviceConnections,
  revokeDeviceConnection,
} from '../../../handlers/deviceConnections';

function result(value: unknown): ToolCallResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false };
}

function failure(prefix: string, error: unknown): ToolCallResponse {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `${prefix}: ${message}` }], isError: true };
}

export const deviceConnectionCreateTool: BuiltinToolDefinition = {
  name: 'interpreter_device_connection_create',
  description:
    'Create a one-time link and QR code that connects another device, such as a phone\'s web browser, to this Workstation. '
    + 'The device opens the same interface and conversation with the same read-write access as the person at this computer; '
    + 'no sign-in or network setup is needed on the device. The link works once and expires after 10 minutes. '
    + 'Give the link or QR code only to the person who asked to connect their own device. '
    + 'Returns `link`, `expiresAt`, `qrSvgPath` (an SVG file of the QR code), and `qrSvg` (the same SVG text).',
  inputSchema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'A short name for the device, shown in the device list and on its messages (for example "Phone"). Defaults to "Phone".',
      },
      kind: {
        type: 'string',
        enum: ['web'],
        description: 'The kind of client. `web` is a web browser. Defaults to `web`.',
      },
    },
    required: [],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  handler: async (args) => {
    try {
      return result(await createDeviceConnection({ label: args?.label, kind: args?.kind }));
    } catch (error) {
      return failure('Could not create a device link', error);
    }
  },
};

export const deviceConnectionsListTool: BuiltinToolDefinition = {
  name: 'interpreter_device_connections_list',
  description:
    'List devices connected to this Workstation with their id, label, kind, creation time, and last activity. '
    + '`available` reports whether new devices can be connected on this host.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async () => {
    try {
      return result(await listDeviceConnections());
    } catch (error) {
      return failure('Could not list connected devices', error);
    }
  },
};

export const deviceConnectionRevokeTool: BuiltinToolDefinition = {
  name: 'interpreter_device_connection_revoke',
  description:
    'Disconnect a device from this Workstation by id (from interpreter_device_connections_list). '
    + 'Its next request is refused, including its interface preview; it must be connected again with a new link.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The device id.' },
    },
    required: ['id'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
  handler: async (args) => {
    try {
      return result(await revokeDeviceConnection(args?.id));
    } catch (error) {
      return failure('Could not disconnect the device', error);
    }
  },
};
