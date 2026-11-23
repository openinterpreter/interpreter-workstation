/** Union the desktop and browser-backend production license inventories. */
export const productionLicenseFilters = ['.', '@openinterpreter/browser-agent-core'];

export function mergeLicenseInventories(inventories) {
  const merged = {};
  const seen = new Set();
  for (const inventory of inventories) {
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) || inventory.error)
      throw new Error('Production license inventory unavailable');
    for (const [license, packages] of Object.entries(inventory)) {
      if (!Array.isArray(packages)) throw new Error('Invalid production license inventory');
      for (const entry of packages) {
        if (!Array.isArray(entry.versions)) throw new Error('Invalid production license entry');
        for (const version of entry.versions) {
          const key = JSON.stringify([license, entry.name, version]);
          if (seen.has(key)) continue;
          seen.add(key);
          (merged[license] ??= []).push({ ...entry, versions: [version] });
        }
      }
    }
  }
  return merged;
}
