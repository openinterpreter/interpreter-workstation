export function shouldKeepAppResident(): boolean {
  return true;
}

type DestroyableTrayLike = {
  destroy: () => void;
  isDestroyed?: () => boolean;
};

function isDestroyedTrayError(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'Object has been destroyed';
}

export function destroyTraySafely<T extends DestroyableTrayLike>(
  tray: T | null,
  logger: Pick<Console, 'warn'> = console,
): null {
  if (!tray) {
    return null;
  }

  if (typeof tray.isDestroyed === 'function' && tray.isDestroyed()) {
    return null;
  }

  try {
    tray.destroy();
  } catch (error) {
    if (!isDestroyedTrayError(error)) {
      throw error;
    }
    logger.warn('[Main] Tray already destroyed during cleanup');
  }

  return null;
}
