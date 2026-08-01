import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { PdfStructure } from '../../electron/ipc/registry';
import { PDF_ADD_ANNOTATION_BUTTON_ID, PDF_SAVE_BUTTON_ID } from '../../shared/element-ids';
import { PDFViewer } from './PDFViewer';

const TEST_FILE_PATH = '/workspace/form.pdf';

const pdfjsMocks = vi.hoisted(() => {
  const createViewport = (scale: number) => ({
    width: 600 * Math.abs(scale || 1),
    height: 800 * Math.abs(scale || 1),
    transform: [1, 0, 0, 1, 0, 0],
    clone: () => createViewport(scale),
    convertToViewportRectangle: (rect: number[]) => rect,
  });

  const page = {
    getViewport: ({ scale }: { scale: number }) => createViewport(scale),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    getTextContent: vi.fn(async () => ({ items: [] })),
    getAnnotations: vi.fn(async () => []),
  };

  const document = {
    numPages: 1,
    getPage: vi.fn(async () => page),
    getPageIndex: vi.fn(async () => 0),
  };

  return {
    page,
    document,
    getDocument: vi.fn(() => ({ promise: Promise.resolve(document) })),
  };
});

const ipcMocks = vi.hoisted(() => ({
  getFileUrl: vi.fn(async (_targetPath: string) => 'file:///mock.pdf'),
  getApiUrl: vi.fn(async (targetPath: string) => targetPath),
  pathBasename: vi.fn((targetPath: string) => targetPath.split('/').pop() ?? targetPath),
  isAbsolutePath: vi.fn((targetPath: string) => targetPath.startsWith('/')),
  openExternal: vi.fn(async () => undefined),
  pdf: {
    readStructure: vi.fn<(filePath: string, page?: number) => Promise<PdfStructure | null>>(),
    onFillField: vi.fn(() => () => {}),
  },
}));

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

vi.mock('pdfjs-dist', () => ({
  AnnotationMode: { DISABLE: 0 },
  GlobalWorkerOptions: { workerSrc: '' },
  Util: {
    transform: (_first: number[], second: number[]) => second,
  },
  AnnotationLayer: class {
    async render(): Promise<void> {}
  },
  getDocument: pdfjsMocks.getDocument,
}));

vi.mock('@/ipc', () => ipcMocks);

vi.mock('@/api', () => ({
  callTool: vi.fn(async () => undefined),
}));

vi.mock('../hooks/useFileRefresh', () => ({
  useFileRefresh: vi.fn(),
}));

vi.mock('../utils/feedback', () => ({
  openFeedbackPopover: vi.fn(),
}));

vi.mock('./AnnotationToolbar', () => ({
  AnnotationToolbar: () => null,
}));

const INITIAL_STRUCTURE = {
  path: TEST_FILE_PATH,
  pages: [{ number: 1, width: 600, height: 800 }],
  elements: [
    {
      id: 'a0',
      type: 'annotation',
      page: 1,
      bbox: { x: 100, y: 100, width: 100, height: 20 },
      contents: 'Srinivas Annam',
      annotationType: 'FreeText',
      fontSize: 12,
      color: { r: 0, g: 0, b: 0 },
    },
    {
      id: 'a1',
      type: 'annotation',
      page: 1,
      bbox: { x: 100, y: 140, width: 100, height: 20 },
      contents: 'AXWPA1889L',
      annotationType: 'FreeText',
      fontSize: 12,
      color: { r: 0, g: 0, b: 0 },
    },
  ],
} satisfies PdfStructure;

let clientWidthDescriptor: PropertyDescriptor | undefined;
let clientHeightDescriptor: PropertyDescriptor | undefined;

function getRenderedAnnotationIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.pdf-annotation'))
    .map((element) => element.dataset.annotationId ?? '');
}

function mockJsonResponse<T>(body: T): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeAll(() => {
  clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 800;
    },
  });

  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 1000;
    },
  });

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => ({})),
  });
});

afterAll(() => {
  if (clientWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDescriptor);
  }
  if (clientHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  ipcMocks.pdf.readStructure.mockReset();
});

describe('PDFViewer', () => {
  beforeEach(() => {
    ipcMocks.pdf.readStructure.mockResolvedValue(INITIAL_STRUCTURE);

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pdf/annotations/remove')) {
        return mockJsonResponse({ success: true });
      }
      if (url.includes('/api/pdf/annotations/add')) {
        return mockJsonResponse({ createdIds: ['a1'] });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  test('keeps rendered annotation IDs distinct after saving a moved annotation', async () => {
    const { container } = render(<PDFViewer filePath={TEST_FILE_PATH} />);

    await waitFor(() => {
      expect(getRenderedAnnotationIds(container)).toEqual(['a0', 'a1']);
    });

    const firstAnnotation = container.querySelector<HTMLElement>('[data-annotation-id="a0"]');
    expect(firstAnnotation).not.toBeNull();
    if (!firstAnnotation) {
      throw new Error('Expected first annotation to be rendered');
    }

    fireEvent.mouseDown(firstAnnotation, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 120, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 120, clientY: 100 });

    fireEvent.click(screen.getByTestId(PDF_SAVE_BUTTON_ID));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      const renderedIds = getRenderedAnnotationIds(container);
      expect(renderedIds).toHaveLength(2);
      expect(new Set(renderedIds)).toEqual(new Set(['a0', 'a1']));
    });
  });

  test('auto-saves a new annotation added while an earlier save is still in flight', async () => {
    const firstAddResponse = createDeferred<Response>();
    let addRequestCount = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pdf/annotations/remove')) {
        return mockJsonResponse({ success: true });
      }
      if (url.includes('/api/pdf/annotations/add')) {
        addRequestCount += 1;
        if (addRequestCount === 1) {
          return firstAddResponse.promise;
        }
        return mockJsonResponse({ createdIds: ['a2'] });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const { container } = render(<PDFViewer filePath={TEST_FILE_PATH} />);

    await waitFor(() => {
      expect(getRenderedAnnotationIds(container)).toEqual(['a0', 'a1']);
    });

    const firstAnnotation = container.querySelector<HTMLElement>('[data-annotation-id="a0"]');
    expect(firstAnnotation).not.toBeNull();
    if (!firstAnnotation) {
      throw new Error('Expected first annotation to be rendered');
    }

    fireEvent.mouseDown(firstAnnotation, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 120, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 120, clientY: 100 });

    fireEvent.click(screen.getByTestId(PDF_SAVE_BUTTON_ID));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByTestId(PDF_ADD_ANNOTATION_BUTTON_ID));

    await waitFor(() => {
      expect(getRenderedAnnotationIds(container)).toHaveLength(3);
    });

    firstAddResponse.resolve(mockJsonResponse({ createdIds: ['a1'] }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }, { timeout: 3000 });

    await waitFor(() => {
      const renderedIds = getRenderedAnnotationIds(container);
      expect(renderedIds).toHaveLength(3);
      expect(renderedIds.some((id) => id.startsWith('local-'))).toBe(false);
      expect(renderedIds.includes('a2')).toBe(true);
    }, { timeout: 3000 });
  });

  test('emits PDF form field selection with the read_pdf field id', async () => {
    (pdfjsMocks.page.getAnnotations as any).mockResolvedValueOnce([
      {
        subtype: 'Widget',
        fieldType: 'Tx',
        fieldName: 'email',
        fieldValue: '',
        rect: [100, 100, 260, 124],
      },
    ]);
    ipcMocks.pdf.readStructure.mockResolvedValue({
      ...INITIAL_STRUCTURE,
      elements: [
        ...INITIAL_STRUCTURE.elements,
        {
          id: 'f6',
          type: 'formField',
          page: 1,
          bbox: { x: 100, y: 100, width: 160, height: 24 },
          fieldName: 'email',
          fieldType: 'text',
          fieldValue: '',
          fieldIndex: 6,
        },
      ],
    });

    const selections: unknown[] = [];
    const listener = (event: Event) => selections.push((event as CustomEvent).detail);
    window.addEventListener('selection:changed', listener);

    try {
      const { container } = render(<PDFViewer filePath={TEST_FILE_PATH} />);

      const input = await waitFor(() => {
        const element = container.querySelector<HTMLInputElement>('input[name="email"]');
        expect(element).not.toBeNull();
        return element!;
      });

      fireEvent.focus(input);

      await waitFor(() => {
        expect(selections).toContainEqual({
          type: 'pdf',
          kind: 'formField',
          filePath: TEST_FILE_PATH,
          fieldId: 'f6',
          fieldName: 'email',
          fieldType: 'text',
          fieldIndex: 6,
          page: 1,
          value: '',
        });
      });

      expect(input.parentElement?.classList.contains('form-field-selected')).toBe(true);
    } finally {
      window.removeEventListener('selection:changed', listener);
    }
  });

  test('emits the selected PDF widget id when duplicate field names exist', async () => {
    (pdfjsMocks.page.getAnnotations as any).mockResolvedValueOnce([
      {
        subtype: 'Widget',
        fieldType: 'Tx',
        fieldName: 'email',
        fieldValue: '',
        rect: [100, 100, 260, 124],
      },
      {
        subtype: 'Widget',
        fieldType: 'Tx',
        fieldName: 'email',
        fieldValue: '',
        rect: [100, 150, 260, 174],
      },
    ]);
    ipcMocks.pdf.readStructure.mockResolvedValue({
      ...INITIAL_STRUCTURE,
      elements: [
        ...INITIAL_STRUCTURE.elements,
        {
          id: 'f6',
          type: 'formField',
          page: 1,
          bbox: { x: 100, y: 100, width: 160, height: 24 },
          fieldName: 'email',
          fieldType: 'text',
          fieldValue: '',
          fieldIndex: 6,
        },
        {
          id: 'f9',
          type: 'formField',
          page: 1,
          bbox: { x: 100, y: 150, width: 160, height: 24 },
          fieldName: 'email',
          fieldType: 'text',
          fieldValue: '',
          fieldIndex: 9,
        },
      ],
    });

    const selections: unknown[] = [];
    const listener = (event: Event) => selections.push((event as CustomEvent).detail);
    window.addEventListener('selection:changed', listener);

    try {
      const { container } = render(<PDFViewer filePath={TEST_FILE_PATH} />);

      const inputs = await waitFor(() => {
        const elements = container.querySelectorAll<HTMLInputElement>('input[name="email"]');
        expect(elements).toHaveLength(2);
        return elements;
      });

      fireEvent.focus(inputs[1]!);

      await waitFor(() => {
        expect(selections).toContainEqual({
          type: 'pdf',
          kind: 'formField',
          filePath: TEST_FILE_PATH,
          fieldId: 'f9',
          fieldName: 'email',
          fieldType: 'text',
          fieldIndex: 9,
          page: 1,
          value: '',
        });
      });

      expect(inputs[1]!.parentElement?.classList.contains('form-field-selected')).toBe(true);
    } finally {
      window.removeEventListener('selection:changed', listener);
    }
  });

  test('cancels pending annotation blink timers on unmount', async () => {
    const { unmount } = render(<PDFViewer filePath={TEST_FILE_PATH} />);

    await waitFor(() => {
      expect(getRenderedAnnotationIds(document.body)).toEqual(['a0', 'a1']);
    });

    vi.useFakeTimers();
    const activeDocument = document;

    try {
      fireEvent.click(screen.getByTestId(PDF_ADD_ANNOTATION_BUTTON_ID));
      unmount();
      vi.stubGlobal('document', undefined);

      expect(() => {
        vi.advanceTimersByTime(50);
      }).not.toThrow();
    } finally {
      vi.stubGlobal('document', activeDocument);
      vi.useRealTimers();
    }
  });
});
