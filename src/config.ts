/**
 * `rayline.json` in Pi's agent directory (`~/.pi/agent/rayline.json`), or the
 * file named by RAYLINE_PI_CONFIG.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Prices } from "./routes.ts";

export interface Config {
	/** ARC model ID. Default `arc-swift-1.0`; `arc-1.0` needs `v_value`. */
	arc?: string;
	/** Your value (V) in USD, 0.1 to 30. Only with `arc-1.0`. */
	v_value?: number;
	/** The candidates: ARC model ID → the Pi model that runs it (`provider/id`). */
	models: Record<string, string>;
	/** Your prices per ARC model ID, e.g. 0 for a model you run yourself. */
	prices?: Record<string, Prices>;
	/** A saved price profile. */
	price_profile?: { id: string; version?: number };
	/** Pi model (`provider/id`) for a turn ARC cannot route before any model has answered. */
	fallback?: string;
	/** Routes API URL. Default `https://api.rayline.ai/v1/routes`. */
	url?: string;
	/** Lookup timeout. Default 5000 ms. */
	timeout_ms?: number;
}

export const CONFIG_ENV = "RAYLINE_PI_CONFIG";

export function configPath(): string {
	return process.env[CONFIG_ENV] || join(getAgentDir(), "rayline.json");
}

export function loadConfig(path = configPath()): Config {
	let config: Config;
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Rayline: cannot read ${path} (${(error as Error).message}). See the README for its format.`);
	}
	const models = Object.entries(config.models ?? {});
	if (models.length === 0) throw new Error(`Rayline: ${path} lists no models`);
	for (const [arcId, ref] of models) {
		if (!ref.includes("/")) throw new Error(`Rayline: ${path}: models["${arcId}"] must be a Pi model as provider/id`);
	}
	return config;
}
