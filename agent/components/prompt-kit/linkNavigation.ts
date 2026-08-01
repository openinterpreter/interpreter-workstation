import { resolveLocalLinkTarget, type ResolvedLocalLinkTarget } from '../../../src/utils/localLinkDetection';

export type LinkNavigationAction =
  | { type: 'none' }
  | { type: 'open-local'; target: ResolvedLocalLinkTarget }
  | { type: 'open-external'; url: string };

export function resolveLinkNavigationAction(href?: string): LinkNavigationAction {
  if (!href) {
    return { type: 'none' };
  }

  const target = resolveLocalLinkTarget(href);
  if (target) {
    return {
      type: 'open-local',
      target,
    };
  }

  return {
    type: 'open-external',
    url: href,
  };
}
