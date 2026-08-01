export function formatAddModelsLabel(selectedCount: number): string {
  if (selectedCount === 1) {
    return 'Add 1 model';
  }
  return `Add ${selectedCount} models`;
}
