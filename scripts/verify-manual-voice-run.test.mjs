import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyManualVoiceRun } from "./verify-manual-voice-run.mjs";

const tempDirs = [];

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRunDir(overrides = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-voice-run-"));
  tempDirs.push(runDir);
  const videoPath = path.join(runDir, "recording.mp4");
  fs.writeFileSync(videoPath, "recorded");
  writeJson(path.join(runDir, "run.json"), {
    scenario: { id: "overlay-voice:manual-verification" },
    target: "local-mac",
    manual: true,
    record: true,
    ...(overrides.run ?? {}),
  });
  writeJson(path.join(runDir, "manual-voice-checklist.json"), {
    expectedFlow: ["Speak concrete answers."],
    passCriteria: ["No fullscreen blocking overlay traps the operator."],
    ...(overrides.checklist ?? {}),
  });
  writeJson(path.join(runDir, "manual-voice-result.json"), {
    result: "pass",
    recordingRequired: true,
    ...(overrides.result ?? {}),
  });
  writeJson(path.join(runDir, "recording.json"), {
    videoPath,
    ...(overrides.recording ?? {}),
  });
  writeJson(path.join(runDir, "completed.json"), {
    completedAt: "2026-06-28T10:00:00.000Z",
    ...(overrides.completed ?? {}),
  });
  return { runDir, videoPath };
}

describe("verifyManualVoiceRun", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a completed recorded manual voice run", () => {
    const { runDir, videoPath } = createRunDir();
    expect(verifyManualVoiceRun(runDir)).toMatchObject({
      ok: true,
      scenarioId: "overlay-voice:manual-verification",
      target: "local-mac",
      recording: {
        videoPath,
        size: 8,
      },
      completedAt: "2026-06-28T10:00:00.000Z",
    });
  });

  test("rejects unrecorded runs", () => {
    const { runDir } = createRunDir({ run: { record: false } });
    expect(() => verifyManualVoiceRun(runDir)).toThrow("run.record=true");
  });

  test("rejects failing operator result", () => {
    const { runDir } = createRunDir({ result: { result: "fail" } });
    expect(() => verifyManualVoiceRun(runDir)).toThrow("Manual voice run did not pass");
  });

  test("rejects missing recording video", () => {
    const { runDir, videoPath } = createRunDir();
    fs.rmSync(videoPath);
    expect(() => verifyManualVoiceRun(runDir)).toThrow("Recording video is missing");
  });

  test("CLI prints verification JSON for a completed run", () => {
    const { runDir, videoPath } = createRunDir();
    const output = execFileSync("node", ["scripts/verify-manual-voice-run.mjs", runDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      scenarioId: "overlay-voice:manual-verification",
      recording: {
        videoPath,
      },
    });
  });
});
