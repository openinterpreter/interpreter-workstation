export const DRAG_AUTO_EXPAND_DELAY = 600;

export class DragAutoExpandTimer {
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private dragCounter = 0;
  private onExpand: (() => void) | null = null;

  start(onExpand: () => void): void {
    this.dragCounter++;
    if (this.timerId) return;
    this.onExpand = onExpand;
    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.onExpand?.();
      this.clear();
    }, DRAG_AUTO_EXPAND_DELAY);
  }

  leave(): void {
    this.dragCounter--;
    if (this.dragCounter <= 0) {
      this.clear();
    }
  }

  clear(): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.dragCounter = 0;
    this.onExpand = null;
  }

  get isRunning(): boolean {
    return this.timerId !== null;
  }

  get counter(): number {
    return this.dragCounter;
  }
}
