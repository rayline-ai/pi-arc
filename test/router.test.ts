import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { actionIdOf } from "../src/execution.ts";
import { createRouter, type RouterState } from "../src/router.ts";
import { type RouteRequest, type RouteResponse, RoutesError } from "../src/routes.ts";

const catalog = {
	"local/glm": { provider: "local", id: "glm", contextWindow: 100_000, maxTokens: 8_000 },
	"rayline/claude-haiku-5-5": { provider: "rayline", id: "claude-haiku-5-5", contextWindow: 1_000_000, maxTokens: 32_000 },
};
const config = {
	local: { "z-ai/glm-5.3-flash": "local/glm" },
	cloud: { "anthropic/claude-haiku-5.5": "rayline/claude-haiku-5-5" },
	fallback: "local/glm",
};

function fakeCtx() {
	const notes: string[] = [];
	const ctx = {
		modelRegistry: { find: (provider: string, id: string) => catalog[`${provider}/${id}` as keyof typeof catalog] },
		sessionManager: { getSessionId: () => "session-1" },
		ui: { setStatus: () => {}, notify: (text: string) => notes.push(text) },
		getSystemPrompt: () => "You are Pi.",
	} as unknown as ExtensionContext;
	return { ctx, notes };
}

type Request = ModelRouteRequest<RouterState>;
const request = (fields: Partial<Request>) =>
	({ reason: "user", thinkingLevel: "off", messages: [{ role: "user", content: "hi", timestamp: 0 }], ...fields }) as Request;
/** ARC's answer to `body`, choosing `arc`, with the echoes a real response carries. */
const chose = (arc: string) => (body: RouteRequest): RouteResponse => ({
	route_id: "rt_1",
	presets: { swift: { model: arc, identity: { action_id: actionIdOf(arc) } } },
	routing: {
		execution: { status: "applied", turn: (body.routing.execution as { turn: unknown }).turn },
		policy: { status: "applied", preset: "arc-policy.prefer-local.v1" },
	} as RouteResponse["routing"],
	usage: { encoded_input_tokens: 100 },
});

function router(answer: (body: RouteRequest) => RouteResponse) {
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
const execution = (body: RouteRequest) => body.routing.execution as { targets: { worker: string; capacity: unknown }[] };

test("a user turn sends hybrid's routing and runs the action ARC chose", async () => {
	const r = router(chose("z-ai/glm-5.3-flash"));
	const result = await r.route(request({}), fakeCtx().ctx);
	assert.equal(result.model.id, "glm");
	const body = r.sent[0];
	assert.equal(body.model, "arc-swift-1.0");
	assert.deepEqual(body.routing.policy, { preset: "arc-policy.prefer-local.v1", overrides: { selection: { min_p_pass: 0.5 } } });
	assert.deepEqual(body.routing.prices, { "z-ai/glm-5.3-flash": { input: 0, cache_read: 0, cache_write: 0, output: 0 } });
	const [local, cloud] = execution(body).targets;
	assert.equal((local.capacity as { fits: boolean }).fits, true);
	assert.equal(cloud.capacity, null);
	assert.equal(r.stats.lookups, 1);
});

test("a tool follow-up stays on the previous model without a lookup", async () => {
	const r = router(() => assert.fail("no lookup expected"));
	const previous = { model: catalog["local/glm"], thinkingLevel: "medium" } as Request["previous"];
	const result = await r.route(request({ reason: "continuation", previous }), fakeCtx().ctx);
	assert.equal(result.model.id, "glm");
});

test("a retry after an overloaded provider asks again without that model", async () => {
	const r = router(chose("anthropic/claude-haiku-5.5"));
	const failed = { model: catalog["local/glm"], message: { errorMessage: "529 overloaded" } } as Request["failed"];
	await r.route(request({ reason: "retry", failed }), fakeCtx().ctx);
	assert.deepEqual(execution(r.sent[0]).targets.map((t) => t.worker), ["claude-haiku-5.5"]);
});

test("when ARC is unavailable the turn falls back with a warning", async () => {
	const r = router(() => {
		throw new RoutesError(503, "unavailable", "try later");
	});
	const { ctx, notes } = fakeCtx();
	const result = await r.route(request({}), ctx);
	assert.equal(result.model.id, "glm");
	assert.match(notes[0], /unavailable/);
});

test("a bad key fails the turn instead of hiding behind the fallback", async () => {
	const r = router(() => {
		throw new RoutesError(401, undefined, "invalid key");
	});
	await assert.rejects(r.route(request({}), fakeCtx().ctx), /401/);
});

test("a response that did not apply the execution context is an error", async () => {
	const r = router((body) => ({ ...chose("z-ai/glm-5.3-flash")(body), routing: { execution: { status: "unsupported" } } }));
	await assert.rejects(r.route(request({}), fakeCtx().ctx), /did not apply the execution context/);
});

test("a route chosen without the prefer-local policy is an error", async () => {
	const r = router((body) => {
		const answer = chose("z-ai/glm-5.3-flash")(body);
		return { ...answer, routing: { ...answer.routing, policy: { status: "unsupported" } } };
	});
	await assert.rejects(r.route(request({}), fakeCtx().ctx), /prefer-local/);
});

test("after compaction a retry asks ARC again, as a compaction", async () => {
	const r = router(chose("anthropic/claude-haiku-5.5"));
	const summary = "The conversation history before this point was compacted into the following summary: ...";
	const failed = { model: catalog["local/glm"], message: { errorMessage: "context length exceeded" } } as Request["failed"];
	const result = await r.route(
		request({ reason: "retry", failed, state: { head: "old" }, messages: [{ role: "user", content: summary, timestamp: 0 }] as never }),
		fakeCtx().ctx,
	);
	assert.equal(result.model.id, "claude-haiku-5-5");
	assert.equal((r.sent[0].routing.execution as { event: { kind: string } }).event.kind, "compaction");
});

test("an overload re-ask refers to the route it replaces", async () => {
	const r = router(chose("anthropic/claude-haiku-5.5"));
	const failed = { model: catalog["local/glm"], message: { errorMessage: "503 unavailable" } } as Request["failed"];
	const first = await r.route(request({}), fakeCtx().ctx);
	await r.route(request({ reason: "retry", failed, state: first.state }), fakeCtx().ctx);
	const turn = (r.sent[1].routing.execution as { turn: { attempt: number; retry_of: string; reconsult: string } }).turn;
	assert.deepEqual([turn.attempt, turn.retry_of, turn.reconsult], [2, "rt_1", "veto"]);
});
