import type { CSSProperties, SVGProps } from 'react';
import { ACTIVE_BRAND } from '../shared/branding';

function InterpreterSymbolMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 29 123" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <circle cx="14.5" cy="14.5" r="14.5" fill="currentColor" />
      <rect y="41" width="29" height="82" rx="14.5" fill="currentColor" />
    </svg>
  );
}

function InterpreterWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 232 64" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <g fill="currentColor">
        <circle cx="16" cy="12" r="8" />
        <rect x="8" y="28" width="16" height="28" rx="8" />
        <text
          x="38"
          y="43"
          fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          fontSize="32"
          fontWeight="700"
          letterSpacing="0"
        >
          Interpreter
        </text>
      </g>
    </svg>
  );
}

export const ACTIVE_APP_BRAND = {
  ...ACTIVE_BRAND,
  SidebarMark: InterpreterWordmark,
  SymbolMark: InterpreterSymbolMark,
} as const;

export function getAppBrandStyle(): CSSProperties {
  return {
    color: 'var(--brand-logo-color)',
    opacity: 'var(--brand-logo-opacity)',
  };
}

export function applyAppBrand(root: HTMLElement, brand = ACTIVE_APP_BRAND): void {
  root.dataset.appBrand = brand.id;
  root.style.setProperty('--brand-accent', brand.accent);
  root.style.setProperty('--brand-accent-foreground', brand.accentForeground);
  root.style.setProperty('--brand-logo-color', brand.logoColor);
}

export function clearAppBrand(root: HTMLElement, brand = ACTIVE_APP_BRAND): void {
  if (root.dataset.appBrand === brand.id) {
    delete root.dataset.appBrand;
  }
  root.style.removeProperty('--brand-accent');
  root.style.removeProperty('--brand-accent-foreground');
  root.style.removeProperty('--brand-logo-color');
}
