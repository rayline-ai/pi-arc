/**
 * Rayline ARC for Pi: registers `rayline/arc`, a virtual model that asks
 * Rayline which of your models should take each turn, with the settings
 * the Rayline CLI uses.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Config, configPath, loadConfig, targetsOf } from "./config.ts";
import { localRoutesCache, rayline, type Run } from "./local.ts";
import { setup } from "./setup.ts";
import { ROUTES_URL } from "./routes.ts";
import { createRouter, newStats, type RouterState, type Stats } from "./router.ts";

const PROVIDER = "rayline";

export default function (pi: ExtensionAPI) {
	const path = configPath();
	let config: Config | undefined;
	let configError: unknown;
	const load = () => {
		try {
			config = loadConfig(path);
			configError = undefined;
		} catch (error) {
			config = undefined;
			configError = error;
		}
	};
	load();

	// The `rayline` provider holds the key (auth.json, else RAYLINE_API_KEY) and runs every
	// `rayline/<id>` model through Rayline's Messages API, pinned to that model.
	const registerGateway = () => {
		const gateway = config ? targetsOf(config).filter((target) => target.pi.startsWith(`${PROVIDER}/`)) : [];
		pi.registerProvider(PROVIDER, {
			name: "Rayline",
			baseUrl: new URL(config?.url ?? ROUTES_URL).origin,
			api: "anthropic-messages",
			// Pi offers rayline/arc only when this provider has a key. With local decisions and no
			// rayline/ models, nothing is sent to Rayline, so a placeholder stands in for the key.
			apiKey: config?.decisions === "local" && gateway.length === 0 ? "local-decisions-no-key-needed" : "$RAYLINE_API_KEY",
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
	};
	registerGateway();

	const run: Run = (command, args, options) => pi.exec(command, args, options);
	const localRoutes = localRoutesCache(run);
	const tools = () => {
		const active = new Set(pi.getActiveTools());
		return pi
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
	};
	// One session's totals, kept when /rayline setup reloads the config.
	const stats = newStats();
	const makeRouter = () =>
		config && createRouter(config, { apiKey: (ctx) => ctx.modelRegistry.getApiKeyForProvider(PROVIDER), localRoutes, tools, stats });
	let router = makeRouter();

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

	const commands = ["setup", "start", "stop"];
	pi.registerCommand("rayline", {
		description: "Rayline routing for this session; /rayline setup, /rayline start, /rayline stop",
		getArgumentCompletions: (prefix) =>
			commands.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const command = args.trim();
			try {
				if (command === "setup") {
					return await setup(ctx.ui, {
						run,
						path,
						reload: () => {
							load();
							registerGateway();
							router = makeRouter();
						},
					});
				}
				if (command === "start" || command === "stop") {
					ctx.ui.notify(command === "start" ? "Starting local ARC. The first start downloads about 1 GB, once." : "Stopping local ARC…", "info");
					await rayline(run, command === "start" ? ["start", "--decisions", "local"] : ["stop"], { timeout: 15 * 60_000 });
					if (command === "start") await localRoutes(undefined, true);
					if (config?.decisions !== "local") {
						return ctx.ui.notify(
							command === "start" ? "Local ARC ready. This session uses hosted decisions; choose local with /rayline setup." : "Local ARC stopped.",
							"info",
						);
					}
					ctx.ui.setStatus("rayline", command === "start" ? "route: local, ready" : "route: local, not running");
					return ctx.ui.notify(command === "start" ? "Local ARC ready: routing decisions run locally." : "Local ARC stopped.", "info");
				}
			} catch (error) {
				return ctx.ui.notify((error as Error).message, "error");
			}
			if (command) return ctx.ui.notify(`Rayline: unknown command /rayline ${command}. Use /rayline, /rayline setup, /rayline start or /rayline stop.`, "error");
			if (!router || !config) return ctx.ui.notify(String(configError), "error");
			ctx.ui.notify(summary(config, router.stats, existsSync(path) ? path : "built-in (no rayline.json)"), "info");
		},
	});
}

/** `/rayline`: where decisions ran, how long they took, and which models took the turns. */
export function summary(config: Config, stats: Stats, source: string): string {
	const local = config.decisions === "local";
	const { lookups, elapsedMs, firstMs, models, last } = stats;
	const later = lookups > 1 && firstMs !== undefined ? Math.round((elapsedMs - firstMs) / (lookups - 1)) : undefined;
	const times = !lookups ? "" : later === undefined ? `: ${firstMs} ms` : `: first ${firstMs} ms, then ${later} ms mean`;
	const used = Object.entries(models)
		.sort((a, b) => b[1] - a[1])
		.map(([model, turns]) => `${model} ${turns} ${turns === 1 ? "turn" : "turns"}`);
	return [
		local ? "Rayline ARC: local decisions on this Mac (arc-swift-1.0)" : "Rayline ARC: hosted decisions (arc-swift-1.0)",
		`Config ${source}`,
		`${lookups} ${lookups === 1 ? "turn" : "turns"} decided${times}`,
		...(used.length ? [`Models: ${used.join(", ")}`] : []),
		local
			? `Hosted decisions this session: ${stats.hosted}`
			: `${stats.encodedTokens} encoded tokens billed, ${stats.fallbacks} fallbacks`,
		`Last: ${last ?? "none yet"}`,
	].join("\n");
}
