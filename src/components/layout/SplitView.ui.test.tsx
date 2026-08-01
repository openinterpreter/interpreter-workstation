import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SplitView } from './SplitView';

function setRect(element: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}

describe('SplitView', () => {
  test('emits resize lifecycle events and ratio updates for horizontal drags', () => {
    const onRatioChange = vi.fn();
    const prepare = vi.fn();
    const start = vi.fn();
    const end = vi.fn();

    window.addEventListener('layout:resize-prepare', prepare);
    window.addEventListener('layout:resize-start', start);
    window.addEventListener('layout:resize-end', end);

    render(
      <SplitView
        node={{
          kind: 'split',
          id: 'split-1',
          direction: 'horizontal',
          ratio: 0.5,
          children: [
            { kind: 'pane', id: 'left', tabIds: ['a'], activeTabId: 'a' },
            { kind: 'pane', id: 'right', tabIds: ['b'], activeTabId: 'b' },
          ],
        }}
        onRatioChange={onRatioChange}
      >
        <div>left</div>
        <div>right</div>
      </SplitView>,
    );

    const container = screen.getByTestId('split-view-split-1');
    const handle = screen.getByTestId('split-handle-split-1');
    setRect(container, { left: 20, top: 10, width: 200, height: 100 });

    fireEvent.mouseDown(handle, { clientX: 120, clientY: 40 });
    fireEvent.mouseMove(document, { clientX: 170, clientY: 40 });
    fireEvent.mouseUp(document);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(onRatioChange).toHaveBeenCalledWith('split-1', 0.75);

    window.removeEventListener('layout:resize-prepare', prepare);
    window.removeEventListener('layout:resize-start', start);
    window.removeEventListener('layout:resize-end', end);
  });

  test('clamps vertical drags to the supported ratio range', () => {
    const onRatioChange = vi.fn();

    render(
      <SplitView
        node={{
          kind: 'split',
          id: 'split-2',
          direction: 'vertical',
          ratio: 0.5,
          children: [
            { kind: 'pane', id: 'top', tabIds: ['a'], activeTabId: 'a' },
            { kind: 'pane', id: 'bottom', tabIds: ['b'], activeTabId: 'b' },
          ],
        }}
        onRatioChange={onRatioChange}
      >
        <div>top</div>
        <div>bottom</div>
      </SplitView>,
    );

    const container = screen.getByTestId('split-view-split-2');
    const handle = screen.getByTestId('split-handle-split-2');
    setRect(container, { left: 0, top: 0, width: 120, height: 100 });

    fireEvent.mouseDown(handle, { clientX: 20, clientY: 50 });
    fireEvent.mouseMove(document, { clientX: 20, clientY: 500 });
    fireEvent.mouseUp(document);

    expect(onRatioChange).toHaveBeenCalledWith('split-2', 0.9);
  });
});
