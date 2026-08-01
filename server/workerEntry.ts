import "./logger";

import dotenv from "dotenv";
dotenv.config();

import { runStandaloneCli } from "./standalone";

void runStandaloneCli().catch((err) => {
  console.error("[WorkerEntry] Fatal error:", err);
  process.exit(1);
});
