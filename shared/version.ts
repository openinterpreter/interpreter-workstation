import { publicVersion } from '../package.json';

/**
 * Canonical user-facing app version.
 *
 * Sourced from `publicVersion` in package.json, which the prod release pipeline
 * bumps (.github/scripts/bump-public-version.py) and CI also copies into the
 * `version` field at build time (scripts/ci/set-version.ts). Using `publicVersion`
 * directly keeps the displayed version correct in dev too, where `app.getVersion()`
 * falls back to the Electron framework version.
 *
 * Inlined at build time by both esbuild (main process) and Vite (renderer), so the
 * About panel and in-app version label always agree.
 */
export const APP_VERSION: string = publicVersion;
