export function getSelectionRangeWithoutExtension(filename: string): { start: number; end: number } {
  const lastDot = filename.lastIndexOf('.');
  return { start: 0, end: lastDot > 0 ? lastDot : filename.length };
}

export function generateDuplicateName(basename: string, extension: string, existingNames: string[]): string {
  let copyNum = 0;
  let newName: string;
  do {
    const suffix = copyNum === 0 ? ' copy' : ` copy ${copyNum + 1}`;
    newName = `${basename}${suffix}${extension}`;
    copyNum++;
  } while (existingNames.includes(newName));
  return newName;
}
