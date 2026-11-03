// Proves the mock endpoint is deterministic and scripts the three replies the
// app tests rely on.

const base = process.argv[2] ?? "http://127.0.0.1:18080";

const failures = [];
function expect(condition, message) {
    if (!condition) failures.push(message);
}

async function complete(messages) {
    const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-echo", stream: true, messages }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const content = [];
    const reasoning = [];
    const toolCalls = [];
    let finish = null;
    for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};
        if (delta.content) content.push(delta.content);
        if (delta.reasoning_content) reasoning.push(delta.reasoning_content);
        for (const call of delta.tool_calls ?? []) {
            toolCalls.push({
                name: call.function.name,
                arguments: call.function.arguments,
            });
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
    }
    return {
        content: content.join(""),
        reasoning: reasoning.join(""),
        toolCalls,
        finish,
    };
}

try {
    const first = await complete([{ role: "user", content: "hello" }]);
    const second = await complete([{ role: "user", content: "hello" }]);
    expect(first.content === second.content, "the same prompt answered differently");
    expect(first.content.includes("Hello from the pie mock"), `unexpected greeting ${JSON.stringify(first.content)}`);
    expect(first.reasoning !== "", "the mock streamed no reasoning");
    expect(first.finish === "stop", `greeting finished with ${JSON.stringify(first.finish)}`);

    const tool = await complete([{ role: "user", content: "tool" }]);
    expect(tool.finish === "tool_calls", `tool finished with ${JSON.stringify(tool.finish)}`);
    expect(tool.toolCalls[0]?.name === "bash", "the tool reply did not call bash");
    expect(tool.toolCalls[0]?.arguments.includes("echo mock-tool-output"), "the tool reply lost its command");

    const answer = await complete([
        { role: "user", content: "tool" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "call_mock_1",
                    type: "function",
                    function: {
                        name: "bash",
                        arguments: '{"command":"echo mock-tool-output"}',
                    },
                },
            ],
        },
        { role: "tool", tool_call_id: "call_mock_1", content: "mock-tool-output" },
    ]);
    expect(
        answer.content.includes("The command printed: mock-tool-output"),
        `unexpected tool follow-up ${JSON.stringify(answer.content)}`,
    );

    const ask = await complete([{ role: "user", content: "ask" }]);
    expect(ask.toolCalls[0]?.name === "ask_user", "the ask reply did not call ask_user");
    const args = JSON.parse(ask.toolCalls[0]?.arguments ?? "{}");
    expect(typeof args.question === "string", "ask_user lost its question");
    expect(Array.isArray(args.options) && args.options.length === 2, "ask_user lost its options");
} catch (error) {
    failures.push(String(error.message ?? error));
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`ENV-09 FAIL ${failure}`);
    process.exit(1);
}
console.log("ENV-09 PASS mock is deterministic and scripts hello, tool, and ask");
