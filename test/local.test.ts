import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findLocalRoutes, localRoutesCache, type Run } from "../src/local.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-arc-local-"));
const tokenFile = join(dir, "routes-token");
writeFileSync(tokenFile, "tok-1\n", { mode: 0o600 });

const status = (body: unknown, code = 0): Run => async () => ({ stdout: JSON.stringify(body), stderr: "", code });
const running = { running: true, decisions: "local", routes: { url: "http://127.0.0.1:1/v1/routes", token_file: tokenFile } };

test("reads the URL from rayline local status --json and the token from its file", async () => {
	assert.deepEqual(await findLocalRoutes(status(running)), { url: "http://127.0.0.1:1/v1/routes", token: "tok-1" });
});

test("a stopped local process says how to start it", async () => {
	await assert.rejects(findLocalRoutes(status({ running: false })), /isn.t running.*Run \/rayline start/);
});

test("a local process with hosted decisions says to restart it", async () => {
	await assert.rejects(findLocalRoutes(status({ running: true, decisions: "hosted" })), /runs with hosted decisions/);
});

test("an older Rayline CLI without status --json says which version is needed", async () => {
	const old: Run = async () => ({ stdout: "", stderr: "error: unexpected argument '--json'", code: 2 });
	await assert.rejects(findLocalRoutes(old), /unexpected argument '--json'/);
	const text: Run = async () => ({ stdout: "running", stderr: "", code: 0 });
	await assert.rejects(findLocalRoutes(text), /0\.5\.2 or later/);
});

test("the cache asks once, and again only when told", async () => {
	let calls = 0;
	const counted: Run = async (...args) => {
		calls++;
		return status(running)(...args);
	};
	const routes = localRoutesCache(counted);
	await routes();
	await routes();
	assert.equal(calls, 1);
	await routes(undefined, true);
	assert.equal(calls, 2);
});

test("a command Pi stopped (timeout) is not a success", async () => {
	const killed: Run = async () => ({ stdout: "", stderr: "", code: 0, killed: true });
	await assert.rejects(findLocalRoutes(killed), /did not finish in time/);
});

test("a missing rayline binary gets the install hint", async () => {
	const missing: Run = async () => ({ stdout: "", stderr: "spawn rayline ENOENT", code: 1 });
	await assert.rejects(findLocalRoutes(missing), /Install the Rayline CLI 0\.5\.2 or later/);
});

test("an unreadable token file says how to restart, without a stack of Node errors", async () => {
	const gone = status({ ...running, routes: { ...running.routes, token_file: join(dir, "nope") } });
	await assert.rejects(findLocalRoutes(gone), /cannot read .*nope \(ENOENT\)\. Local decisions never fall back/);
});
