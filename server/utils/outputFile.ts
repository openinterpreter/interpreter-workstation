import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

export async function getDestinationConflictError(outputPath: string): Promise<string | null> {
  try {
    await access(outputPath, constants.F_OK);
    return `Error: Destination already exists: ${outputPath}. Choose a new output path.`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
