import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { createRouter, levelFor } from "../src/router.ts";
import { type Route, type RouteRequest, RoutesError } from "../src/routes.ts";

const catalog = {
	"anthropic/claude-opus-5-5": { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 },
	"local/glm": { provider: "local", id: "glm", contextWindow: 20_000 },
};
const config = {
	models: { "anthropic/claude-opus-5.5": "anthropic/claude-opus-5-5", "z-ai/glm-5.3-flash": "local/glm" },
	prices: { "z-ai/glm-5.3-flash": { input: 0, output: 0 } },
	fallback: "anthropic/claude-opus-5-5",
};

function fakeCtx() {
	const status: string[] = [];
	const notes: string[] = [];
	const ctx = {
		modelRegistry: { find: (provider: string, id: string) => catalog[`${provider}/${id}` as keyof typeof catalog] },
		sessionManager: { getSessionId: () => "session-1" },
		ui: { setStatus: (_key: string, text: string) => status.push(text), notify: (text: string) => notes.push(text) },
		getSystemPrompt: () => "You are Pi.",
	} as unknown as ExtensionContext;
	return { ctx, status, notes };
}

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const request = (fields: Partial<ModelRouteRequest>) =>
	({ reason: "user", thinkingLevel: "off", messages: [user("hi")], ...fields }) as ModelRouteRequest;
const route = (model: string, thinking: Route["thinking"] = { mode: "off", budget_tokens: null }): Route => ({
	route_id: "rt_1",
	model,
	thinking,
	warnings: [],
	usage: { encoded_input_tokens: 100, cache_read_tokens: 0 },
	latency_ms: 10,
});

function router(answer: (body: RouteRequest) => Route | Promise<Route>) {
	const sent: RouteRequest[] = [];
	const r = createRouter(config, {
		apiKey: async () => "rlk-test",
		tools: () => [],
		requestRoute: async (body) => {
			sent.push(body);
			return answer(body);
		},
	});
	return { ...r, sent };
}

test("a user turn asks ARC and runs the model it chose", async () => {
	const r = router(() => route("z-ai/glm-5.3-flash", { mode: "on", budget_tokens: 8192 }));
	const { ctx, status } = fakeCtx();
	const result = await r.route(request({}), ctx);
	assert.equal(result.model.id, "glm");
	assert.equal(result.thinkingLevel, "high");
	assert.deepEqual(r.sent[0].routing?.models, ["anthropic/claude-opus-5.5", "z-ai/glm-5.3-flash"]);
	assert.deepEqual(r.sent[0].routing?.prices, config.prices);
	assert.equal(r.sent[0].model, "arc-swift-1.0");
	assert.equal(r.sent[0].system, "You are Pi.");
	assert.match(status.at(-1)!, /^route: \d+ ms$/);
	assert.equal(r.stats.lookups, 1);
});

test("a tool follow-up stays on the previous model without a lookup", async () => {
	const r = router(() => assert.fail("no lookup expected"));
	const previous = { model: catalog["local/glm"], thinkingLevel: "low" } as ModelRouteRequest["previous"];
	const result = await r.route(request({ reason: "continuation", previous }), fakeCtx().ctx);
	assert.equal(result.model.id, "glm");
	assert.equal(result.thinkingLevel, "low");
});

test("a model whose window cannot hold the conversation is not offered", async () => {
	const r = router(() => route("anthropic/claude-opus-5.5"));
	await r.route(request({ messages: [user("x".repeat(40_000))] }), fakeCtx().ctx);
	assert.deepEqual(r.sent[0].routing?.models, ["anthropic/claude-opus-5.5"]);
});

test("a retry after an overloaded provider asks again without that model", async () => {
	const r = router(() => route("anthropic/claude-opus-5.5"));
	const failed = { model: catalog["local/glm"], message: { errorMessage: "529 overloaded" } } as ModelRouteRequest["failed"];
	await r.route(request({ reason: "retry", failed }), fakeCtx().ctx);
	assert.deepEqual(r.sent[0].routing?.models, ["anthropic/claude-opus-5.5"]);
});

test("when ARC is unavailable the turn falls back with a warning", async () => {
	const r = router(() => {
		throw new RoutesError(503, "unavailable", "try later");
	});
	const { ctx, notes } = fakeCtx();
	const result = await r.route(request({}), ctx);
	assert.equal(result.model.id, "claude-opus-5-5");
	assert.match(notes[0], /unavailable/);
	assert.equal(r.stats.fallbacks, 1);
});

test("a bad key fails the turn instead of hiding behind the fallback", async () => {
	const r = router(() => {
		throw new RoutesError(401, undefined, "invalid key");
	});
	await assert.rejects(r.route(request({}), fakeCtx().ctx), /401/);
});

test("a model ARC chose that is not configured is an error", async () => {
	const r = router(() => route("openai/gpt-6-luna"));
	await assert.rejects(r.route(request({}), fakeCtx().ctx), /not in your models/);
});

test("thinking maps to Pi levels with the documented thresholds", () => {
	assert.equal(levelFor({ mode: "off", budget_tokens: null }), "off");
	assert.equal(levelFor({ mode: "on", budget_tokens: null }), "medium");
	assert.equal(levelFor({ mode: "on", budget_tokens: 2000 }), "low");
	assert.equal(levelFor({ mode: "on", budget_tokens: 4000 }), "medium");
	assert.equal(levelFor({ mode: "on", budget_tokens: 8192 }), "high");
});
