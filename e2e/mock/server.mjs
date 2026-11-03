// A deterministic OpenAI-compatible endpoint for the pie end-to-end tests.
// The reply depends only on the last user text, so a run is repeatable and
// needs no provider credential.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const MODEL = "mock-echo";
const CHUNK_MS = Number(process.env.CHUNK_MS ?? 5);

/** OpenAI sends message content as a string or as parts. */
function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((part) => part?.type === "text")
            .map((part) => part.text ?? "")
            .join("");
    }
    return "";
}

function lastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === "user") return textOf(messages[i].content).trim();
    }
    return "";
}

/** The last tool call of this turn, and the result pi sent back. A tool pair
 *  from an older turn must not answer a new user message. */
function pendingTool(messages) {
    const lastUser = messages.findLastIndex((message) => message?.role === "user");
    let name;
    let result = "";
    for (const message of messages.slice(lastUser + 1)) {
        if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
            name = message.tool_calls.at(-1)?.function?.name ?? name;
            result = "";
        }
        if (message?.role === "tool") result = textOf(message.content);
    }
    return name === undefined ? null : { name, result };
}

function toolCall(name, args) {
    return {
        delta: {
            tool_calls: [
                {
                    index: 0,
                    id: "call_mock_1",
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                },
            ],
        },
        finish: "tool_calls",
    };
}

/** The scripted replies, keyed by the last user text. */
function script(user, tool) {
    if (tool !== null) {
        if (tool.name === "ask_user") {
            let answer = "no answer";
            try {
                const parsed = JSON.parse(tool.result);
                answer = JSON.stringify(parsed.answers ?? parsed);
            } catch {
                answer = tool.result.trim() || answer;
            }
            return { text: `The answer was ${answer}. The run continues.` };
        }
        if (tool.name === "bash") {
            return { text: "The command printed: mock-tool-output" };
        }
        return { text: "The tool finished." };
    }

    if (user.startsWith("tool")) {
        return {
            reasoning: ["The user wants a tool call.", "I will run echo."],
            ...toolCall("bash", { command: "echo mock-tool-output" }),
        };
    }
    if (user.startsWith("ask")) {
        return {
            ...toolCall("ask_user", {
                question: "Which mode should the mock use?",
                context: "This prompt comes from the pie end-to-end fixture.",
                options: [
                    { title: "Fast", description: "Stream at once." },
                    { title: "Safe", description: "Stream with delays." },
                ],
                allowMultiple: false,
            }),
        };
    }
    if (user.startsWith("wait")) {
        return { text: "The wait is over.", waitMs: 2500 };
    }
    if (user.startsWith("slow")) {
        const words = Array.from({ length: 30 }, (_, i) => `chunk-${i + 1}`);
        return {
            text: words.join(" "),
            chunkMs: 400,
            reasoning: ["This reply is slow on purpose."],
        };
    }
    return {
        text: "Hello from the pie mock. This reply is deterministic.",
        reasoning: ["A fixed greeting keeps the test repeatable."],
    };
}

function chunk(delta, finish = null) {
    return {
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1_760_000_000,
        model: MODEL,
        choices: [{ index: 0, delta, finish_reason: finish }],
    };
}

function chunksOf(reply) {
    const chunks = [];
    for (const reasoning of reply.reasoning ?? []) {
        chunks.push(chunk({ reasoning_content: reasoning }));
    }
    if (reply.delta !== undefined) {
        chunks.push(chunk(reply.delta));
    }
    if (reply.text !== undefined) {
        const words = reply.text.split(" ");
        words.forEach((word, i) => {
            chunks.push(chunk({ content: i === words.length - 1 ? word : `${word} ` }));
        });
    }
    chunks.push(chunk({}, reply.finish ?? "stop"));
    return chunks;
}

function usageOf(reply) {
    return {
        prompt_tokens: 32,
        completion_tokens: (reply.text ?? "").split(" ").length,
        total_tokens: 40,
    };
}

async function readBody(request) {
    const parts = [];
    for await (const part of request) parts.push(part);
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
            JSON.stringify({
                object: "list",
                data: [{ id: MODEL, object: "model", owned_by: "pie-e2e" }],
            }),
        );
        return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
    }

    const body = await readBody(request);
    const user = lastUserText(body.messages ?? []);
    const tool = pendingTool(body.messages ?? []);
    const reply = script(user, tool);
    const chunks = chunksOf(reply);

    console.log(
        JSON.stringify({
            user,
            tool: tool?.name ?? null,
            text: reply.text ?? null,
        }),
    );

    if (body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
            JSON.stringify({
                id: "chatcmpl-mock",
                object: "chat.completion",
                created: 1_760_000_000,
                model: MODEL,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: reply.text ?? null,
                            ...(reply.delta ? { tool_calls: reply.delta.tool_calls } : {}),
                        },
                        finish_reason: reply.finish ?? "stop",
                    },
                ],
                usage: usageOf(reply),
            }),
        );
        return;
    }

    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    if (reply.waitMs !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.waitMs));
    for (const item of chunks) {
        response.write(`data: ${JSON.stringify(item)}\n\n`);
        const delay = reply.chunkMs ?? CHUNK_MS;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    response.write("data: [DONE]\n\n");
    response.end();
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`mock listening on ${PORT}`);
});
