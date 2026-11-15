/**
 * Rayline ARC for Pi: registers `rayline/arc`, a virtual model that asks
 * Rayline which of your models should take each turn, with the settings
 * the Rayline CLI uses.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Config, configPath, loadConfig, targetsOf } from "./config.ts";
import { localRoutesCache, rayline, type Run } from "./local.ts";
import { ROUTES_URL } from "./routes.ts";
import { createRouter, type RouterState } from "./router.ts";

const PROVIDER = "rayline";

export default function (pi: ExtensionAPI) {
	const path = configPath();
	let config: Config | undefined;
	let configError: unknown;
	try {
		config = loadConfig(path);
	} catch (error) {
		configError = error;
	}

	// The `rayline` provider holds the key (auth.json, else RAYLINE_API_KEY) and runs every
	// `rayline/<id>` model through Rayline's Messages API, pinned to that model.
	const gateway = config ? targetsOf(config).filter((target) => target.pi.startsWith(`${PROVIDER}/`)) : [];
	pi.registerProvider(PROVIDER, {
		name: "Rayline",
		baseUrl: new URL(config?.url ?? ROUTES_URL).origin,
		api: "anthropic-messages",
		apiKey: "$RAYLINE_API_KEY",
		models: gateway.map((target) => ({
			id: target.pi.slice(PROVIDER.length + 1),
			name: `${target.arc} via Rayline`,
			reasoning: true,
			input: ["text", "image"],
			// Rayline bills these turns; Pi shows them at zero.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// Conservative: Pi compacts against this, and it cannot see the real model's limits here.
			contextWindow: 200_000,
			maxTokens: 32_000,
		})),
	});

	const run: Run = (command, args, options) => pi.exec(command, args, options);
	const localRoutes = localRoutesCache(run);
	const router =
		config &&
		createRouter(config, {
			apiKey: (ctx) => ctx.modelRegistry.getApiKeyForProvider(PROVIDER),
			localRoutes,
			tools: () => {
				const active = new Set(pi.getActiveTools());
				return pi
					.getAllTools()
					.filter((tool) => active.has(tool.name))
					.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
			},
		});

	pi.registerVirtualModel<RouterState>({
		provider: PROVIDER,
		id: "arc",
		name: "Rayline ARC",
		// ARC picks the model; the user's thinking level is not an input.
		thinkingLevels: ["off"],
		route(request, ctx) {
			if (!router) throw configError;
			return router.route(request, ctx);
		},
	});

	pi.registerCommand("rayline", {
		description: "Rayline routing for this session; `/rayline start` or `/rayline stop` the local process for local decisions",
		getArgumentCompletions: (prefix) =>
			["start", "stop"].filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "start" || command === "stop") {
				ctx.ui.notify(command === "start" ? "Starting the Rayline local process with local decisions…" : "Stopping the Rayline local process…", "info");
				try {
					// The first start downloads the ARC release and encoder; later starts take seconds.
					await rayline(run, command === "start" ? ["start", "--decisions", "local"] : ["stop"], { timeout: 15 * 60_000 });
					await localRoutes(undefined, true).catch(() => undefined);
					ctx.ui.notify(command === "start" ? "Rayline local process started: routing decisions run locally." : "Rayline local process stopped.", "info");
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				}
				return;
			}
			if (command) return ctx.ui.notify(`Rayline: unknown command \`/rayline ${command}\`. Use /rayline, /rayline start or /rayline stop.`, "error");
			if (!router || !config) return ctx.ui.notify(String(configError), "error");
			const { lookups, encodedTokens, elapsedMs, fallbacks, last } = router.stats;
			const mean = lookups ? Math.round(elapsedMs / lookups) : 0;
			const where =
				config.decisions === "local"
					? "local decisions (Rayline CLI local process; not metered)"
					: `hosted decisions, ${encodedTokens} encoded tokens billed`;
			ctx.ui.notify(
				[
					`Rayline ARC, ${where}`,
					`Config ${existsSync(path) ? path : "built-in (no rayline.json)"}`,
					`${lookups} lookups, ${mean} ms mean${config.decisions === "local" ? "" : `, ${fallbacks} fallbacks`}`,
					`Last: ${last ?? "none yet"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
