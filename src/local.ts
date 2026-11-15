/**
 * Local decisions: the Rayline CLI's local process answers `POST /v1/routes`
 * on this machine. `rayline local status --json` says where, and names the
 * 0600 file that holds the token for it. No Pi imports.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Run {
	(command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<{
		stdout: string;
		stderr: string;
		code: number;
	}>;
}

/** Where the Rayline CLI's installer puts `rayline`; else `rayline` on PATH. */
export function raylineBin(home = homedir()): string {
	const installed = join(home, ".rayline", "bin", "rayline");
	return existsSync(installed) ? installed : "rayline";
}

export const START_HINT = "run `/rayline start` (or `rayline local start --decisions local`)";

export interface LocalRoutes {
	url: string;
	token: string;
}

interface Status {
	running?: boolean;
	decisions?: string;
	routes?: { url?: string; token_file?: string };
}

/** Runs `rayline local …` and fails with what it printed when it exits non-zero. */
export async function rayline(run: Run, args: string[], options: { timeout?: number; signal?: AbortSignal } = {}) {
	const bin = raylineBin();
	let result: Awaited<ReturnType<Run>>;
	try {
		result = await run(bin, ["local", ...args], options);
	} catch (error) {
		throw new Error(`Rayline: cannot run ${bin} (${(error as Error).message}). Install the Rayline CLI 0.5.2 or later.`);
	}
	if (result.code !== 0) {
		const said = (result.stderr || result.stdout).trim();
		throw new Error(`Rayline: \`rayline local ${args.join(" ")}\` failed${said ? `: ${said}` : ` (exit ${result.code})`}`);
	}
	return result.stdout;
}

/** The local Routes API, or an error saying how to start it. */
export async function findLocalRoutes(run: Run, signal?: AbortSignal): Promise<LocalRoutes> {
	const stdout = await rayline(run, ["status", "--json"], { timeout: 10_000, signal });
	let status: Status;
	try {
		status = JSON.parse(stdout);
	} catch {
		throw new Error("Rayline: `rayline local status --json` did not print JSON. Local decisions need the Rayline CLI 0.5.2 or later.");
	}
	if (!status.running) throw new Error(`Rayline: local decisions, but the Rayline local process is not running: ${START_HINT}`);
	if (status.decisions !== "local" || !status.routes?.url || !status.routes.token_file) {
		throw new Error(
			`Rayline: the Rayline local process runs with ${status.decisions ?? "hosted"} decisions. Run \`/rayline stop\`, then \`/rayline start\`.`,
		);
	}
	const token = (await readFile(status.routes.token_file, "utf8")).trim();
	if (!token) throw new Error(`Rayline: ${status.routes.token_file} is empty: ${START_HINT}`);
	return { url: status.routes.url, token };
}

/** Remembers the local Routes API between turns; `fresh` asks `rayline local status` again (after a restart, the URL and token change). */
export function localRoutesCache(run: Run) {
	let known: LocalRoutes | undefined;
	return async (signal?: AbortSignal, fresh = false): Promise<LocalRoutes> => {
		if (!known || fresh) known = await findLocalRoutes(run, signal);
		return known;
	};
}
