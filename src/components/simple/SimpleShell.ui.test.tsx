import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  openFolderDialog: vi.fn(async () => ({
    canceled: true,
    filePaths: [] as string[],
  })),
  createWindow: vi.fn(async () => ({
    success: true,
    windowId: 2,
    sessionKey: "simple-2",
  })),
  setComposerState: vi.fn(async () => ({ success: true })),
  focusChanged: null as null | ((event: { focused: boolean }) => void),
}));
const simpleClientMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  openProject: vi.fn(),
}));

vi.mock("../../../agent/components/AgentThread", () => ({
  AgentThread: ({
    agentId,
    codexThreadId,
    onCodexThreadIdAssigned,
  }: {
    agentId: string;
    codexThreadId?: string;
    onCodexThreadIdAssigned: (agentId: string, threadId: string) => void;
  }) => (
    <div>
      Thread {agentId} {codexThreadId ?? "new"}
      <button
        type="button"
        onClick={() => onCodexThreadIdAssigned(agentId, "oix-thread-42")}
      >
        Assign thread
      </button>
    </div>
  ),
}));
vi.mock("../../../agent/components/ComposerArea", () => ({
  ComposerArea: ({
    onAgentSend,
    onDraftChange,
    settingsContent,
    voiceButtonOverride,
    modelConfig,
  }: {
    onAgentSend: (text: string) => void;
    onDraftChange?: (text: string) => void;
    settingsContent?: React.ReactNode;
    voiceButtonOverride?: React.ReactNode;
    modelConfig?: { reasoningEffort?: string };
  }) => (
    <div>
      <output aria-label="Composer reasoning effort">
        {modelConfig?.reasoningEffort ?? "default"}
      </output>
      <button type="button" onClick={() => onAgentSend("Hello")}>
        Send prompt
      </button>
      <button
        type="button"
        onClick={() => onDraftChange?.("unfinished thought")}
      >
        Change draft
      </button>
      {voiceButtonOverride}
      {settingsContent}
    </div>
  ),
}));
vi.mock("../../../agent/contexts/AgentMetadataContext", () => ({
  AgentMetadataProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("../../../agent/contexts/AgentErrorContext", () => ({
  AgentErrorProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../../api", () => ({
  getProfiles: async () => ({
    profiles: [
      {
        id: "openai",
        name: "OpenAI",
        modelId: "gpt-6-sol",
        isBuiltin: false,
        provider: "api",
        reasoningEffort: "low",
      },
    ],
    defaultProfileId: "openai",
  }),
  setDefaultProfile: async () => ({ success: true }),
}));
vi.mock("../../remote/workstationConnection", () => ({
  isRemoteWorkstationHost: () => false,
  isWorkstationReadOnly: () => false,
}));
vi.mock("@/ipc", () => ({
  openFolderDialog: ipcMocks.openFolderDialog,
  profiles: { onChanged: () => () => {}, onDefaultChanged: () => () => {} },
  quickActions: { onSimpleProjectAction: () => () => {} },
  simplePrimaryThread: {
    bindChannel: async () => ({ success: true }),
    forwardChannelReply: async () => ({ sent: false }),
    onOverlaySubmit: () => () => {},
  },
  simpleComposerState: {
    get: async () => ({ draft: "" }),
    set: ipcMocks.setComposerState,
    onChanged: () => () => {},
  },
  windowIpc: {
    create: ipcMocks.createWindow,
    onFocusChanged: (callback: (event: { focused: boolean }) => void) => {
      ipcMocks.focusChanged = callback;
      return () => {
        ipcMocks.focusChanged = null;
      };
    },
  },
  simpleLive: {
    status: async () => ({ configured: false, source: "none" }),
    createSession: async () => ({ answerSdp: "answer", sessionId: "session" }),
  },
}));
vi.mock("./simpleInterfaceClient", () => ({
  simpleInterfaceClient: {
    projects: async () => ({
      active: {
        path: "/documents/My Interface",
        legacy: false,
        metadata: {
          version: 1,
          id: "project",
          name: "My Interface",
          createdAt: "2026-09-30T00:00:00.000Z",
        },
      },
      recent: [],
    }),
    createProject: simpleClientMocks.createProject,
    openProject: simpleClientMocks.openProject,
  },
}));
vi.mock("../../utils/layoutHelpers", () => ({
  createAgentCallerToken: () => "token-for-test",
}));
vi.mock("../settings/ExperienceSection", () => ({
  ExperienceSectionContent: () => <div>Experience choices</div>,
}));
vi.mock("../settings/ProfilesSection", () => ({
  ProfilesSectionContent: () => <div>Model management</div>,
}));
vi.mock("./SimpleConnectionsSettings", () => ({
  SimpleConnectionsSettings: () => <div>Connections settings</div>,
}));

import {
  SIMPLE_PRIMARY_AGENT_ID,
  SimpleShell,
  sendSimpleMessage,
} from "./SimpleShell";

const props = {
  workspacePath: "/documents/Interpreter",
  initialThreadId: null,
  onBindThread: vi.fn(),
  onOpenSettings: vi.fn(),
  settingsOpen: false,
  onCloseSettings: vi.fn(),
  canvas: <button type="button">Generated interface action</button>,
};

describe("Simple shell", () => {
  test("applies the selected profile's low reasoning setting", async () => {
    render(<SimpleShell {...props} />);
    expect(
      await screen.findByRole("status", { name: "Composer reasoning effort" }),
    ).toHaveTextContent("low");
  });

  test("moves the one composer to the focused Simple window", async () => {
    render(<SimpleShell {...props} />);
    expect(
      await screen.findByRole("region", { name: "Primary conversation" }),
    ).toBeVisible();

    act(() => ipcMocks.focusChanged?.({ focused: false }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Primary conversation" }),
      ).toBeNull(),
    );

    act(() => ipcMocks.focusChanged?.({ focused: true }));
    expect(
      await screen.findByRole("region", { name: "Primary conversation" }),
    ).toBeVisible();
  });

  test("shows a full-page interface and one collapsed persistent composer", async () => {
    const user = userEvent.setup();
    render(<SimpleShell {...props} />);
    expect(screen.getByRole("main", { name: "Interface" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Generated interface action" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Show conversation" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show conversation" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Collapse conversation" }),
      ).toBeVisible(),
    );
    await user.click(
      screen.getByRole("button", { name: "Generated interface action" }),
    );
    expect(
      screen.getByRole("button", { name: "Show conversation" }),
    ).toBeVisible();
  });

  test("opens only the inset drawer while the composer capsule stays mounted", async () => {
    const user = userEvent.setup();
    const { container } = render(<SimpleShell {...props} />);
    const drawer = container.querySelector('[data-simple-drawer="true"]');
    const tab = container.querySelector('[data-simple-activity-tab="true"]');
    const composer = container.querySelector(
      '[data-simple-composer-capsule="true"]',
    );

    expect(drawer).toHaveClass("left-5", "right-5");
    expect(tab).toHaveClass("ml-5", "w-[calc(100%-2.5rem)]");
    expect(composer).toBeInTheDocument();
    expect(drawer).toHaveAttribute("aria-hidden", "true");

    await user.click(
      await screen.findByRole("button", { name: "Show conversation" }),
    );

    expect(drawer).toHaveAttribute("aria-hidden", "false");
    expect(composer).toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-simple-composer-capsule="true"]'),
    ).toHaveLength(1);
  });

  test("chat and generated UI messages route to the same primary agent and workspace", async () => {
    const onSend = vi.fn();
    const onState = (event: Event) =>
      (event as CustomEvent).detail.callback({ isRunning: false });
    window.addEventListener("agent-runtime:send", onSend);
    window.addEventListener("agent-runtime:get-state", onState);
    const user = userEvent.setup();
    render(<SimpleShell {...props} />);
    await screen.findByRole("button", { name: "Send prompt" });
    await user.click(screen.getByRole("button", { name: "Send prompt" }));
    sendSimpleMessage("Action selection", "/documents/Interpreter");
    expect(onSend).toHaveBeenCalledTimes(2);
    for (const [event] of onSend.mock.calls) {
      expect((event as CustomEvent).detail).toMatchObject({
        tabId: SIMPLE_PRIMARY_AGENT_ID,
        workspacePath: "/documents/Interpreter",
      });
    }
    window.removeEventListener("agent-runtime:send", onSend);
    window.removeEventListener("agent-runtime:get-state", onState);
  });

  test("interface actions fail visibly rather than disappearing when the runtime is absent", () => {
    expect(() =>
      sendSimpleMessage("Choose option", "/documents/Interpreter"),
    ).toThrow("not ready");
  });

  test("binds assigned thread and opens Settings above the persistent pill", async () => {
    const user = userEvent.setup();
    const onBindThread = vi.fn();
    const onOpenSettings = vi.fn();
    const onCloseSettings = vi.fn();
    const view = render(
      <SimpleShell
        {...props}
        onBindThread={onBindThread}
        onOpenSettings={onOpenSettings}
        onCloseSettings={onCloseSettings}
      />,
    );
    await screen.findByRole("button", { name: "Show conversation" });
    await user.click(screen.getByRole("button", { name: "Show conversation" }));
    await user.click(screen.getByRole("button", { name: "Assign thread" }));
    await waitFor(() =>
      expect(onBindThread).toHaveBeenCalledWith("oix-thread-42"),
    );
    expect(
      screen.getByText(`Thread ${SIMPLE_PRIMARY_AGENT_ID} oix-thread-42`),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Collapse conversation" }),
    );
    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    view.rerender(
      <SimpleShell
        {...props}
        settingsOpen={true}
        onCloseSettings={onCloseSettings}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Experience choices")).toBeVisible(),
    );
    expect(
      screen.getByRole("button", { name: "Generated interface action" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close settings" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onCloseSettings).toHaveBeenCalledOnce();
  });

  test("collapses an open drawer when the generated interface is used", async () => {
    const user = userEvent.setup();
    render(<SimpleShell {...props} />);
    await user.click(
      await screen.findByRole("button", { name: "Show conversation" }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse conversation" }),
    ).toBeVisible();
    window.dispatchEvent(new CustomEvent("simple-interface:interaction"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show conversation" }),
      ).toBeVisible(),
    );
  });

  test("failed thread binding stops composer and shows explicit recovery", async () => {
    const user = userEvent.setup();
    const onBindThread = vi.fn(async () => {
      throw new Error("Conflict");
    });
    render(<SimpleShell {...props} onBindThread={onBindThread} />);
    await screen.findByRole("button", { name: "Show conversation" });
    await user.click(screen.getByRole("button", { name: "Show conversation" }));
    await user.click(screen.getByRole("button", { name: "Assign thread" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reload Interpreter to recover",
    );
    expect(
      screen.queryByRole("button", { name: "Send prompt" }),
    ).not.toBeInTheDocument();
  });

  test("keeps the GPT Live error state icon-only with an explanatory tooltip", async () => {
    const user = userEvent.setup();
    render(<SimpleShell {...props} />);
    const liveButton = await screen.findByRole("button", {
      name: "Start GPT Live",
    });
    await user.click(liveButton);
    const retryButton = await screen.findByRole("button", {
      name: "Retry GPT Live",
    });
    expect(retryButton).toHaveClass("w-9");
    expect(retryButton).toHaveAttribute(
      "title",
      "GPT Live needs an OpenAI API key. Add an OpenAI model in Settings first.",
    );
    expect(screen.queryByText("Live failed")).not.toBeInTheDocument();
  });

  test("persists an unfinished draft for the app and overlay to share", async () => {
    ipcMocks.setComposerState.mockClear();
    const user = userEvent.setup();
    render(<SimpleShell {...props} />);

    await user.click(
      await screen.findByRole("button", { name: "Change draft" }),
    );

    expect(ipcMocks.setComposerState).toHaveBeenCalledWith({
      draft: "unfinished thought",
    });
  });

  test("creates a new interface in its own window without replacing this one", async () => {
    ipcMocks.openFolderDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/documents/Second Interface"],
    });
    simpleClientMocks.createProject.mockResolvedValueOnce({
      path: "/documents/Second Interface",
      legacy: false,
      metadata: {
        version: 1,
        id: "second-project",
        name: "Second Interface",
        createdAt: "2026-09-30T00:00:00.000Z",
      },
    });
    ipcMocks.createWindow.mockClear();
    const user = userEvent.setup();
    render(<SimpleShell {...props} />);

    await user.click(
      await screen.findByRole("button", { name: "Open Settings" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "New interface" }),
    );

    await waitFor(() =>
      expect(simpleClientMocks.createProject).toHaveBeenCalledWith(
        "/documents/Second Interface",
        { activate: false },
      ),
    );
    expect(ipcMocks.createWindow).toHaveBeenCalledWith({
      workspacePath: "/documents/Interpreter",
      simpleProjectPath: "/documents/Second Interface",
    });
    expect(
      screen.getByRole("button", { name: "Generated interface action" }),
    ).toBeVisible();
  });
});
