/**
 * Rayline ARC for Pi: registers `rayline/arc`, a virtual model that asks
 * Rayline's Routes API which of your models should take each turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Config, configPath, loadConfig } from "./config.ts";
import { createRouter } from "./router.ts";

export default function (pi: ExtensionAPI) {
	const path = configPath();
	let config: Config | undefined;
	let configError: unknown;
	try {
		config = loadConfig(path);
	} catch (error) {
		configError = error;
	}

	// The provider holds the Rayline key: the `rayline` entry in auth.json, else RAYLINE_API_KEY.
	// It serves no models of its own.
	pi.registerProvider("rayline", {
		name: "Rayline",
		baseUrl: "https://api.rayline.ai",
		api: "anthropic-messages",
		apiKey: "$RAYLINE_API_KEY",
		models: [],
	});

	const router =
		config &&
		createRouter(config, {
			apiKey: (ctx) => ctx.modelRegistry.getApiKeyForProvider("rayline"),
			tools: () => {
				const active = new Set(pi.getActiveTools());
				return pi
					.getAllTools()
					.filter((tool) => active.has(tool.name))
					.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
			},
		});

	pi.registerVirtualModel({
		provider: "rayline",
		id: "arc",
		name: "Rayline ARC",
		// ARC picks the thinking level with the model.
		thinkingLevels: ["off"],
		route(request, ctx) {
			if (!router) throw configError;
			return router.route(request, ctx);
		},
	});

	pi.registerCommand("rayline", {
		description: "Show Rayline routing for this session",
		handler: async (_args, ctx) => {
			if (!router) return ctx.ui.notify(String(configError), "error");
			const { lookups, encodedTokens, elapsedMs, fallbacks, last } = router.stats;
			const mean = lookups ? Math.round(elapsedMs / lookups) : 0;
			ctx.ui.notify(
				[
					`Rayline ARC (${config?.arc ?? "arc-swift-1.0"}), config ${path}`,
					`${lookups} lookups, ${encodedTokens} encoded tokens billed, ${mean} ms mean, ${fallbacks} fallbacks`,
					`Last: ${last ?? "none yet"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
