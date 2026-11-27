/** Stable, non-diagnostic categories for user-facing Simple interface recovery. */
export type SimpleInterfaceProblemKind =
  | 'project-code'
  | 'bundled-runtime-missing'
  | 'bundled-runtime-incompatible'
  | 'dependency-install'
  | 'project-start';

export function isSimpleInterfaceProblemKind(value: unknown): value is SimpleInterfaceProblemKind {
  return value === 'project-code' || value === 'bundled-runtime-missing'
    || value === 'bundled-runtime-incompatible' || value === 'dependency-install'
    || value === 'project-start';
}

/** Process stdout/stderr is project-controlled; it cannot attest a compiler error. */
export function classifySimpleProjectDiagnostic(_diagnostic: string): SimpleInterfaceProblemKind {
  return 'project-start';
}

/** The installation path emits these known errors; everything else is a start failure. */
export function classifySimpleProjectStartError(error: unknown): SimpleInterfaceProblemKind | null {
  const message = error instanceof Error ? error.message : '';
  if (message === 'The bundled Simple interface runtime is missing. Reinstall or rebuild Interpreter.')
    return 'bundled-runtime-missing';
  if (message.startsWith('The bundled Simple interface runtime is for ')
      && message.includes(', not ')) return 'bundled-runtime-incompatible';
  if (message === 'The bundled Simple interface runtime could not be installed completely.'
      || message === 'The interface project dependencies could not be installed.'
      || message === 'This project uses custom core package versions. Install its dependencies in the project before starting it.')
    return 'dependency-install';
  return null;
}
