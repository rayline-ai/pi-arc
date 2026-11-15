import assert from "node:assert/strict";
import { test } from "node:test";
import { summary } from "../src/index.ts";

test("/rayline in local mode splits the first decision from later ones and counts hosted decisions", () => {
	const text = summary(
		{ decisions: "local" },
		{ lookups: 3, encodedTokens: 0, elapsedMs: 400, firstMs: 300, fallbacks: 0, models: { "gpu-box/glm-5.3-flash": 2, "rayline/claude-opus-5-5": 1 }, hosted: 0, last: "x" },
		"/tmp/rayline.json",
	);
	assert.equal(
		text,
		[
			"Rayline ARC: local decisions on this Mac (arc-swift-1.0)",
			"Config /tmp/rayline.json",
			"3 turns decided: first 300 ms, then 50 ms mean",
			"Models: gpu-box/glm-5.3-flash 2 turns, rayline/claude-opus-5-5 1 turn",
			"Hosted decisions this session: 0",
			"Last: x",
		].join("\n"),
	);
});
