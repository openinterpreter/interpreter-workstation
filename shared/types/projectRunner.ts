export type RunnableProjectKind = 'node-web-app';
export type RunnableProjectRunScript = 'dev' | 'start';

export interface RunnableProjectMetadata {
  kind: RunnableProjectKind;
  runScript: RunnableProjectRunScript;
}

export type ProjectRunnerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface ProjectRunnerState {
  projectPath: string;
  status: ProjectRunnerStatus;
  url?: string;
  error?: string;
}
