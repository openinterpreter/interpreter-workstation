import { describe, expect, test } from "bun:test";
import { applyMachineRuntimeDefaults } from "./headlessTaskCli";

describe("applyMachineRuntimeDefaults", () => {
  test("leaves non-machine runs unchanged", () => {
    expect(
      applyMachineRuntimeDefaults(
        {
          codexApprovalPolicy: "on-failure",
          codexSandboxMode: "workspace-write",
          codexNetworkAccess: false,
        },
        {},
      ),
    ).toEqual({
      codexApprovalPolicy: "on-failure",
      codexSandboxMode: "workspace-write",
      codexNetworkAccess: false,
    });
  });

  test("forces full access defaults for machine runs", () => {
    expect(
      applyMachineRuntimeDefaults(
        {},
        { INTERPRETER_MACHINE_RUN_DIR: "/tmp/machine-run" },
      ),
    ).toEqual({
      codexApprovalPolicy: "never",
      codexSandboxMode: "danger-full-access",
      codexNetworkAccess: true,
    });
  });

  test("preserves explicit machine overrides", () => {
    expect(
      applyMachineRuntimeDefaults(
        {
          codexApprovalPolicy: "never",
          codexSandboxMode: "workspace-write",
          codexNetworkAccess: false,
        },
        { INTERPRETER_MACHINE_RUN_DIR: "/tmp/machine-run" },
      ),
    ).toEqual({
      codexApprovalPolicy: "never",
      codexSandboxMode: "workspace-write",
      codexNetworkAccess: false,
    });
  });
});
