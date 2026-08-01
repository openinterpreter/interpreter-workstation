const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

let backgroundWindow = null;
let infoWindow = null;
let formWindow = null;
let submitted = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function waitForWindowReady(role) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('form-test-window-ready', handleReady);
      reject(new Error(`Timed out waiting for ${role} renderer`));
    }, 5000);

    function handleReady(_event, payload) {
      if (payload !== role) {
        return;
      }
      clearTimeout(timeout);
      ipcMain.removeListener('form-test-window-ready', handleReady);
      resolve();
    }

    ipcMain.on('form-test-window-ready', handleReady);
  });
}

function computeFallbackLayout(display) {
  const { width, height } = display.workAreaSize;
  const padding = 8;
  const gap = 10;
  const usableWidth = width - padding * 2 - gap;
  const usableHeight = height - padding * 2;
  const columnWidth = Math.floor(usableWidth / 2);

  return {
    info: {
      x: padding,
      y: padding,
      width: columnWidth,
      height: usableHeight,
    },
    form: {
      x: padding + columnWidth + gap,
      y: padding,
      width: columnWidth,
      height: usableHeight,
    },
  };
}

function resolveBounds(candidate, fallback, display) {
  const maxWidth = Math.max(320, display.workArea.width - 24);
  const maxHeight = Math.max(240, display.workArea.height - 24);
  const width = clamp(candidate?.width ?? fallback.width, 320, maxWidth);
  const height = clamp(candidate?.height ?? fallback.height, 240, maxHeight);
  const maxX = display.workArea.x + display.workArea.width - width;
  const maxY = display.workArea.y + display.workArea.height - height;
  return {
    x: clamp(candidate?.x ?? fallback.x, display.workArea.x, maxX),
    y: clamp(candidate?.y ?? fallback.y, display.workArea.y, maxY),
    width,
    height,
  };
}

async function spawnWindows(config) {
  const display = screen.getPrimaryDisplay();
  const fallback = computeFallbackLayout(display);
  const infoBounds = resolveBounds(config.info, fallback.info, display);
  const formBounds = resolveBounds(config.form, fallback.form, display);

  app.focus({ steal: true });

  backgroundWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    title: 'Form Test Background',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  await backgroundWindow.loadFile(path.join(__dirname, 'form-test-background.html'));
  backgroundWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  backgroundWindow.setFocusable(false);
  backgroundWindow.setIgnoreMouseEvents(true);
  backgroundWindow.show();

  await delay(150);

  infoWindow = new BrowserWindow({
    ...infoBounds,
    title: config.info.title,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  await infoWindow.loadFile(path.join(__dirname, 'form-test-info.html'));
  infoWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  infoWindow.show();
  infoWindow.moveTop();
  infoWindow.focus();
  const infoReady = waitForWindowReady('info');
  infoWindow.webContents.send('set-info-config', config.info);
  await infoReady;

  await delay(150);

  formWindow = new BrowserWindow({
    ...formBounds,
    title: config.form.title,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  await formWindow.loadFile(path.join(__dirname, 'form-test-form.html'));
  formWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  formWindow.show();
  formWindow.moveTop();
  formWindow.focus();
  const formReady = waitForWindowReady('form');
  formWindow.webContents.send('set-form-config', config.form);
  await formReady;

  await delay(400);
  app.focus({ steal: true });
  formWindow.moveTop();
  infoWindow.moveTop();
  formWindow.focus();

  console.log(`[FormWindows] Info window at (${infoBounds.x}, ${infoBounds.y}) ${infoBounds.width}x${infoBounds.height}`);
  console.log(`[FormWindows] Form window at (${formBounds.x}, ${formBounds.y}) ${formBounds.width}x${formBounds.height}`);
}

async function getTaskState() {
  if (!formWindow || formWindow.isDestroyed()) {
    return {
      source: {
        visibleFieldIds: [],
      },
      form: {
        values: {},
        visibleFieldIds: [],
        visibleRequiredFieldIds: [],
        submitVisible: false,
        submitted,
      },
    };
  }

  const formState = await formWindow.webContents.executeJavaScript(`
    (() => {
      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) {
          return false;
        }

        const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        const visibleArea = visibleWidth * visibleHeight;
        const totalArea = rect.width * rect.height;
        return totalArea > 0 && visibleArea / totalArea >= 0.6;
      }

      const values = {};
      const visibleFieldIds = [];
      const visibleRequiredFieldIds = [];
      const fields = document.querySelectorAll('.form-field[data-form-field-id]');

      fields.forEach((field) => {
        const fieldId = field.dataset.formFieldId;
        if (!fieldId) {
          return;
        }

        if (isVisible(field)) {
          visibleFieldIds.push(fieldId);
          if (field.dataset.required === 'true') {
            visibleRequiredFieldIds.push(fieldId);
          }
        }

        const firstInput = field.querySelector('input, textarea, select');
        if (!firstInput) {
          return;
        }

        const inputFieldId = firstInput.getAttribute('name') || firstInput.id;
        if (!inputFieldId || Object.prototype.hasOwnProperty.call(values, inputFieldId)) {
          return;
        }

        if (firstInput instanceof HTMLInputElement && firstInput.type === 'radio') {
          const checked = field.querySelector('input[type="radio"]:checked');
          values[inputFieldId] = checked ? checked.value : '';
          return;
        }

        if (firstInput instanceof HTMLInputElement && firstInput.type === 'checkbox') {
          const checked = Array.from(field.querySelectorAll('input[type="checkbox"]:checked'));
          values[inputFieldId] = checked.map((input) => input.value);
          return;
        }

        values[inputFieldId] = firstInput.value || '';
      });

      const submitButton = document.querySelector('#primary-action');
      const debugState = typeof window.__getFormTestDebugState === 'function'
        ? window.__getFormTestDebugState()
        : null;
      return {
        values,
        visibleFieldIds: Array.from(new Set(visibleFieldIds)),
        visibleRequiredFieldIds: Array.from(new Set(visibleRequiredFieldIds)),
        submitVisible: submitButton ? isVisible(submitButton) : false,
        debug: debugState,
      };
    })()
  `);

  const sourceState = infoWindow && !infoWindow.isDestroyed()
    ? await infoWindow.webContents.executeJavaScript(`
      (() => {
        function isVisible(element) {
          const rect = element.getBoundingClientRect();
          if (rect.width <= 1 || rect.height <= 1) {
            return false;
          }

          const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
          const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
          const visibleArea = visibleWidth * visibleHeight;
          const totalArea = rect.width * rect.height;
          return totalArea > 0 && visibleArea / totalArea >= 0.6;
        }

        const ids = [];
        Array.from(document.querySelectorAll('[data-source-field-id], [data-source-field-ids]'))
          .filter((element) => isVisible(element))
          .forEach((element) => {
            if (element.dataset.sourceFieldId) {
              ids.push(element.dataset.sourceFieldId);
            }
            if (element.dataset.sourceFieldIds) {
              ids.push(
                ...element.dataset.sourceFieldIds
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean)
              );
            }
          });

        return {
          visibleFieldIds: Array.from(new Set(ids)),
        };
      })()
    `)
    : { visibleFieldIds: [] };

  return {
    source: sourceState,
    form: {
      values: formState.values,
      visibleFieldIds: formState.visibleFieldIds,
      visibleRequiredFieldIds: formState.visibleRequiredFieldIds,
      submitVisible: formState.submitVisible,
      submitted,
    },
    debug: formState.debug || undefined,
  };
}

function focusFormWindow() {
  if (!formWindow || formWindow.isDestroyed()) {
    return;
  }

  app.focus({ steal: true });
  formWindow.show();
  formWindow.moveTop();
  formWindow.focus();
}

function getFormWindowBounds() {
  if (!formWindow || formWindow.isDestroyed()) {
    return null;
  }

  return formWindow.getBounds();
}

async function hitTestForm(screenX, screenY) {
  if (!formWindow || formWindow.isDestroyed()) {
    return null;
  }

  const bounds = formWindow.getBounds();
  const localX = Number(screenX) - bounds.x;
  const localY = Number(screenY) - bounds.y;

  return formWindow.webContents.executeJavaScript(`
    (() => {
      const x = ${JSON.stringify(localX)};
      const y = ${JSON.stringify(localY)};
      const element = document.elementFromPoint(x, y);
      if (!element) {
        return { x, y, tag: null };
      }

      const rect = element.getBoundingClientRect();
      return {
        x,
        y,
        tag: element.tagName,
        id: element.id || '',
        className: element.className || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        role: element.getAttribute('role') || '',
        text: (element.textContent || '').trim().slice(0, 120),
        fieldId: element.dataset?.fieldId || '',
        selectValue: element.dataset?.selectValue || '',
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      };
    })()
  `);
}

async function captureFormCrop(screenBounds, padding = 50) {
  if (!formWindow || formWindow.isDestroyed()) {
    return null;
  }

  const bounds = formWindow.getBounds();
  const crop = {
    x: clamp(Math.floor(Number(screenBounds.x) - bounds.x - padding), 0, Math.max(0, bounds.width - 1)),
    y: clamp(Math.floor(Number(screenBounds.y) - bounds.y - padding), 0, Math.max(0, bounds.height - 1)),
    width: 1,
    height: 1,
  };

  const right = clamp(
    Math.ceil(Number(screenBounds.x) - bounds.x + Number(screenBounds.width) + padding),
    crop.x + 1,
    bounds.width,
  );
  const bottom = clamp(
    Math.ceil(Number(screenBounds.y) - bounds.y + Number(screenBounds.height) + padding),
    crop.y + 1,
    bounds.height,
  );

  crop.width = right - crop.x;
  crop.height = bottom - crop.y;

  const image = await formWindow.capturePage(crop);
  return {
    crop,
    windowBounds: bounds,
    pngBase64: image.toPNG().toString('base64'),
  };
}

async function run() {
  const rawConfig = process.argv[2];
  if (!rawConfig) {
    throw new Error('Expected serialized test config as argv[2]');
  }

  const config = JSON.parse(rawConfig);
  await spawnWindows(config);
  process.stdout.write('=== FORM WINDOWS READY ===\n');

  ipcMain.on('form-submitted', () => {
    submitted = true;
    process.stdout.write('=== FORM SUBMITTED ===\n');
  });

  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  let stdinBuffer = '';
  let commandQueue = Promise.resolve();

  const enqueueCommand = (command) => {
    const normalizedCommand = String(command || '').trim();
    if (!normalizedCommand) {
      return;
    }
    commandQueue = commandQueue
      .then(() => handleCommand(normalizedCommand))
      .catch((error) => {
        console.error('[FormWindows] Command failed:', error);
      });
  };

  const handleCommand = async (command) => {
    if (command === 'GET_TASK_STATE') {
      const taskState = await getTaskState();
      process.stdout.write('=== TASK STATE ===\n');
      process.stdout.write(`${JSON.stringify(taskState)}\n`);
      process.stdout.write('=== END TASK STATE ===\n');
      return;
    }

    if (command === 'FOCUS_FORM_WINDOW') {
      focusFormWindow();
      process.stdout.write('=== FORM WINDOW FOCUSED ===\n');
      return;
    }

    if (command === 'GET_FORM_WINDOW_BOUNDS') {
      const bounds = getFormWindowBounds();
      process.stdout.write('=== FORM WINDOW BOUNDS ===\n');
      process.stdout.write(`${JSON.stringify(bounds)}\n`);
      process.stdout.write('=== END FORM WINDOW BOUNDS ===\n');
      return;
    }

    if (command.startsWith('HIT_TEST_FORM ')) {
      const [, rawX, rawY] = command.split(/\s+/);
      const hit = await hitTestForm(rawX, rawY);
      process.stdout.write('=== FORM HIT TEST ===\n');
      process.stdout.write(`${JSON.stringify(hit)}\n`);
      process.stdout.write('=== END FORM HIT TEST ===\n');
      return;
    }

    if (command.startsWith('CAPTURE_FORM_CROP ')) {
      const payload = JSON.parse(command.slice('CAPTURE_FORM_CROP '.length));
      const capture = await captureFormCrop(payload.bounds, payload.padding);
      process.stdout.write('=== FORM CROP ===\n');
      process.stdout.write(`${JSON.stringify(capture)}\n`);
      process.stdout.write('=== END FORM CROP ===\n');
    }
  };

  process.stdin.on('data', (chunk) => {
    stdinBuffer += String(chunk);
    let newlineIndex = stdinBuffer.search(/\r?\n/);
    while (newlineIndex !== -1) {
      const rawCommand = stdinBuffer.slice(0, newlineIndex);
      const newlineLength = stdinBuffer[newlineIndex] === '\r' && stdinBuffer[newlineIndex + 1] === '\n' ? 2 : 1;
      stdinBuffer = stdinBuffer.slice(newlineIndex + newlineLength);
      const command = rawCommand.trim();
      enqueueCommand(command);
      newlineIndex = stdinBuffer.search(/\r?\n/);
    }
  });

  process.on('message', (message) => {
    if (!message || message.type !== 'form-test-command') {
      return;
    }
    enqueueCommand(message.command);
  });
}

app.whenReady().then(run).catch((error) => {
  console.error('[FormWindows] Failed:', error);
  process.exit(1);
});

app.on('window-all-closed', () => {
  app.quit();
});

process.on('SIGTERM', () => {
  app.quit();
});
