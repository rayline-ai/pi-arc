/**
 * `rayline.json` in Pi's agent directory (`~/.pi/agent/rayline.json`), or the
 * file named by RAYLINE_PI_CONFIG. Optional: without it, and for any field it
 * leaves out, the defaults below apply.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Config {
	/** Models you run yourself: ARC model ID → Pi model (`provider/id`). Priced at zero and preferred when they can do the job. */
	local?: Record<string, string>;
	/** Cloud models: ARC model ID → Pi model. `rayline/<id>` runs it through Rayline with your Rayline key. Default `DEFAULT_CLOUD`. */
	cloud?: Record<string, string>;
	/** Pi model (`provider/id`) for a turn ARC cannot route before any model has answered. Default: the first local model, else Claude Haiku via Rayline. */
	fallback?: string;
	/** Hosted Routes API URL. Default `https://api.rayline.ai/v1/routes`. Not with `decisions: "local"`. */
	url?: string;
	/** Lookup timeout. Default 8000 ms. */
	timeout_ms?: number;
	/**
	 * Where ARC decides. `hosted` (default): Rayline's Routes API, with your Rayline key.
	 * `local`: the Rayline CLI's local process on this machine (`rayline local start --decisions local`).
	 * Local decisions never fall back to hosted: when the local process cannot decide, the turn fails.
	 */
	decisions?: "hosted" | "local";
}

export interface Target {
	/** ARC model ID, e.g. `z-ai/glm-5.3-flash`. */
	arc: string;
	/** Pi model, `provider/id`. */
	pi: string;
	placement: "local" | "cloud";
}

export const CONFIG_ENV = "RAYLINE_PI_CONFIG";

/** Cloud models when `cloud` is not set: all run through Rayline, so the Rayline key is the only key needed. */
export const DEFAULT_CLOUD: Record<string, string> = {
	"anthropic/claude-opus-5.5": "rayline/claude-opus-5-5",
	"anthropic/claude-haiku-5.5": "rayline/claude-haiku-5-5",
	"openai/gpt-6-luna": "rayline/openai/gpt-6-luna",
};
const DEFAULT_FALLBACK = "rayline/claude-haiku-5-5";

export function configPath(): string {
	return process.env[CONFIG_ENV] || join(getAgentDir(), "rayline.json");
}

export function targetsOf(config: Config): Target[] {
	const list = (placement: Target["placement"], models: Record<string, string> = {}) =>
		Object.entries(models).map(([arc, pi]) => ({ arc, pi, placement }));
	return [...list("local", config.local), ...list("cloud", config.cloud)];
}

export function loadConfig(path = configPath()): Config {
	let config: Config = {};
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		// No file at the default path means the defaults; a file named by RAYLINE_PI_CONFIG must exist.
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT" && !process.env[CONFIG_ENV];
		if (!missing) throw new Error(`Rayline: cannot read ${path} (${(error as Error).message}). See the README for its format.`);
	}
	if (config.decisions !== undefined && config.decisions !== "hosted" && config.decisions !== "local") {
		throw new Error(`Rayline: ${path}: "decisions": ${JSON.stringify(config.decisions)}: must be "hosted" or "local"`);
	}
	if (config.decisions === "local" && config.url !== undefined) {
		throw new Error(`Rayline: ${path}: "url" is the hosted Routes API; with "decisions": "local" the Rayline CLI's local process decides`);
	}
	config = {
		...config,
		decisions: config.decisions ?? "hosted",
		cloud: config.cloud ?? DEFAULT_CLOUD,
		fallback: config.fallback ?? Object.values(config.local ?? {})[0] ?? DEFAULT_FALLBACK,
	};
	const targets = targetsOf(config);
	if (targets.length === 0) throw new Error(`Rayline: ${path} lists no local or cloud models`);
	for (const target of targets) {
		if (!target.arc.includes("/") || !target.pi.includes("/")) {
			throw new Error(`Rayline: ${path}: "${target.arc}": "${target.pi}" must map an ARC model ID to a Pi model, both as provider/id`);
		}
	}
	return config;
}
