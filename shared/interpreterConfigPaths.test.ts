import { describe, expect, test } from "bun:test";

import { resolveInterpreterDataDir } from "./interpreterConfigPaths";

describe("resolveInterpreterDataDir", () => {
  test("uses explicit Interpreter user data dir before Electron userData", () => {
    expect(
      resolveInterpreterDataDir(
        "darwin",
        { INTERPRETER_USER_DATA_DIR: "/tmp/interpreter-user-data" },
        "/Users/example",
        () => "/tmp/electron-user-data",
      ),
    ).toBe("/tmp/interpreter-user-data");
  });

  test("uses Electron userData when no explicit Interpreter user data dir is set", () => {
    expect(
      resolveInterpreterDataDir(
        "darwin",
        {},
        "/Users/example",
        () => "/tmp/electron-user-data",
      ),
    ).toBe("/tmp/electron-user-data");
  });
});
