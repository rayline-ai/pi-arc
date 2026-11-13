import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { toAnthropic } from "../src/transcript.ts";

test("tool calls and results become Anthropic blocks; thinking is dropped", () => {
	const messages = [
		{ role: "user", content: "read a.txt", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
			],
		},
		{ role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: "A" }] },
		{ role: "user", content: "thanks", timestamp: 0 },
	] as unknown as Message[];
	assert.deepEqual(toAnthropic(messages).messages, [
		{ role: "user", content: [{ type: "text", text: "read a.txt" }] },
		{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } }] },
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "A" }] },
				{ type: "text", text: "thanks" },
			],
		},
	]);
});
