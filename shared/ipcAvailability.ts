/**
 * Distinguishes "this host does not provide the operation" from "the
 * operation ran and failed".
 *
 * The renderer runs in Electron and in browser hosts. A host can lack an IPC
 * operation, for example a static page or relay that serves the renderer
 * without the Workstation `/api/ipc` endpoints. Features treat that as an
 * absent capability (render nothing, use an empty list); they keep reporting
 * every other error as a failure.
 */

/** Error code returned by `/api/ipc` when a namespace or method does not exist. */
export const IPC_UNAVAILABLE_CODE = 'ipc_unavailable';

export class IpcUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`${operation} is not available in this environment.`);
    this.name = 'IpcUnavailableError';
    this.operation = operation;
  }
}

export function isIpcUnavailableError(error: unknown): error is IpcUnavailableError {
  return error instanceof IpcUnavailableError;
}

/**
 * Classify a failed `/api/ipc/:namespace/:method` HTTP response.
 *
 * `body` is the parsed JSON body, or `null` when the response was not JSON.
 * The operation is unavailable when the Workstation router reports an unknown
 * namespace or method, or when the host answered 404/405 without the router's
 * JSON contract, meaning no IPC endpoint is mounted at that address. Errors
 * thrown by an existing handler always carry a JSON body without this code.
 */
export function isIpcUnavailableResponse(status: number, body: unknown): boolean {
  if (body === null) return status === 404 || status === 405;
  return status === 404
    && typeof body === 'object'
    && (body as { code?: unknown }).code === IPC_UNAVAILABLE_CODE;
}
