import "./standaloneShell";

const surface = new URLSearchParams(window.location.search).get("surface");

async function start(): Promise<void> {
  if (surface === "hosted-model-picker") {
    await import("./surfaces/HostedModelPickerSurface");
    return;
  }

  if (surface === "remote-thread") {
    await import("./surfaces/RemoteThreadViewerSurface");
    return;
  }

  await import("../../../src/main");
}

void start();
