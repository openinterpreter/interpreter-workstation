import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCHEMAS_DIR = resolve(
  HERE,
  "../../../server/handlers/codex-generated-types/json/v2",
);
const OUT_DIR = resolve(HERE, "generated");

mkdirSync(OUT_DIR, { recursive: true });

function compileAndWrite(
  schemas: Record<string, object>,
  exportMap: Record<string, string>,
  outFile: string,
  typeMap?: Record<string, { importPath: string; typeName: string }>,
) {
  const ajv = new Ajv({
    code: { source: true, esm: true },
    allErrors: false,
    validateFormats: false,
  });

  for (const [key, schema] of Object.entries(schemas)) {
    ajv.addSchema(schema, key);
  }

  writeFileSync(join(OUT_DIR, outFile), standaloneCode(ajv, exportMap));

  const dtsFile = outFile.replace(/\.js$/, ".d.ts");
  const exports = Object.keys(exportMap);

  const typeImports = new Map<string, Set<string>>();
  if (typeMap) {
    for (const { importPath, typeName } of Object.values(typeMap)) {
      if (!typeImports.has(importPath)) typeImports.set(importPath, new Set());
      typeImports.get(importPath)!.add(typeName);
    }
  }

  const lines = [
    'import type { ValidateFunction } from "ajv";',
    ...Array.from(typeImports.entries()).map(
      ([path, types]) =>
        `import type { ${Array.from(types).sort().join(", ")} } from "${path}";`,
    ),
    "",
    ...exports.map((name) => {
      const t = typeMap?.[name];
      return t
        ? `export declare const ${name}: ValidateFunction<${t.typeName}>;`
        : `export declare const ${name}: ValidateFunction;`;
    }),
    "",
  ];
  writeFileSync(join(OUT_DIR, dtsFile), lines.join("\n"));
}

const lifecycleFiles: Record<string, string> = {
  ThreadStartedNotification: "ThreadStartedNotification.json",
  TurnStartedNotification: "TurnStartedNotification.json",
  TurnCompletedNotification: "TurnCompletedNotification.json",
  ItemStartedNotification: "ItemStartedNotification.json",
  ItemCompletedNotification: "ItemCompletedNotification.json",
  ErrorNotification: "ErrorNotification.json",
};

const lifecycleSchemas: Record<string, object> = {};
for (const [key, file] of Object.entries(lifecycleFiles)) {
  lifecycleSchemas[key] = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, file), "utf-8"),
  );
}

compileAndWrite(
  lifecycleSchemas,
  {
    validateThreadStarted: "ThreadStartedNotification",
    validateTurnStarted: "TurnStartedNotification",
    validateTurnCompleted: "TurnCompletedNotification",
    validateItemStarted: "ItemStartedNotification",
    validateItemCompleted: "ItemCompletedNotification",
    validateError: "ErrorNotification",
  },
  "lifecycle.js",
);

compileAndWrite(
  {
    StreamRequestBody: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        callerToken: { type: "string" },
        message: { type: "string" },
        system: { type: "string" },
        threadId: { type: ["string", "null"] },
        workspacePath: { type: ["string", "null"] },
        model: { type: "string" },
        profileId: { type: "string" },
        codexProfileId: { type: "string" },
        customEndpoint: { type: "string" },
        customApiKey: { type: "string" },
        attachments: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "kind", "name", "mimeType", "dataUrl"],
            properties: {
              id: { type: "string" },
              kind: { const: "image" },
              name: { type: "string" },
              mimeType: { type: "string" },
              dataUrl: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    StopRequestBody: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: { type: "string" },
        turnId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    validateStreamRequestBody: "StreamRequestBody",
    validateStopRequestBody: "StopRequestBody",
  },
  "http.js",
  {
    validateStreamRequestBody: {
      importPath: "@/lib/codex/api-types",
      typeName: "StreamRequestBody",
    },
    validateStopRequestBody: {
      importPath: "@/lib/codex/api-types",
      typeName: "StopRequestBody",
    },
  },
);

const sharedConfigProperties = {
  enabled: { type: "boolean" },
  required: { type: "boolean" },
  startupTimeoutSec: { type: "number" },
  toolTimeoutSec: { type: "number" },
  defaultToolsApprovalMode: { enum: ["auto", "prompt", "approve"] },
  tools: {
    type: "object",
    additionalProperties: {
      type: "object",
      properties: {
        approvalMode: { enum: ["auto", "prompt", "approve"] },
      },
      additionalProperties: false,
    },
  },
  enabledTools: { type: "array", items: { type: "string" } },
  disabledTools: { type: "array", items: { type: "string" } },
  scopes: { type: "array", items: { type: "string" } },
};

const stdioConfigSchema = {
  type: "object",
  required: ["transport", "command"],
  properties: {
    transport: { const: "stdio" },
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    env: { type: "object", additionalProperties: { type: "string" } },
    envVars: { type: "array", items: { type: "string" } },
    cwd: { type: "string" },
    ...sharedConfigProperties,
  },
  additionalProperties: false,
};

const httpConfigSchema = {
  type: "object",
  required: ["transport", "url"],
  properties: {
    transport: { const: "streamable_http" },
    url: { type: "string" },
    oauthResource: { type: "string" },
    bearerTokenEnvVar: { type: "string" },
    httpHeaders: { type: "object", additionalProperties: { type: "string" } },
    envHttpHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    ...sharedConfigProperties,
  },
  additionalProperties: false,
};

const mcpServerConfigSchema = {
  oneOf: [stdioConfigSchema, httpConfigSchema],
};

compileAndWrite(
  {
    CreateMcpServerBody: {
      type: "object",
      required: ["name", "config"],
      properties: {
        name: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        config: mcpServerConfigSchema,
      },
      additionalProperties: false,
    },
    UpdateMcpServerBody: mcpServerConfigSchema,
    OAuthLoginBody: {
      type: "object",
      properties: {
        scopes: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    validateCreateMcpServerBody: "CreateMcpServerBody",
    validateUpdateMcpServerBody: "UpdateMcpServerBody",
    validateOAuthLoginBody: "OAuthLoginBody",
  },
  "mcp.js",
  {
    validateCreateMcpServerBody: {
      importPath: "@/lib/codex/api-types",
      typeName: "CreateMcpServerBody",
    },
    validateUpdateMcpServerBody: {
      importPath: "@/lib/codex/api-types",
      typeName: "UpdateMcpServerBody",
    },
    validateOAuthLoginBody: {
      importPath: "@/lib/codex/api-types",
      typeName: "OAuthLoginBody",
    },
  },
);

compileAndWrite(
  {
    JsonRpcResponse: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: ["number", "string"] },
      },
      anyOf: [{ required: ["result"] }, { required: ["error"] }],
    },
  },
  {
    validateJsonRpcResponse: "JsonRpcResponse",
  },
  "json-rpc.js",
);

console.log("Validators compiled successfully.");
