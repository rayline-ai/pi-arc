/**
 * `rayline.json` in Pi's agent directory (`~/.pi/agent/rayline.json`), or the
 * file named by RAYLINE_PI_CONFIG.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Config {
	/** Models you run yourself: ARC model ID → Pi model (`provider/id`). Priced at zero and preferred when they can do the job. */
	local?: Record<string, string>;
	/** Cloud models: ARC model ID → Pi model. `rayline/<id>` runs it through Rayline with your Rayline key. */
	cloud?: Record<string, string>;
	/** Pi model (`provider/id`) for a turn ARC cannot route before any model has answered. */
	fallback?: string;
	/** Routes API URL. Default `https://api.rayline.ai/v1/routes`. */
	url?: string;
	/** Lookup timeout. Default 8000 ms. */
	timeout_ms?: number;
}

export interface Target {
	/** ARC model ID, e.g. `z-ai/glm-5.3-flash`. */
	arc: string;
	/** Pi model, `provider/id`. */
	pi: string;
	placement: "local" | "cloud";
}

export const CONFIG_ENV = "RAYLINE_PI_CONFIG";

export function configPath(): string {
	return process.env[CONFIG_ENV] || join(getAgentDir(), "rayline.json");
}

export function targetsOf(config: Config): Target[] {
	const list = (placement: Target["placement"], models: Record<string, string> = {}) =>
		Object.entries(models).map(([arc, pi]) => ({ arc, pi, placement }));
	return [...list("local", config.local), ...list("cloud", config.cloud)];
}

export function loadConfig(path = configPath()): Config {
	let config: Config;
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Rayline: cannot read ${path} (${(error as Error).message}). See the README for its format.`);
	}
	const targets = targetsOf(config);
	if (targets.length === 0) throw new Error(`Rayline: ${path} lists no local or cloud models`);
	for (const target of targets) {
		if (!target.arc.includes("/") || !target.pi.includes("/")) {
			throw new Error(`Rayline: ${path}: "${target.arc}": "${target.pi}" must map an ARC model ID to a Pi model, both as provider/id`);
		}
	}
	return config;
}
