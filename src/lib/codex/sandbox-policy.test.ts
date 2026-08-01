import { describe, expect, test } from "bun:test";

import {
  buildCodexWorkspacePermissionSelection,
  WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID,
} from "./sandbox-policy";

describe("OIX workspace-only permission profiles", () => {
  test("uses a named write profile and explicit runtime workspace root", () => {
    const selection = buildCodexWorkspacePermissionSelection({
      sandboxMode: "workspace-write",
      readAccessMode: "workspace-only",
      networkAccess: false,
      allowTempAccess: false,
      cwd: "/workspace/project",
    });

    expect(selection).not.toBeNull();
    expect(selection?.permissionProfileId).toBe(WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID);
    expect(selection?.runtimeWorkspaceRoots).toEqual(["/workspace/project"]);
    expect(selection?.config).toEqual({
      permissions: {
        [WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID]: {
          filesystem: {
            ":minimal": "read",
            ":workspace_roots": {
              ".": "write",
            },
          },
          network: {
            enabled: false,
          },
        },
      },
    });
  });

  test("keeps a read-only workspace read-only and can allow temp reads", () => {
    const selection = buildCodexWorkspacePermissionSelection({
      sandboxMode: "read-only",
      readAccessMode: "workspace-only",
      networkAccess: true,
      allowTempAccess: true,
      cwd: "/workspace/project",
    });

    expect(selection?.config).toEqual({
      permissions: {
        [WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID]: {
          filesystem: {
            ":minimal": "read",
            ":workspace_roots": {
              ".": "read",
            },
            ":tmpdir": "read",
          },
          network: {
            enabled: true,
          },
        },
      },
    });
  });

  test("uses the stable sandbox contract when full-system reads are allowed", () => {
    expect(buildCodexWorkspacePermissionSelection({
      sandboxMode: "workspace-write",
      readAccessMode: "full-system",
      networkAccess: true,
      cwd: "/workspace/project",
    })).toBeNull();
  });
});
