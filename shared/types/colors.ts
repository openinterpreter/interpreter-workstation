/**
 * Primary color definitions - SINGLE SOURCE OF TRUTH
 *
 * All color validation, UI options, and CSS values should reference this file.
 */

// Valid primary color IDs
export const PRIMARY_COLOR_IDS = ['gray', 'blue', 'purple', 'pink', 'red', 'orange', 'green', 'teal'] as const;
export type PrimaryColorId = typeof PRIMARY_COLOR_IDS[number];

// UI display options (for settings panels)
export const PRIMARY_COLORS = [
  { id: 'gray' as const, label: 'Gray', color: '#404040' },
  { id: 'blue' as const, label: 'Blue', color: '#3b82f6' },
  { id: 'purple' as const, label: 'Purple', color: '#8b5cf6' },
  { id: 'pink' as const, label: 'Pink', color: '#ec4899' },
  { id: 'red' as const, label: 'Red', color: '#ef4444' },
  { id: 'orange' as const, label: 'Orange', color: '#f97316' },
  { id: 'green' as const, label: 'Green', color: '#22c55e' },
  { id: 'teal' as const, label: 'Teal', color: '#14b8a6' },
] as const;

// CSS values for each color (OKLCH format for light/dark modes)
export const PRIMARY_COLOR_VALUES: Record<PrimaryColorId, { light: string; dark: string; foreground: string }> = {
  gray: {
    light: 'oklch(0.27 0 0)',
    dark: 'oklch(0.50 0 0)',
    foreground: 'oklch(0.98 0 0)',
  },
  blue: {
    light: 'oklch(0.488 0.243 264.376)',
    dark: 'oklch(0.42 0.18 266)',
    foreground: 'oklch(0.97 0.014 254.604)',
  },
  purple: {
    light: 'oklch(0.553 0.235 303.4)',
    dark: 'oklch(0.48 0.2 303)',
    foreground: 'oklch(0.98 0.01 303)',
  },
  pink: {
    light: 'oklch(0.592 0.249 0.584)',
    dark: 'oklch(0.52 0.22 0)',
    foreground: 'oklch(0.98 0.01 0)',
  },
  red: {
    light: 'oklch(0.577 0.245 27.325)',
    dark: 'oklch(0.52 0.22 27)',
    foreground: 'oklch(0.98 0.01 27)',
  },
  orange: {
    light: 'oklch(0.646 0.222 41.116)',
    dark: 'oklch(0.56 0.2 41)',
    foreground: 'oklch(0.98 0.01 41)',
  },
  green: {
    light: 'oklch(0.627 0.194 149.214)',
    dark: 'oklch(0.52 0.17 149)',
    foreground: 'oklch(0.98 0.01 149)',
  },
  teal: {
    light: 'oklch(0.6 0.15 180)',
    dark: 'oklch(0.5 0.13 180)',
    foreground: 'oklch(0.98 0.01 180)',
  },
};

/**
 * Check if a string is a valid primary color ID
 */
export function isValidPrimaryColor(color: string): color is PrimaryColorId {
  return PRIMARY_COLOR_IDS.includes(color as PrimaryColorId);
}
