import { describe, expect, test } from 'vitest';
import { classifySimpleProjectDiagnostic, classifySimpleProjectStartError, isSimpleInterfaceProblemKind } from './simpleInterfaceProblem';

describe('Simple project recovery category', () => {
  test('does not trust App.jsx syntax or compiler-shaped text from project stdout', () => {
    expect(classifySimpleProjectDiagnostic('App.jsx:4: Unexpected token /private/alice token=secret')).toBe('project-start');
    expect(classifySimpleProjectDiagnostic('shopping list: Failed to compile, Module build failed')).toBe('project-start');
    expect(classifySimpleProjectDiagnostic('The project dev server failed to start.')).toBe('project-start');
  });

  test('classifies known bundled runtime missing and wrong architecture failures', () => {
    expect(classifySimpleProjectStartError(new Error('The bundled Simple interface runtime is missing. Reinstall or rebuild Interpreter.'))).toBe('bundled-runtime-missing');
    expect(classifySimpleProjectStartError(new Error('The bundled Simple interface runtime is for darwin-arm64, not darwin-x64.'))).toBe('bundled-runtime-incompatible');
    expect(classifySimpleProjectStartError(new Error('The bundled Simple interface runtime could not be installed completely.'))).toBe('dependency-install');
    expect(classifySimpleProjectStartError(new Error('secret /private/alice'))).toBeNull();
  });

  test('rejects arbitrary server error categories', () => {
    expect(isSimpleInterfaceProblemKind('/private/alice')).toBe(false);
    expect(isSimpleInterfaceProblemKind('bundled-runtime-missing')).toBe(true);
  });
});
