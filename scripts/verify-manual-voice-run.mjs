#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_SCENARIO_ID = "overlay-voice:manual-verification";

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required artifact: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function resolveArtifactPath(runDir, artifactPath) {
  const value = requireNonEmptyString(artifactPath, "recording.videoPath");
  return path.isAbsolute(value) ? value : path.join(runDir, value);
}

export function verifyManualVoiceRun(runDir) {
  const resolvedRunDir = path.resolve(runDir);
  const run = readJson(path.join(resolvedRunDir, "run.json"));
  const checklist = readJson(path.join(resolvedRunDir, "manual-voice-checklist.json"));
  const result = readJson(path.join(resolvedRunDir, "manual-voice-result.json"));
  const recording = readJson(path.join(resolvedRunDir, "recording.json"));
  const completed = readJson(path.join(resolvedRunDir, "completed.json"));

  if (run.scenario?.id !== REQUIRED_SCENARIO_ID) {
    throw new Error(`Expected scenario id ${REQUIRED_SCENARIO_ID}, got ${run.scenario?.id ?? "<missing>"}`);
  }
  if (run.manual !== true) {
    throw new Error("Manual voice run must have run.manual=true");
  }
  if (run.record !== true) {
    throw new Error("Manual voice run must have run.record=true");
  }
  if (!Array.isArray(checklist.expectedFlow) || checklist.expectedFlow.length === 0) {
    throw new Error("manual-voice-checklist.json must include expectedFlow");
  }
  if (!Array.isArray(checklist.passCriteria) || checklist.passCriteria.length === 0) {
    throw new Error("manual-voice-checklist.json must include passCriteria");
  }
  if (result.result !== "pass") {
    throw new Error(`Manual voice run did not pass: ${result.result ?? "<missing>"}`);
  }
  if (result.recordingRequired !== true) {
    throw new Error("manual-voice-result.json must record recordingRequired=true");
  }

  const videoPath = resolveArtifactPath(resolvedRunDir, recording.videoPath);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Recording video is missing: ${videoPath}`);
  }
  const videoStat = fs.statSync(videoPath);
  if (videoStat.size <= 0) {
    throw new Error(`Recording video is empty: ${videoPath}`);
  }
  requireNonEmptyString(completed.completedAt, "completed.completedAt");

  return {
    ok: true,
    runDir: resolvedRunDir,
    scenarioId: run.scenario.id,
    target: run.target,
    recording: {
      videoPath,
      size: videoStat.size,
      metadataPath: path.join(resolvedRunDir, "recording.json"),
    },
    completedAt: completed.completedAt,
  };
}

function main(argv) {
  const runDir = argv[2];
  if (!runDir) {
    throw new Error("Usage: node scripts/verify-manual-voice-run.mjs <scenario-run-dir>");
  }
  console.log(JSON.stringify(verifyManualVoiceRun(runDir), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
