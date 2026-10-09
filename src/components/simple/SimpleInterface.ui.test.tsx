import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const client = vi.hoisted(() => ({
  refresh: vi.fn(),
  appUrl: vi.fn(),
  appState: vi.fn(),
  setAppState: vi.fn(),
  updateAppState: vi.fn(),
  runtimeError: vi.fn(),
  appUiState: vi.fn(),
  setAppUiState: vi.fn(),
  resolvePath: vi.fn(),
  projects: vi.fn(),
}));
const agentIpc = vi.hoisted(() => ({ start: vi.fn(), onEvent: vi.fn(() => () => {}) }));
const fileIpc = vi.hoisted(() => ({ getPathForFile: vi.fn(), showItemInFolder: vi.fn() }));

vi.mock("./simpleInterfaceClient", () => ({ simpleInterfaceClient: client }));
vi.mock("../../ipc", () => ({ ...fileIpc, simpleInterfaceAgents: agentIpc }));
vi.mock("../EditorArea", () => ({ EditorArea: ({ filePath }: { filePath: string }) => <div data-testid="canonical-editor">Editor: {filePath}</div> }));
vi.mock("../Explorer", () => ({ Explorer: ({ rootPath, onFileOpen }: { rootPath: string; onFileOpen: (path: string) => void }) => <button onClick={() => onFileOpen(`${rootPath}/opened.md`)}>Explorer: {rootPath}</button> }));
vi.mock("../../remote/workstationConnection", () => ({
  isWorkstationReadOnly: () => false,
}));

import { SimpleInterface } from "./SimpleInterface";

const status = {
  revision: "compiled-1",
  sourceRevision: "source-1",
  diagnostic: null,
  ready: true,
};

beforeEach(() => {
  client.refresh.mockResolvedValue(status);
  client.appUrl.mockResolvedValue(
    "http://127.0.0.1:5177/api/simple-interface/app/index.html?revision=compiled-1",
  );
  client.appState.mockResolvedValue({});
  client.setAppState.mockResolvedValue({ success: true });
  client.updateAppState.mockResolvedValue({ success: true });
  client.runtimeError.mockResolvedValue({ success: true });
  client.appUiState.mockResolvedValue({});
  client.setAppUiState.mockResolvedValue({ success: true });
  client.resolvePath.mockResolvedValue({ path: "/project/file.md", name: "file.md", directory: false });
  client.projects.mockResolvedValue({ active: { path: "/project" }, recent: [] });
  fileIpc.getPathForFile.mockReturnValue("");
  fileIpc.showItemInFolder.mockResolvedValue(undefined);
  agentIpc.start.mockResolvedValue({ success: true, result: { completed: true, messages: [] } });
});
afterEach(() => vi.clearAllMocks());

describe("Simple executable interface", () => {
  test("loads the last compiled React application in a script-only sandbox", async () => {
    render(<SimpleInterface onMessage={() => {}} />);
    const frame = (await screen.findByTitle(
      "Interpreter interface",
    )) as HTMLIFrameElement;
    expect(frame.src).toContain(
      "/api/simple-interface/app/index.html?revision=compiled-1",
    );
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  test("routes generated React controls into the durable conversation", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    render(<SimpleInterface onMessage={onMessage} />);
    const frame = (await screen.findByTitle(
      "Interpreter interface",
    )) as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          protocol: "interpreter-interface-v1",
          type: "send-message",
          id: "generated-control-1",
          message: "Use the selected option.",
        },
      }),
    );
    await vi.waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith(
        "Use the selected option.",
        "interface /project",
      ),
    );
  });

  test("mounts canonical Workstation file and folder surfaces and forwards folder opens", async () => {
    client.resolvePath.mockImplementation(async (path: string) => path === "."
      ? { path: "/project", name: "project", directory: true }
      : { path: "/project/note.md", name: "note.md", directory: false });
    render(<SimpleInterface onMessage={() => {}} />);
    const frame = (await screen.findByTitle("Interpreter interface")) as HTMLIFrameElement;
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        data: { protocol: "interpreter-interface-v1", type: "host-view-register", view: { id: "file-1", kind: "file", path: "note.md", rect: { x: 20, y: 30, width: 500, height: 300 } } },
      }));
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        data: { protocol: "interpreter-interface-v1", type: "host-view-register", view: { id: "folder-1", kind: "folder", path: ".", rect: { x: 540, y: 30, width: 300, height: 300 } } },
      }));
    });
    expect(await screen.findByTestId("canonical-editor", {}, { timeout: 5000 })).toHaveTextContent("/project/note.md");
    const explorer = await screen.findByRole("button", { name: "Explorer: /project" });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    await act(async () => explorer.click());
    expect(postMessage).toHaveBeenCalledWith({
      protocol: "interpreter-interface-v1",
      type: "host-event",
      name: "file-open:folder-1",
      detail: { path: "/project/opened.md" },
    }, "*");
  });

  test("forwards interface selection and dropped files through the ordinary host bridges", async () => {
    const selection = vi.fn();
    window.addEventListener("selection:changed", selection);
    fileIpc.getPathForFile.mockReturnValue("C:\\Users\\Example\\Desktop\\photo.png");
    render(<SimpleInterface onMessage={() => {}} />);
    const frame = (await screen.findByTitle("Interpreter interface")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { protocol: "interpreter-interface-v1", type: "selection", text: "selected words", path: "note.md" },
    }));
    expect(selection).toHaveBeenCalledWith(expect.objectContaining({ detail: { type: "text", text: "selected words", source: { type: "file", path: "note.md" } } }));

    const file = new File(["pixels"], "photo.png", { type: "image/png" });
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { protocol: "interpreter-interface-v1", type: "files-dropped", files: [file], point: { x: 120, y: 80 } },
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      protocol: "interpreter-interface-v1",
      type: "host-event",
      name: "files-dropped",
      detail: { files: [{ name: "photo.png", type: "image/png", size: 6, path: "C:\\Users\\Example\\Desktop\\photo.png" }], point: { x: 120, y: 80 } },
    }), "*");
    window.removeEventListener("selection:changed", selection);
  });

  test("accepts a dropped Windows child path but revokes it when the interface project changes", async () => {
    fileIpc.getPathForFile.mockReturnValue("C:\\Users\\Example\\Desktop\\folder");
    render(<SimpleInterface onMessage={() => {}} />);
    const frame = (await screen.findByTitle("Interpreter interface")) as HTMLIFrameElement;
    const dropped = new File(["folder"], "folder", { type: "application/octet-stream" });
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { protocol: "interpreter-interface-v1", type: "files-dropped", files: [dropped], point: { x: 10, y: 10 } },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { protocol: "interpreter-interface-v1", type: "host-view-register", view: { id: "drop-child", kind: "file", path: "C:\\Users\\Example\\Desktop\\folder\\note.md", rect: { x: 20, y: 30, width: 300, height: 200 } } },
    }));
    expect(await screen.findByTestId("canonical-editor")).toHaveTextContent("folder\\note.md");
    expect(client.resolvePath).not.toHaveBeenCalledWith("C:\\Users\\Example\\Desktop\\folder\\note.md");

    window.dispatchEvent(new Event("simple-project:changed"));
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { protocol: "interpreter-interface-v1", type: "host-view-register", view: { id: "after-switch", kind: "file", path: "C:\\Users\\Example\\Desktop\\folder\\other.md", rect: { x: 20, y: 30, width: 300, height: 200 } } },
    }));
    await vi.waitFor(() => expect(client.resolvePath).toHaveBeenCalledWith("C:\\Users\\Example\\Desktop\\folder\\other.md"));
  });

  test("routes key-level persistent state updates without a lossy host read-modify-write", async () => {
    render(<SimpleInterface onMessage={() => {}} />);
    const frame = (await screen.findByTitle("Interpreter interface")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { protocol: "interpreter-interface-v1", type: "state-update", id: "state-1", key: "notes", value: "kept" },
    }));
    await vi.waitFor(() => expect(client.updateAppState).toHaveBeenCalledWith("notes", "kept"));
  });

  test("runs a focused interface agent through IPC without creating a second message protocol", async () => {
    render(<SimpleInterface onMessage={() => {}} />);
    const frame = (await screen.findByTitle("Interpreter interface")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        protocol: "interpreter-interface-v1",
        type: "run-agent",
        id: "research-request-1",
        value: { runId: "research-1", message: "Find the relevant file." },
      },
    }));
    await vi.waitFor(() => expect(agentIpc.start).toHaveBeenCalledWith({
      runId: "research-1",
      message: "Find the relevant file.",
      system: undefined,
      timeoutMs: undefined,
    }));
  });

  test("forwards generated-interface interaction so an open drawer can collapse", async () => {
    const onInteraction = vi.fn();
    window.addEventListener("simple-interface:interaction", onInteraction);
    render(<SimpleInterface onMessage={() => {}} />);
    const frame = (await screen.findByTitle(
      "Interpreter interface",
    )) as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { protocol: "interpreter-interface-v1", type: "interaction" },
      }),
    );
    expect(onInteraction).toHaveBeenCalledOnce();
    frame.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(onInteraction).toHaveBeenCalledTimes(2);
    window.removeEventListener("simple-interface:interaction", onInteraction);
  });

  test("keeps the compiled application visible while a source edit has a diagnostic", async () => {
    client.refresh.mockResolvedValue({
      ...status,
      sourceRevision: "broken-source",
      diagnostic: "App.jsx:4: Unexpected token",
    });
    render(<SimpleInterface onMessage={() => {}} />);
    expect(await screen.findByTitle("Interpreter interface")).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent(
      "last working version is still running",
    );
  });

  test("hot-swaps only when a new compiled revision is promoted", async () => {
    vi.useFakeTimers();
    client.refresh
      .mockResolvedValueOnce(status)
      .mockResolvedValue({
        ...status,
        revision: "compiled-2",
        sourceRevision: "source-2",
      });
    client.appUrl.mockImplementation(
      async (revision: string) =>
        `http://127.0.0.1:5177/api/simple-interface/app/index.html?revision=${revision}`,
    );
    render(<SimpleInterface onMessage={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    const initialFrame = screen.getByTitle("Interpreter interface") as HTMLIFrameElement;
    expect(initialFrame.src).toContain("compiled-1");
    vi.spyOn(initialFrame.contentWindow!, "postMessage").mockImplementation((message) => {
      const payload = message as { name?: string; detail?: { token?: string } };
      if (payload.name !== "capture-ui-state" || !payload.detail?.token) return;
      window.dispatchEvent(new MessageEvent("message", {
        source: initialFrame.contentWindow,
        data: {
          protocol: "interpreter-interface-v1",
          type: "ui-state-snapshot",
          token: payload.detail.token,
          value: { controls: { notes: { value: "draft", selectionStart: 5, selectionEnd: 5 } } },
        },
      }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(client.setAppUiState).toHaveBeenCalledWith({
      controls: { notes: { value: "draft", selectionStart: 5, selectionEnd: 5 } },
    });
    expect(
      screen.getAllByTitle("Interpreter interface").some((element) =>
        (element as HTMLIFrameElement).src.includes("compiled-2"),
      ),
    ).toBe(true);
    vi.useRealTimers();
  });
});
