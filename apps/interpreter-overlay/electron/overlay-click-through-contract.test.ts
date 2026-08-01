import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

function readContractSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

function readOverlayService(): string {
  return readContractSource(path.join(import.meta.dir, 'service.ts'));
}

function readRendererOverlay(): string {
  return readContractSource(path.join(import.meta.dir, '../renderer/overlay.tsx'));
}

function readInputPanel(): string {
  return readContractSource(path.join(import.meta.dir, '../renderer/InputPanel.tsx'));
}

function extractMethod(source: string, methodName: string): string {
  const methodStart = source.indexOf(methodName);
  expect(methodStart).toBeGreaterThanOrEqual(0);
  const methodEnd = source.indexOf('\n  private ', methodStart + 1);
  expect(methodEnd).toBeGreaterThan(methodStart);
  return source.slice(methodStart, methodEnd);
}

describe('overlay click-through contract', () => {
  test('does not enable full-window mouse capture when a global scope drag starts', () => {
    const serviceSource = readOverlayService();
    const mouseDownMethod = extractMethod(serviceSource, 'private handleGlobalMouseDown');
    const gestureStart = mouseDownMethod.indexOf('this.globalScopeGesture = {');
    const gestureLog = mouseDownMethod.indexOf("console.log('[InterpreterOverlay] global scope selection started'");
    expect(gestureStart).toBeGreaterThanOrEqual(0);
    expect(gestureLog).toBeGreaterThan(gestureStart);

    const gestureStartBlock = mouseDownMethod.slice(gestureStart, gestureLog);
    expect(gestureStartBlock).not.toContain('enableMouseEvents');
    expect(gestureStartBlock).not.toContain('setFocusable(true)');
  });

  test('does not make the whole overlay window clickable in input mode', () => {
    const rendererSource = readRendererOverlay();
    expect(rendererSource).not.toContain("if (state.mode === 'input') {\n      window.overlay.setIgnoreMouse(false);");
    expect(rendererSource).toContain("window.overlay.setIgnoreMouse(true, { forward: true });");
    expect(rendererSource).toContain("window.overlay.setIgnoreMouse(!interactive, { forward: true });");
    const moveHandlerStart = rendererSource.indexOf('const onMove = (event: MouseEvent) => {');
    expect(moveHandlerStart).toBeGreaterThanOrEqual(0);
    const moveHandlerEnd = rendererSource.indexOf('document.addEventListener(\'mousemove\', onMove);', moveHandlerStart);
    expect(moveHandlerEnd).toBeGreaterThan(moveHandlerStart);
    const moveHandler = rendererSource.slice(moveHandlerStart, moveHandlerEnd);
    expect(moveHandler).not.toContain("'[data-overlay-context-chip-id]'");
    expect(moveHandler).not.toContain("'[data-overlay-context-chip-remove-id]'");

    const inputPanelSource = readInputPanel();
    const chipStart = inputPanelSource.indexOf('data-overlay-context-chip-id={attachmentId}');
    expect(chipStart).toBeGreaterThanOrEqual(0);
    const chipEnd = inputPanelSource.indexOf('className={`composer-attachment-chip', chipStart);
    expect(chipEnd).toBeGreaterThan(chipStart);
    expect(inputPanelSource.slice(chipStart, chipEnd)).not.toContain('data-interactive');
  });

  test('keeps window mouse capture for the whole drag when it begins over an interactive control', () => {
    const rendererSource = readRendererOverlay();
    const moveHandlerStart = rendererSource.indexOf('const onMove = (event: MouseEvent) => {');
    expect(moveHandlerStart).toBeGreaterThanOrEqual(0);
    const interactiveLookup = rendererSource.indexOf('const interactive = isInteractiveTarget(event.target);', moveHandlerStart);
    expect(interactiveLookup).toBeGreaterThan(moveHandlerStart);

    // While a mouse button is down the renderer must not force click-through:
    // a drag that started over the input panel keeps capture for text
    // selection, and a service-captured region drag must not be released
    // mid-drag by hover logic.
    const beforeInteractiveLookup = rendererSource.slice(moveHandlerStart, interactiveLookup);
    expect(beforeInteractiveLookup).toContain('if (event.buttons !== 0) {');
    expect(beforeInteractiveLookup).toContain('if (interactiveDragActive) {');
    expect(beforeInteractiveLookup).toContain('window.overlay.setIgnoreMouse(false);');
    expect(beforeInteractiveLookup).not.toContain("window.overlay.setIgnoreMouse(true, { forward: true });");
    expect(beforeInteractiveLookup).toContain('return;');

    // Interactive drags are only recognized from a primary-button mousedown
    // on an interactive target, and end on mouseup.
    const effectStart = rendererSource.lastIndexOf('let interactiveDragActive = false;', moveHandlerStart);
    expect(effectStart).toBeGreaterThanOrEqual(0);
    const downHandler = rendererSource.slice(effectStart, moveHandlerStart);
    expect(downHandler).toContain("if (event.button === 0 && isInteractiveTarget(event.target)) {");
    expect(downHandler).toContain('interactiveDragActive = true;');
    expect(rendererSource).toContain("document.addEventListener('mouseup', onMouseUp, true);");
  });

  test('captures the mouse only after a region drag crosses the threshold, never on mousedown', () => {
    const serviceSource = readOverlayService();
    const mouseDownMethod = extractMethod(serviceSource, 'private handleGlobalMouseDown');
    expect(mouseDownMethod).not.toContain('enableMouseEvents');

    const mouseMoveMethod = extractMethod(serviceSource, 'private handleGlobalMouseMove');
    const thresholdCheck = mouseMoveMethod.indexOf('REGION_DRAG_CAPTURE_THRESHOLD_DIP');
    const captureCall = mouseMoveMethod.indexOf('this.overlay.enableMouseEvents();');
    expect(thresholdCheck).toBeGreaterThanOrEqual(0);
    expect(captureCall).toBeGreaterThan(thresholdCheck);
    expect(mouseMoveMethod).toContain('!this.regionDragCaptureActive');
    expect(mouseMoveMethod).toContain('this.regionDragCaptureActive = true;');
  });

  test('restores click-through after a captured region drag ends, on every path', () => {
    const serviceSource = readOverlayService();

    // releaseRegionDragCapture is the single restore point.
    const releaseMethod = extractMethod(serviceSource, 'private releaseRegionDragCapture');
    expect(releaseMethod).toContain('this.regionDragCaptureActive = false;');
    expect(releaseMethod).toContain('this.overlay.disableMouseEvents();');

    // Mouseup releases before any early return, so weird-button or mode-exit
    // mouseups can never leave the overlay captured.
    const mouseUpMethod = extractMethod(serviceSource, 'private handleGlobalMouseUp');
    const releaseIndex = mouseUpMethod.indexOf('this.releaseRegionDragCapture();');
    const firstReturn = mouseUpMethod.indexOf('return;');
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(firstReturn).toBeGreaterThan(releaseIndex);

    // Stale-gesture cleanup releases too.
    const timeoutMethod = extractMethod(serviceSource, 'private scheduleGlobalScopeGestureTimeout');
    expect(timeoutMethod).toContain('this.releaseRegionDragCapture();');

    // Leaving input mode via any state send drops the capture flag, and
    // unrelated sends during a captured drag must not drop capture mid-drag.
    const sendMethod = extractMethod(serviceSource, 'private send');
    expect(sendMethod).toContain('if (this.regionDragCaptureActive && !isInputMode) {');
    expect(sendMethod).toContain('if (!this.regionDragCaptureActive) {');
  });

  test('keeps scope visuals click-through while only edit affordances opt into capture', () => {
    const rendererSource = readRendererOverlay();
    const stylesSource = readContractSource(path.join(import.meta.dir, '../renderer/styles.css'));
    const sheenSource = readContractSource(path.join(import.meta.dir, '../renderer/ScopeSelectionSheen.tsx'));

    expect(stylesSource).toContain('.scope-selection-layer {\n  position: fixed;\n  inset: 0;\n  pointer-events: none;');
    expect(stylesSource).toContain('.scope-selection-surface {\n  position: absolute;\n  pointer-events: none;');
    expect(stylesSource).toContain('.scope-selection-thinking-layer,\n.scope-selection-thinking-wash,');
    expect(stylesSource).toContain('.scope-selection-thinking-svg {\n  position: absolute;');
    expect(stylesSource).toContain('pointer-events: none;');
    expect(sheenSource).not.toContain('data-interactive');

    const moveHitTarget = rendererSource.indexOf('className="scope-selection-move-hit-target"');
    const movePointerDown = rendererSource.indexOf('onPointerDown={handleScopeMovePointerDown}', moveHitTarget);
    expect(moveHitTarget).toBeGreaterThanOrEqual(0);
    expect(rendererSource.slice(moveHitTarget, movePointerDown)).toContain('data-interactive');

    const resizeHandle = rendererSource.indexOf('className={`scope-selection-handle scope-selection-handle-${handle}`}');
    const resizePointerDown = rendererSource.indexOf('onPointerDown={handleScopeResizePointerDown(handle)}', resizeHandle);
    expect(resizeHandle).toBeGreaterThanOrEqual(0);
    expect(rendererSource.slice(resizeHandle, resizePointerDown)).toContain('data-interactive');
  });

  test('captures the mouse for the open input surface and restores click-through outside it', () => {
    const serviceSource = readOverlayService();
    const sendMethod = extractMethod(serviceSource, 'private send');
    const focusLine = sendMethod.indexOf('this.overlay.setFocusable(isInputMode);');
    const visibilityLine = sendMethod.indexOf('this.syncProgressiveBlurVisibility();');
    expect(focusLine).toBeGreaterThanOrEqual(0);
    expect(visibilityLine).toBeGreaterThan(focusLine);

    // Input mode owns the mouse so a region drag can never leak a system
    // text-selection drag into the app underneath (macOS routes the whole
    // drag session to whichever app received the initial mousedown). Every
    // non-input render without an in-flight captured drag must restore
    // click-through.
    const mouseStateBlock = sendMethod.slice(focusLine, visibilityLine);
    expect(mouseStateBlock).toContain('if (isInputMode) {\n      this.overlay.enableMouseEvents();');
    expect(mouseStateBlock).toContain('} else if (!this.regionDragCaptureActive) {\n      this.overlay.disableMouseEvents();');
  });

  test('does not enable full-window mouse capture when a global scope drag commits', () => {
    const serviceSource = readOverlayService();
    const mouseUpMethod = extractMethod(serviceSource, 'private handleGlobalMouseUp');
    expect(mouseUpMethod).not.toContain('enableMouseEvents');
  });

  test('debug reset disables mouse capture before hiding the overlay', () => {
    const serviceSource = readOverlayService();
    const resetStart = serviceSource.indexOf('forceResetForDebug(');
    const resetEnd = serviceSource.indexOf('  removeInputOverlayContextItemForDebug', resetStart);
    expect(resetStart).toBeGreaterThanOrEqual(0);
    expect(resetEnd).toBeGreaterThan(resetStart);

    const resetMethod = serviceSource.slice(resetStart, resetEnd);
    const disableIndex = resetMethod.indexOf('this.overlay.disableMouseEvents();');
    const hideIndex = resetMethod.indexOf('this.overlay.hide();');
    expect(disableIndex).toBeGreaterThanOrEqual(0);
    expect(hideIndex).toBeGreaterThan(disableIndex);
  });
});
