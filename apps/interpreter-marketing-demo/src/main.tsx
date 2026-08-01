import "./standaloneShell";

const surface = new URLSearchParams(window.location.search).get("surface");

async function start(): Promise<void> {
  if (surface === "hosted-model-picker") {
    await import("./surfaces/HostedModelPickerSurface");
    return;
  }

  await import("../../../src/main");
}

void start();
