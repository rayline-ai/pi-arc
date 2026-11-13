import assert from "node:assert/strict";
import { test } from "node:test";
import { actionIdOf, capacity, executionContext, workerOf } from "../src/execution.ts";
import type { Transcript } from "../src/transcript.ts";

test("action IDs match the ones raydock hybrid derives", () => {
	assert.equal(workerOf("z-ai/glm-5.3-flash"), "glm-5.3-flash");
	assert.equal(actionIdOf("z-ai/glm-5.3-flash"), "bd202891c3ed5bf9af5250868da17cb3ad68a05184ec5fa757876880257a5b26");
	assert.equal(actionIdOf("openai/gpt-6-luna"), "21324c14b079ebff6d402361a26511bf7991107fe920ded73607361c3a1eba44");
});

test("capacity is an upper bound from bytes, template margin and the reply", () => {
	assert.deepEqual(capacity(1000, { window: 2000, output: 400 }), {
		fits: true,
		reason: null,
		required: 1962,
		available: 2000,
		available_source: "configured",
		units: null,
		provenance: "caller_bounded",
	});
	assert.equal(capacity(1000, { window: 1900, output: 400 }).reason, "context_capacity");
	assert.equal(capacity(10, { window: 2000, output: 0 }, true).provenance, "caller_estimated");
});

const transcript = (texts: string[]): Transcript => ({
	system: "",
	messages: texts.map((text, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text }] })),
	assistants: new Map(
		texts.flatMap((_, i) => (i % 2 ? [[i, { provider: "local", model: "glm" }]] : [])) as never,
	),
});

test("names the event, the history and the model that answered last", () => {
	const context = executionContext({
		transcript: transcript(["hi", "hello", "more"]),
		sessionId: "s",
		reason: "user",
		rewritten: false,
		arcOf: (provider) => (provider === "local" ? "z-ai/glm-5.3-flash" : undefined),
		lastServed: "z-ai/glm-5.3-flash",
		targets: [{ target: { arc: "z-ai/glm-5.3-flash", pi: "local/glm", placement: "local" }, capacity: null }],
	});
	const glm = actionIdOf("z-ai/glm-5.3-flash");
	assert.equal(context.event.kind, "user_message");
	assert.deepEqual(context.history, [{ message: 1, action_id: glm }]);
	assert.deepEqual(context.last_served, { action_id: glm, worker: "glm-5.3-flash", message: 1 });
	assert.deepEqual(context.targets[0], { action_id: glm, worker: "glm-5.3-flash", placement: "local", cache: null, capacity: null });
});
