import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { RoutesError, requestRoute, sha256 } from "../src/routes.ts";

async function serve(status: number, body: unknown) {
	const seen: { headers?: IncomingHttpHeaders; body?: unknown } = {};
	const server = createServer((req, res) => {
		let data = "";
		req.on("data", (chunk) => (data += chunk));
		req.on("end", () => {
			seen.headers = req.headers;
			seen.body = JSON.parse(data);
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/routes`;
	return { url, seen, close: () => server.close() };
}

const body = { model: "arc-swift-1.0", max_tokens: 1, messages: [{ role: "user" as const, content: [{ type: "text", text: "hi" }] }], routing: {} };

test("sends the key and conversation id, and returns the route", async () => {
	const server = await serve(200, { route_id: "rt_1", model: "openai/gpt-6-luna" });
	try {
		const route = await requestRoute(body, { apiKey: "rlk-test", sessionId: "c1", url: server.url });
		assert.equal(route.model, "openai/gpt-6-luna");
		assert.equal(server.seen.headers?.["x-rayline-wire-format"], "anthropic.messages.v1");
		assert.equal(server.seen.headers?.authorization, "Bearer rlk-test");
		assert.equal(server.seen.headers?.["x-conversation-id"], sha256("c1"));
		assert.deepEqual(server.seen.body, body);
	} finally {
		server.close();
	}
});

test("an error response becomes a RoutesError with its code", async () => {
	const server = await serve(529, { type: "error", error: { type: "overloaded_error", code: "capacity", message: "busy" } });
	try {
		const error = await requestRoute(body, { apiKey: "k", sessionId: "c", url: server.url }).catch((e) => e);
		assert.ok(error instanceof RoutesError);
		assert.equal(error.code, "capacity");
		assert.equal(error.retryable, true);
	} finally {
		server.close();
	}
});

test("a 200 whose body is cut off is a network failure, not an empty route", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
		res.write('{"route_id":');
		res.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/routes`;
	try {
		await assert.rejects(requestRoute(body, { apiKey: "k", sessionId: "c", url }), TypeError);
	} finally {
		server.close();
	}
});
