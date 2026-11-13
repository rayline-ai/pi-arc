/**
 * The virtual model's `route()`: when to ask ARC, what to tell it, and what
 * to do when it cannot answer.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { type Config, type Target, targetsOf } from "./config.ts";
import { ARC_MODEL, actionIdOf, capacity, executionContext, PRESET, routing } from "./execution.ts";
import { type RouteRequest, RoutesError, requestRoute, sha256 } from "./routes.ts";
import { toAnthropic } from "./transcript.ts";

/** Stored by Pi on the session branch: identifies the conversation's start, to notice compaction. */
export interface RouterState {
	head: string;
}

type Request = ModelRouteRequest<RouterState>;
type Route = ModelRoute<RouterState>;
type Served = { model: Model<any>; thinkingLevel?: Route["thinkingLevel"] };

/** The level Pi runs every action at: the default control leaves reasoning to the model. */
const THINKING = "medium";
/** A failed request whose provider is busy, worth asking ARC again without it. */
const OVERLOADED = /\b(429|5\d\d)\b|overload|rate.?limit|capacity|unavailable/i;

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
	const targets = targetsOf(config);
	const stats: Stats = { lookups: 0, encodedTokens: 0, elapsedMs: 0, fallbacks: 0 };
	const fetchRoute = deps.requestRoute ?? requestRoute;

	const find = (ctx: ExtensionContext, ref: string) => {
		const slash = ref.indexOf("/");
		return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
	};
	const targetOf = (provider: string, id: string) => targets.find((target) => target.pi === `${provider}/${id}`);
	const keep = (served: Served, state?: RouterState): Route => ({
		model: served.model,
		thinkingLevel: served.thinkingLevel ?? THINKING,
		state,
	});

	/** The model that answered last, else the configured fallback. */
	function fallback(request: Request, ctx: ExtensionContext, state?: RouterState, error?: unknown): Route {
		if (request.previous) return keep(request.previous, state);
		const model = config.fallback ? find(ctx, config.fallback) : undefined;
		if (!model) throw error ?? new Error("Rayline: nothing has answered yet and no fallback model is configured");
		return { model, thinkingLevel: THINKING, state };
	}

	async function route(request: Request, ctx: ExtensionContext): Promise<Route> {
		const status = (text: string) => ctx.ui.setStatus("rayline", text);
		const { reason, previous, failed } = request;
		// Pi's own requests, such as compaction summaries, are not worth a lookup.
		if (reason === "direct") return fallback(request, ctx);

		const transcript = toAnthropic(request.messages);
		const head = transcript.messages.length > 0 ? sha256(JSON.stringify(transcript.messages[0])) : "";
		const rewritten = request.state !== undefined && request.state.head !== head;
		const state = request.state?.head === head ? request.state : { head };

		// Tool follow-ups stay on the model that started the task, and keep its prompt cache.
		if (reason === "continuation" && previous && !rewritten) {
			status("route: kept");
			return keep(previous, state);
		}
		// A retry stays on the failed model unless its provider is overloaded; then ARC chooses without it.
		let skip: Target | undefined;
		if (reason === "retry" && failed) {
			if (!OVERLOADED.test(failed.message.errorMessage ?? "")) {
				status("route: retry");
				return keep(failed, state);
			}
			skip = targetOf(failed.model.provider, failed.model.id);
		}

		const started = performance.now();
		try {
			const apiKey = await deps.apiKey(ctx);
			if (!apiKey) throw new Error('Rayline: no API key. Set RAYLINE_API_KEY or add "rayline" to auth.json');
			const system = transcript.system || ctx.getSystemPrompt();
			const tools = deps.tools();
			const promptBytes = Buffer.byteLength(JSON.stringify({ system, messages: transcript.messages, tools }, null, 4));
			const images = transcript.messages.some((message) => message.content.some((block) => block.type === "image"));
			const offered = targets
				.filter((target) => target !== skip && find(ctx, target.pi))
				.map((target) => {
					const model = find(ctx, target.pi)!;
					const window = { window: model.contextWindow, output: Math.min(32_000, model.maxTokens) };
					return { target, capacity: target.placement === "local" ? capacity(promptBytes, window, images) : null };
				});
			const previousTarget = previous && targetOf(previous.model.provider, previous.model.id);
			const execution = executionContext({
				transcript,
				sessionId: ctx.sessionManager.getSessionId(),
				reason,
				rewritten,
				arcOf: (provider, id) => targetOf(provider, id)?.arc,
				lastServed: previousTarget?.arc,
				targets: offered,
			});

			const response = await fetchRoute(
				{
					model: ARC_MODEL,
					max_tokens: 32_000,
					...(system && { system }),
					messages: transcript.messages,
					tools,
					routing: routing(targets, execution),
				},
				{
					apiKey,
					sessionId: ctx.sessionManager.getSessionId(),
					url: config.url,
					timeoutMs: config.timeout_ms,
					signal: request.signal,
				},
			);
			if (response.routing?.execution?.status !== "applied") {
				throw new Error("Rayline: ARC did not apply the execution context");
			}
			const chosen = response.presets?.[PRESET]?.identity?.action_id;
			const target = offered.find(({ target }) => actionIdOf(target.arc) === chosen)?.target;
			if (!target) throw new Error(`Rayline: ARC chose ${response.presets?.[PRESET]?.model ?? "an action"} that was not offered`);
			const model = find(ctx, target.pi)!;

			const ms = Math.round(performance.now() - started);
			stats.lookups += 1;
			stats.encodedTokens += response.usage?.encoded_input_tokens ?? 0;
			stats.elapsedMs += ms;
			stats.last = `${response.route_id}: ${target.pi} in ${ms} ms`;
			status(`route: ${ms} ms`);
			return { model, thinkingLevel: THINKING, state };
		} catch (error) {
			if (request.signal?.aborted || !recoverable(error)) throw error;
			const routed = fallback(request, ctx, state, error);
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
