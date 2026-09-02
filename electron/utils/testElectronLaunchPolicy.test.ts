import { describe, expect, test } from "bun:test";
import { buildTestElectronLaunchArgs } from "./testElectronLaunchPolicy";

describe("buildTestElectronLaunchArgs", () => {
  test("keeps the existing renderer safeguards for ordinary Windows tests", () => {
    expect(
      buildTestElectronLaunchArgs({
        platform: "win32",
        desktopCapturable: false,
      }),
    ).toEqual([
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-software-rasterizer",
      "--disable-setuid-sandbox",
      "--disable-extensions",
    ]);
  });

  test("enables Windows desktop-capturable rendering only when requested", () => {
    expect(
      buildTestElectronLaunchArgs({
        platform: "win32",
        desktopCapturable: true,
      }),
    ).toEqual([
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--disable-extensions",
    ]);
  });

  test("does not change non-Windows test rendering when requested", () => {
    expect(
      buildTestElectronLaunchArgs({
        platform: "linux",
        desktopCapturable: true,
      }),
    ).toEqual([
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-software-rasterizer",
      "--disable-setuid-sandbox",
      "--disable-extensions",
    ]);
  });
});
