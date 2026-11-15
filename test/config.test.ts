import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_ENV, DEFAULT_CLOUD, loadConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-arc-"));
const file = (name: string, body: unknown) => {
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(body));
	return path;
};

test("without rayline.json, the built-in cloud models run through Rayline", () => {
	delete process.env[CONFIG_ENV];
	const config = loadConfig(join(dir, "missing.json"));
	assert.deepEqual(config.cloud, DEFAULT_CLOUD);
	assert.equal(config.fallback, "rayline/claude-haiku-5-5");
});

test("a file with only local models keeps the default cloud and falls back to local", () => {
	const config = loadConfig(file("local.json", { local: { "z-ai/glm-5.3-flash": "local/glm" } }));
	assert.deepEqual(config.cloud, DEFAULT_CLOUD);
	assert.equal(config.fallback, "local/glm");
});

test("a file named by RAYLINE_PI_CONFIG must exist", () => {
	process.env[CONFIG_ENV] = join(dir, "missing.json");
	try {
		assert.throws(() => loadConfig(), /cannot read/);
	} finally {
		delete process.env[CONFIG_ENV];
	}
});

test("decisions is hosted by default, local on request, and nothing else", () => {
	delete process.env[CONFIG_ENV];
	assert.equal(loadConfig(file("default-decisions.json", {})).decisions, "hosted");
	assert.equal(loadConfig(file("local-decisions.json", { decisions: "local" })).decisions, "local");
	assert.throws(() => loadConfig(file("odd-decisions.json", { decisions: "offline" })), /must be "hosted" or "local"/);
});

test("local decisions do not take a hosted Routes API url", () => {
	assert.throws(() => loadConfig(file("local-url.json", { decisions: "local", url: "https://example.test/v1/routes" })), /"url" is the hosted/);
});
