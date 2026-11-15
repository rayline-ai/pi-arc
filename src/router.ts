/**
 * The virtual model's `route()`: when to ask ARC, what to tell it, and what
 * to do when it cannot answer.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { type Config, type Target, targetsOf } from "./config.ts";
import { type LocalRoutes, NOT_RUNNING, RESTART_HINT, START_HINT } from "./local.ts";
import { ARC_MODEL, actionIdOf, capacity, executionContext, POLICY, PRESET, replyAllowance, routing } from "./execution.ts";
import { type RouteRequest, RoutesError, requestRoute, sha256 } from "./routes.ts";
import { toAnthropic } from "./transcript.ts";

/** Stored by Pi on the session branch. */
export interface RouterState {
	/** Identifies the conversation's start, to notice compaction. */
	head: string;
	/** The last route, which a same-turn re-ask refers to. */
	route?: string;
}

type Request = ModelRouteRequest<RouterState>;
type Route = ModelRoute<RouterState>;
type Served = { model: Model<any>; thinkingLevel?: Route["thinkingLevel"] };

/** The level Pi runs every action at: the default control leaves reasoning to the model. */
const THINKING = "medium";
/** A failed request whose provider is busy, worth asking ARC again without it. */
const OVERLOADED = /\b(429|500|502|503|504|529)\b|overload|rate.?limit|capacity|unavailable/i;

export interface Stats {
	lookups: number;
	encodedTokens: number;
	elapsedMs: number;
	fallbacks: number;
	/** The first lookup's time: it encodes the whole prompt, so it is slower than later ones. */
	firstMs?: number;
	/** Turns ARC gave each Pi model (`provider/id`). */
	models: Record<string, number>;
	/** Lookups that went to the hosted Routes API. */
	hosted: number;
	last?: string;
}

export interface RouterDeps {
	apiKey(ctx: ExtensionContext): Promise<string | undefined>;
	/** With `decisions: "local"`: the local Routes API; `fresh` looks it up again. */
	localRoutes?(signal?: AbortSignal, fresh?: boolean): Promise<LocalRoutes>;
	tools(): RouteRequest["tools"];
	requestRoute?: typeof requestRoute;
	/** Session totals, kept across routers when the config is reloaded. */
	stats?: Stats;
}

export const newStats = (): Stats => ({ lookups: 0, encodedTokens: 0, elapsedMs: 0, fallbacks: 0, models: {}, hosted: 0 });

export function createRouter(config: Config, deps: RouterDeps) {
	const targets = targetsOf(config);
	const stats = deps.stats ?? newStats();
	const fetchRoute = deps.requestRoute ?? requestRoute;
	const local = config.decisions === "local";

	/** Hosted: Rayline's Routes API with the Rayline key. Local: the local process, looked up again once after a restart. */
	async function ask(body: RouteRequest, ctx: ExtensionContext, signal?: AbortSignal) {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!local) {
			const apiKey = await deps.apiKey(ctx);
			if (!apiKey) throw new Error('Rayline: no API key. Set RAYLINE_API_KEY or add "rayline" to auth.json');
			return fetchRoute(body, { apiKey, sessionId, url: config.url, timeoutMs: config.timeout_ms, signal });
		}
		if (!deps.localRoutes) throw new Error("Rayline: local decisions are not available here");
		let token = "";
		const once = (routes: LocalRoutes) => {
			token = routes.token;
			return fetchRoute(body, { apiKey: routes.token, sessionId, url: routes.url, timeoutMs: config.timeout_ms, signal });
		};
		// Errors from the local process are shown in Pi: never with its token in them.
		const redact = (error: unknown) => {
			if (token && error instanceof Error && error.message.includes(token)) error.message = error.message.replaceAll(token, "<token>");
			return error;
		};
		try {
			return await once(await deps.localRoutes(signal));
		} catch (error) {
			const restarted = error instanceof TypeError || (error instanceof RoutesError && error.status === 401);
			if (signal?.aborted) throw error;
			if (error instanceof DOMException && error.name === "TimeoutError") throw new Error(`Rayline: local ARC did not decide in time. ${START_HINT}`);
			if (!restarted) throw redact(error);
			try {
				return await once(await deps.localRoutes(signal, true));
			} catch (again) {
				if (again instanceof TypeError) throw new Error(NOT_RUNNING);
				if (again instanceof RoutesError && again.status === 401) throw new Error(`Rayline: local ARC refused its token. ${RESTART_HINT}`);
				if (again instanceof DOMException && again.name === "TimeoutError") throw new Error(`Rayline: local ARC did not decide in time. ${START_HINT}`);
				throw redact(again);
			}
		}
	}

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
		// After compaction (the conversation's start changed), ARC chooses again.
		if (reason === "continuation" && previous && !rewritten) {
			// The footer keeps showing the decision that chose this model.
			return keep(previous, state);
		}
		// A retry stays on the failed model unless its provider is overloaded; then ARC chooses without it.
		let skip: Target | undefined;
		if (reason === "retry" && failed && !rewritten) {
			if (!OVERLOADED.test(failed.message.errorMessage ?? "")) {
				status("route: retry");
				return keep(failed, state);
			}
			skip = targetOf(failed.model.provider, failed.model.id);
		}

		const started = performance.now();
		try {
			const system = transcript.system || ctx.getSystemPrompt();
			const tools = deps.tools();
			const promptBytes =
				Buffer.byteLength(JSON.stringify({ system, messages: transcript.messages, tools }, null, 4)) + transcript.thinkingBytes;
			const images = transcript.messages.some((message) => message.content.some((block) => block.type === "image"));
			const offered = targets
				.filter((target) => target !== skip && find(ctx, target.pi))
				.map((target) => {
					const model = find(ctx, target.pi)!;
					const window = { window: model.contextWindow, output: replyAllowance(model.contextWindow, model.maxTokens) };
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
				reconsult: skip && request.state?.route ? { retryOf: request.state.route } : undefined,
				targets: offered,
			});

			const response = await ask(
				{
					model: ARC_MODEL,
					max_tokens: 32_000,
					...(system && { system }),
					messages: transcript.messages,
					tools,
					routing: routing(targets, execution),
				},
				ctx,
				request.signal,
			);
			// Like the Rayline CLI, accept a route only if ARC applied this context and the prefer-local policy.
			const echo = response.routing as { execution?: { status?: string; turn?: { id?: string } }; policy?: { status?: string; preset?: string } } | undefined;
			if (echo?.execution?.status !== "applied" || echo.execution.turn?.id !== execution.turn.id) {
				throw new Error("Rayline: ARC did not apply the execution context");
			}
			if (echo.policy?.status !== "applied" || echo.policy.preset !== POLICY.preset) {
				throw new Error("Rayline: ARC did not apply the prefer-local policy");
			}
			const chosen = response.presets?.[PRESET]?.identity?.action_id;
			const target = offered.find(({ target }) => actionIdOf(target.arc) === chosen)?.target;
			if (!target) throw new Error(`Rayline: ARC chose ${response.presets?.[PRESET]?.model ?? "an action"} that was not offered`);
			const model = find(ctx, target.pi)!;

			const ms = Math.round(performance.now() - started);
			stats.lookups += 1;
			if (!local) stats.hosted += 1;
			stats.encodedTokens += response.usage?.encoded_input_tokens ?? 0;
			stats.elapsedMs += ms;
			stats.firstMs ??= ms;
			stats.models[target.pi] = (stats.models[target.pi] ?? 0) + 1;
			stats.last = `${response.route_id}: ${target.pi} in ${ms} ms`;
			status(local ? `route: local · ${target.arc} · ${ms} ms` : `route: ${ms} ms`);
			return { model, thinkingLevel: THINKING, state: { head, ...(response.route_id && { route: response.route_id }) } };
		} catch (error) {
			// Local decisions never fall back: the turn fails and says how to fix it.
			if (local) status((error as Error).message === NOT_RUNNING ? "route: local, not running" : "route: local, no decision");
			if (local || request.signal?.aborted || !recoverable(error)) throw error;
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
