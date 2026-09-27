import { existsSync, readFileSync, statSync } from 'node:fs';
import { validateOutcome, type OpaqueOutcome } from '../../tests/opaque-outcome-reporter';

export function annotationForOutcome(value: unknown): string {
  validateOutcome(value);
  // This notice is produced exclusively from a closed, validated schema.
  // Never pass raw Playwright errors, titles, paths, or logs to Actions annotations.
  return `::notice title=E2E_OUTCOME_V1::${JSON.stringify(value satisfies OpaqueOutcome)}`;
}

if (process.argv[1]?.endsWith('emit-e2e-outcome.ts')) {
  const file = process.env.INTERPRETER_E2E_OUTCOME_FILE;
  if (!file || !existsSync(file)) {
    process.stdout.write('::notice title=E2E_OUTCOME_V1::{"schema":1,"artifactAvailable":false}\n');
  } else {
    try {
      if (statSync(file).size > 8192) throw new Error('Artifact too large');
      const outcome = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      process.stdout.write(`${annotationForOutcome(outcome)}\n`);
    } catch {
      // Never render a parser exception: it may quote invalid artifact bytes.
      process.stdout.write('::error title=E2E_OUTCOME_INVALID::Schema validation failed\n');
      process.exitCode = 1;
    }
  }
}
