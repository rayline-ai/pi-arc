/**
 * `/rayline setup`: choose where ARC decides, and for local decisions get the
 * Rayline CLI signed in and its local process running. It never installs
 * anything itself; a missing CLI gets the install command to run with `!`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { localStatus, raylineBin, rayline, type Run } from "./local.ts";

export const INSTALL = "curl -fsSL https://get.rayline.ai/install.sh | bash";
export const LOCAL_CHOICE = "Local decisions with the Rayline CLI (recommended on this Mac)";
export const HOSTED_CHOICE = "Hosted decisions with a Rayline key";

export interface SetupUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface SetupDeps {
	run: Run;
	/** The config file to write `decisions` into. */
	path: string;
	/** Reloads the config after it was written. */
	reload(): void;
	appleSilicon?: boolean;
}

/** Sets `decisions` in rayline.json, keeping every other field. */
export function saveDecisions(path: string, decisions: "local" | "hosted") {
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Rayline: cannot read ${path} (${(error as Error).message})`);
	}
	if (decisions === "local" && config.url !== undefined) {
		throw new Error(`Rayline: ${path} sets "url", the hosted Routes API. Remove it to use local decisions.`);
	}
	writeFileSync(path, `${JSON.stringify({ ...config, decisions }, null, "\t")}\n`);
}

export async function setup(ui: SetupUI, deps: SetupDeps): Promise<void> {
	const appleSilicon = deps.appleSilicon ?? (platform() === "darwin" && arch() === "arm64");
	const choice = await ui.select("Set up Rayline ARC", appleSilicon ? [LOCAL_CHOICE, HOSTED_CHOICE] : [HOSTED_CHOICE]);
	if (!choice) return;

	if (choice === HOSTED_CHOICE) {
		saveDecisions(deps.path, "hosted");
		deps.reload();
		ui.notify(
			[
				`Saved "decisions": "hosted" in ${deps.path}.`,
				"Add your Rayline key with /login rayline (or set RAYLINE_API_KEY), then pick the model: /model rayline/arc",
			].join("\n"),
			"info",
		);
		return;
	}

	const step = (text: string) => ui.setStatus("rayline", `rayline: ${text}`);
	const bin = raylineBin();
	let version: string;
	try {
		version = (await deps.run(bin, ["--version"], { timeout: 10_000 })).stdout.trim();
	} catch {
		version = "";
	}
	if (!version) {
		ui.notify(`The Rayline CLI isn't installed. Install it here, then run /rayline setup again:\n  ! ${INSTALL}`, "warning");
		return;
	}
	const done = [`[done] ${version.replace(/^rayline /, "Rayline CLI ")}`];

	const fail = (message: string) => {
		ui.setStatus("rayline", undefined);
		ui.notify(message, "error");
	};
	const auth = await deps.run(bin, ["auth", "status"], { timeout: 10_000 });
	if (auth.killed || auth.code !== 0) return fail(`Rayline: \`rayline auth status\` failed: ${(auth.stderr || auth.stdout).trim() || "no answer"}`);
	if (/not logged in/i.test(auth.stdout + auth.stderr)) {
		step("signing in, your browser opens");
		ui.notify([...done, "[working] Signing in: your browser opens to sign in to Rayline"].join("\n"), "info");
		const login = await deps.run(bin, ["auth", "login"], { timeout: 5 * 60_000 });
		if (login.killed) return fail("Rayline: sign-in did not finish in 5 minutes. Run /rayline setup again.");
		if (login.code !== 0) return fail(`Rayline: sign-in did not finish: ${(login.stderr || login.stdout).trim()}`);
	}
	done.push("[done] Signed in");

	let status: Awaited<ReturnType<typeof localStatus>>;
	try {
		status = await localStatus(deps.run);
	} catch (error) {
		return fail((error as Error).message);
	}
	if (status.running && status.decisions !== "local") {
		ui.setStatus("rayline", undefined);
		ui.notify(`Rayline: the local process runs with ${status.decisions} decisions. Run /rayline stop, then /rayline setup again.`, "error");
		return;
	}
	if (!status.running) {
		step("starting local ARC");
		ui.notify([...done, "[working] Starting local ARC. The first start downloads about 1 GB, once."].join("\n"), "info");
		try {
			await rayline(deps.run, ["start", "--decisions", "local"], { timeout: 15 * 60_000 });
		} catch (error) {
			ui.setStatus("rayline", undefined);
			ui.notify((error as Error).message, "error");
			return;
		}
	}
	done.push("[done] Local ARC ready");

	saveDecisions(deps.path, "local");
	deps.reload();
	ui.setStatus("rayline", "route: local, ready");
	ui.notify([...done, `Saved "decisions": "local" in ${deps.path}.`, "Pick the model: /model rayline/arc"].join("\n"), "info");
}
