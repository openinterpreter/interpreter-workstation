import type { BuiltinServerDefinition } from "../../builtinTools";
import { hasHostedApi } from "../../../../shared/productConfig";
import { estimateMediaCostTool } from "./estimateCostTool";
import { runMediaModelTool } from "./runModelTool";
import { searchMediaModelsTool } from "./searchModelsTool";

export const mediaAiServerDefinition: BuiltinServerDefinition | null = hasHostedApi() ? {
  id: "builtin-media-ai",
  name: "Media AI",
  description: "Generate and transform media with hosted media models.",
  isBuiltin: true,
  tools: [searchMediaModelsTool, estimateMediaCostTool, runMediaModelTool],
  resources: [],
  prompts: [],
} : null;
