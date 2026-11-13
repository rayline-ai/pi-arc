/**
 * The virtual model's `route()`: when to ask ARC, which candidates to offer,
 * and what to do when ARC cannot answer.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionContext,
	estimateTokens,
	type ModelRoute,
	type ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { type Route, type RouteRequest, RoutesError, requestRoute } from "./routes.ts";
import { toAnthropic } from "./transcript.ts";

type Level = ModelRoute["thinkingLevel"];
type Served = { model: Model<any>; thinkingLevel?: Level };

/** A failed request whose provider is busy, worth asking ARC again without it. */
const OVERLOADED = /\b(429|5\d\d)\b|overload|rate.?limit|capacity|unavailable/i;

/** Pi thinking level for a route's `thinking`, with the thresholds from the "Applying effort" guide. */
export function levelFor(thinking: Route["thinking"]): Level {
	if (thinking.mode === "off") return "off";
	const budget = thinking.budget_tokens;
	if (budget == null) return "medium"; // ARC leaves the amount to the provider's default.
	return budget <= 2_000 ? "low" : budget <= 4_000 ? "medium" : "high";
}

export interface Stats {
	lookups: number;
	encodedTokens: number;
	elapsedMs: number;
	fallbacks: number;
	last?: string;
}

export interface RouterDeps {
	apiKey(ctx: ExtensionContext): Promise<string | undefined>;
	tools(): RouteRequest["tools"];
	requestRoute?: typeof requestRoute;
}

export function createRouter(config: Config, deps: RouterDeps) {
	const stats: Stats = { lookups: 0, encodedTokens: 0, elapsedMs: 0, fallbacks: 0 };
	const fetchRoute = deps.requestRoute ?? requestRoute;

	const find = (ctx: ExtensionContext, ref: string) => {
		const slash = ref.indexOf("/");
		return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
	};
	const arcIdOf = (model: Model<any>) =>
		Object.keys(config.models).find((id) => config.models[id] === `${model.provider}/${model.id}`);
	const keep = (served: Served): ModelRoute => ({ model: served.model, thinkingLevel: served.thinkingLevel ?? "off" });

	/** The model that answered last, else the configured fallback. */
	function fallback(request: ModelRouteRequest, ctx: ExtensionContext, error?: unknown): ModelRoute {
		if (request.previous) return keep(request.previous);
		const model = config.fallback ? find(ctx, config.fallback) : undefined;
		if (!model) throw error ?? new Error("Rayline: nothing has answered yet and no fallback model is configured");
		return { model, thinkingLevel: "off" };
	}

	async function route(request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> {
		const status = (text: string) => ctx.ui.setStatus("rayline", text);
		const { reason, previous, failed } = request;

		// Tool follow-ups stay on the model that started the task, and keep its prompt cache.
		if (reason === "continuation" && previous) {
			status("route: kept");
			return keep(previous);
		}
		// Pi's own requests, such as compaction summaries, are not worth a lookup.
		if (reason === "direct") return fallback(request, ctx);
		// A retry stays on the failed model unless its provider is overloaded; then ARC chooses without it.
		let skip: string | undefined;
		if (reason === "retry" && failed) {
			if (!OVERLOADED.test(failed.message.errorMessage ?? "")) {
				status("route: retry");
				return keep(failed);
			}
			skip = arcIdOf(failed.model);
		}

		// Offer only models in Pi's catalog whose window holds the conversation, with Pi's compaction reserve.
		const tokens = request.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const candidates = Object.keys(config.models).filter((id) => {
			const model = find(ctx, config.models[id]);
			return id !== skip && model !== undefined && tokens + DEFAULT_COMPACTION_SETTINGS.reserveTokens <= model.contextWindow;
		});
		if (candidates.length === 0) {
			status("route: no candidate fits");
			return fallback(request, ctx);
		}

		const started = performance.now();
		try {
			const apiKey = await deps.apiKey(ctx);
			if (!apiKey) throw new Error("Rayline: no API key. Set RAYLINE_API_KEY or add \"rayline\" to auth.json");
			const { system, messages } = toAnthropic(request.messages);
			const result = await fetchRoute(
				{
					model: config.arc ?? "arc-swift-1.0",
					max_tokens: 32_000,
					system: system || ctx.getSystemPrompt() || undefined,
					messages,
					tools: deps.tools(),
					routing: {
						models: candidates,
						...(config.v_value !== undefined && { v_value: config.v_value }),
						...(config.prices && { prices: config.prices }),
						...(config.price_profile && { price_profile: config.price_profile }),
					},
				},
				{
					apiKey,
					conversationId: ctx.sessionManager.getSessionId(),
					url: config.url,
					timeoutMs: config.timeout_ms,
					signal: request.signal,
				},
			);
			const ref = config.models[result.model];
			const model = ref ? find(ctx, ref) : undefined;
			if (!model) throw new Error(`Rayline: ARC chose ${result.model}, which is not in your models`);

			const ms = Math.round(performance.now() - started);
			stats.lookups += 1;
			stats.encodedTokens += result.usage?.encoded_input_tokens ?? 0;
			stats.elapsedMs += ms;
			stats.last = `${result.route_id}: ${ref} in ${ms} ms`;
			status(`route: ${ms} ms`);
			return { model, thinkingLevel: levelFor(result.thinking) };
		} catch (error) {
			if (request.signal?.aborted || !recoverable(error)) throw error;
			const routed = fallback(request, ctx, error);
			stats.fallbacks += 1;
			stats.last = `unavailable: ${routed.model.provider}/${routed.model.id}`;
			status("route: unavailable");
			ctx.ui.notify(`Rayline routing unavailable, using ${routed.model.id}: ${(error as Error).message}`, "warning");
			return routed;
		}
	}

	return { route, stats };
}

/**
 * Worth falling back for: the network, a timeout, and the statuses the API
 * marks retryable, plus 413 (too large for ARC, fine for the model).
 * A bad key or request fails the turn instead, so it gets fixed.
 */
function recoverable(error: unknown): boolean {
	if (error instanceof RoutesError) return error.retryable || error.status === 413;
	return error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError");
}
