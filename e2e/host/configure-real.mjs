// Writes the real-profile configuration of the test host. A base URL turns the
// provider into a custom OpenAI-compatible endpoint in models.json; without
// one, a built-in provider reads its key from auth.json. The key is not here:
// both files name the Docker secret through a command.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agent = "/home/pi/.pi/agent";
const keyCommand = "!cat /home/pi/.pi/agent/real.key";

const provider = env("PIE_E2E_PROVIDER");
const model = env("PIE_E2E_MODEL");
const level = env("PIE_E2E_THINKING") || "low";
const baseUrl = env("PIE_E2E_BASE_URL");
const api = env("PIE_E2E_API") || "openai-completions";
const reasoning = flag("PIE_E2E_REASONING", false);
const vision = flag("PIE_E2E_VISION", false);
const modelName = env("PIE_E2E_MODEL_NAME") || model;
const contextWindow = integer("PIE_E2E_CONTEXT_WINDOW", 128000);
const maxTokens = integer("PIE_E2E_MAX_TOKENS", 16384);

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const apis = new Set([
    "openai-completions",
    "mistral-conversations",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-vertex",
    "pi-messages",
]);
const token = /^[A-Za-z0-9._/-]+$/;

if (!token.test(provider)) {
    console.error(`pie-e2e: PIE_E2E_PROVIDER is not a provider id: ${provider}`);
    process.exit(1);
}
if (!token.test(model)) {
    console.error(`pie-e2e: PIE_E2E_MODEL is not a model id: ${model}`);
    process.exit(1);
}
if (!levels.has(level)) {
    console.error(`pie-e2e: PIE_E2E_THINKING is not a level: ${level}`);
    process.exit(1);
}
if (baseUrl !== "") {
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not HTTP");
    } catch {
        console.error(`pie-e2e: PIE_E2E_BASE_URL is not an HTTP URL: ${baseUrl}`);
        process.exit(1);
    }
    if (!apis.has(api)) {
        console.error(`pie-e2e: PIE_E2E_API is not a known API: ${api}`);
        process.exit(1);
    }
}

const settings = {
    defaultProvider: provider,
    defaultModel: model,
    defaultThinkingLevel: level,
    quietStartup: true,
    packages: ["npm:pi-ask-user@0.17.2", "npm:pi-permission-system@0.8.0"],
};

writeFileSync(join(agent, "settings.json"), `${JSON.stringify(settings, null, 4)}\n`);

if (baseUrl === "") {
    writeFileSync(
        join(agent, "auth.json"),
        `${JSON.stringify(
            {
                [provider]: { type: "api_key", key: keyCommand },
            },
            null,
            4,
        )}\n`,
    );
    rmSync(join(agent, "models.json"), { force: true });
    console.log(`pie-e2e: real profile ${provider}/${model} at ${level}`);
} else {
    const isOllama = baseUrl !== "" && new URL(baseUrl).hostname === "ollama.com";
    const modelEntry = {
        id: model,
        name: modelName,
        reasoning,
        input: vision ? ["text", "image"] : ["text"],
        contextWindow,
        maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(api === "openai-completions"
            ? {
                  // The conservative set for an OpenAI-compatible endpoint: the older
                  // token field, no store, no developer role, no session affinity.
                  compat: {
                      maxTokensField: "max_tokens",
                      requiresAssistantAfterToolResult: false,
                      requiresReasoningContentOnAssistantMessages: false,
                      requiresThinkingAsText: false,
                      requiresToolResultName: false,
                      sendSessionAffinityHeaders: false,
                      supportsDeveloperRole: false,
                      supportsLongCacheRetention: false,
                      supportsReasoningEffort: reasoning,
                      supportsStore: false,
                      supportsStrictMode: false,
                      supportsUsageInStreaming: true,
                      thinkingFormat: "openai",
                      zaiToolStream: false,
                  },
              }
            : {}),
        // Ollama Cloud names the levels its own way; its catalog maps xhigh to max.
        ...(isOllama && reasoning
            ? {
                  thinkingLevelMap: {
                      off: "none",
                      minimal: null,
                      low: "low",
                      medium: "medium",
                      high: "high",
                      xhigh: "max",
                  },
              }
            : {}),
    };
    writeFileSync(
        join(agent, "models.json"),
        `${JSON.stringify(
            {
                providers: {
                    [provider]: {
                        baseUrl,
                        api,
                        apiKey: keyCommand,
                        models: [modelEntry],
                    },
                },
            },
            null,
            4,
        )}\n`,
    );
    rmSync(join(agent, "auth.json"), { force: true });
    console.log(`pie-e2e: real profile ${provider}/${model} at ${level} through ${baseUrl} (${api})`);
}

function env(name) {
    return (process.env[name] ?? "").trim();
}

function flag(name, fallback) {
    const value = env(name).toLowerCase();
    if (value === "") return fallback;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    console.error(`pie-e2e: ${name} is not a yes or no: ${value}`);
    process.exit(1);
}

function integer(name, fallback) {
    const value = env(name);
    if (value === "") return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        console.error(`pie-e2e: ${name} is not a positive integer: ${value}`);
        process.exit(1);
    }
    return number;
}
