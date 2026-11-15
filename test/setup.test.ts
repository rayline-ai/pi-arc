import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Run } from "../src/local.ts";
import { HOSTED_CHOICE, LOCAL_CHOICE, saveDecisions, setup } from "../src/setup.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-arc-setup-"));

function ui(choice: string | undefined) {
	const notes: string[] = [];
	const offered: string[][] = [];
	return {
		notes,
		offered,
		select: async (_title: string, options: string[]) => (offered.push(options), choice),
		notify: (text: string) => notes.push(text),
		setStatus: () => {},
	};
}

/** A Rayline CLI that answers each subcommand from `answers`, and records what ran. */
function cli(answers: Record<string, { stdout?: string; stderr?: string; code?: number }>) {
	const ran: string[] = [];
	const run: Run = async (_bin, args) => {
		const key = args.join(" ");
		ran.push(key);
		const answer = answers[key] ?? { stdout: "" };
		return { stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", code: answer.code ?? 0 };
	};
	return { run, ran };
}

test("saveDecisions keeps the other fields and refuses a hosted url with local", () => {
	const path = join(dir, "keep.json");
	writeFileSync(path, JSON.stringify({ local: { "z-ai/glm-5.3-flash": "gpu-box/glm-5.3-flash" } }));
	saveDecisions(path, "local");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { local: { "z-ai/glm-5.3-flash": "gpu-box/glm-5.3-flash" }, decisions: "local" });
	writeFileSync(path, JSON.stringify({ url: "https://example.test/v1/routes" }));
	assert.throws(() => saveDecisions(path, "local"), /Remove it/);
});

test("off Apple Silicon only hosted decisions are offered", async () => {
	const u = ui(undefined);
	await setup(u, { run: cli({}).run, path: join(dir, "x.json"), reload: () => {}, appleSilicon: false });
	assert.deepEqual(u.offered[0], [HOSTED_CHOICE]);
});

test("a missing Rayline CLI gets the install command, and nothing is written", async () => {
	const u = ui(LOCAL_CHOICE);
	const path = join(dir, "missing-cli.json");
	const run: Run = async () => {
		throw new Error("spawn rayline ENOENT");
	};
	await setup(u, { run, path, reload: () => {}, appleSilicon: true });
	assert.match(u.notes[0], /! curl -fsSL https:\/\/get\.rayline\.ai\/install\.sh \| bash/);
	assert.throws(() => readFileSync(path));
});

test("local setup signs in, starts local ARC, then saves decisions local", async () => {
	const u = ui(LOCAL_CHOICE);
	const path = join(dir, "local.json");
	let reloaded = 0;
	const { run, ran } = cli({
		"--version": { stdout: "rayline 0.5.2\n" },
		"auth status": { stdout: "Not logged in to prod. Run: rayline auth login\n" },
		"local status --json": { stdout: '{"running":false}' },
	});
	await setup(u, { run, path, reload: () => reloaded++, appleSilicon: true });
	assert.deepEqual(ran, ["--version", "auth status", "auth login", "local status --json", "local start --decisions local"]);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).decisions, "local");
	assert.equal(reloaded, 1);
	assert.match(u.notes.at(-1)!, /\[done\] Rayline CLI 0\.5\.2\n\[done\] Signed in\n\[done\] Local ARC ready/);
});

test("a local process already running with local decisions is reused", async () => {
	const { run, ran } = cli({
		"--version": { stdout: "rayline 0.5.2" },
		"auth status": { stdout: "  Environment: prod" },
		"local status --json": { stdout: '{"running":true,"decisions":"local"}' },
	});
	await setup(ui(LOCAL_CHOICE), { run, path: join(dir, "reuse.json"), reload: () => {}, appleSilicon: true });
	assert.ok(!ran.includes("local start --decisions local"));
	assert.ok(!ran.includes("auth login"));
});

test("a sign-in Pi stopped after 5 minutes is not a sign-in, and nothing is saved", async () => {
	const u = ui(LOCAL_CHOICE);
	const path = join(dir, "login-timeout.json");
	const ran: string[] = [];
	const run: Run = async (_bin, args) => {
		ran.push(args.join(" "));
		if (args[0] === "--version") return { stdout: "rayline 0.5.2", stderr: "", code: 0 };
		if (args.join(" ") === "auth status") return { stdout: "Not logged in to prod.", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0, killed: true };
	};
	await setup(u, { run, path, reload: () => {}, appleSilicon: true });
	assert.match(u.notes.at(-1)!, /did not finish in 5 minutes/);
	assert.ok(!ran.includes("local start --decisions local"));
	assert.throws(() => readFileSync(path));
});

test("a hosted url in rayline.json is refused before anything starts", async () => {
	const u = ui(LOCAL_CHOICE);
	const path = join(dir, "has-url.json");
	writeFileSync(path, JSON.stringify({ url: "https://example.test/v1/routes" }));
	const { run, ran } = cli({});
	await setup(u, { run, path, reload: () => {}, appleSilicon: true });
	assert.deepEqual(ran, []);
	assert.match(u.notes[0], /Remove it/);
});
