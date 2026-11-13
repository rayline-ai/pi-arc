/**
 * Client for the Rayline Routes API (`POST /v1/routes`).
 *
 * Types cover the fields this extension sends and reads; the full contract is
 * https://docs.rayline.ai/arc/reference/routes. No Pi imports here.
 */

import type { AnthropicMessage } from "./transcript.ts";

export const ROUTES_URL = "https://api.rayline.ai/v1/routes";

/** USD per million tokens. Leave a leg out to use the catalog price. */
export interface Prices {
	input?: number;
	cache_read?: number;
	cache_write?: number;
	output?: number;
}

export interface Routing {
	/** What one successful result is worth to you, in USD. Only with `arc-1.0`. */
	v_value?: number;
	/** The models ARC may choose from. */
	models?: string[];
	/** Your inference prices; they change the choice, never the route's cost. */
	prices?: Record<string, Prices>;
	/** A saved price profile. */
	price_profile?: { id: string; version?: number };
}

export interface RouteRequest {
	/** An ARC model ID: `arc-swift-1.0`, `arc-sage-1.0`, or `arc-1.0` with `routing.v_value`. */
	model: string;
	/** Required by the Anthropic Messages format; does not affect the route. */
	max_tokens: number;
	system?: string;
	messages: AnthropicMessage[];
	tools?: { name: string; description: string; input_schema: unknown }[];
	routing?: Routing;
}

export interface Route {
	route_id: string;
	/** The model to run. */
	model: string;
	/** The reasoning configuration the choice was scored under. Apply it as given. */
	thinking: { mode: "on" | "off"; budget_tokens: number | null };
	warnings: string[];
	/** The tokens ARC read to choose this route: what the lookup is billed for. */
	usage: { encoded_input_tokens: number; cache_read_tokens: number };
	/** Time ARC spent choosing. */
	latency_ms: number;
}

/** An error response. `retryable` follows the status table in the API reference. */
export class RoutesError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(status: number, code: string | undefined, message: string) {
		super(`Rayline Routes API ${status}${code ? ` ${code}` : ""}: ${message}`);
		this.status = status;
		this.code = code;
	}

	get retryable(): boolean {
		return this.status === 429 || this.status >= 500;
	}
}

export interface RequestOptions {
	apiKey: string;
	/** Same value on every turn of one conversation. */
	conversationId: string;
	url?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function requestRoute(body: RouteRequest, options: RequestOptions): Promise<Route> {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 5_000);
	const response = await fetch(options.url ?? ROUTES_URL, {
		method: "POST",
		redirect: "error",
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${options.apiKey}`,
			"x-conversation-id": options.conversationId,
		},
		body: JSON.stringify(body),
	});
	const result = await response.json().catch(() => undefined);
	if (!response.ok) {
		throw new RoutesError(response.status, result?.error?.code, result?.error?.message ?? response.statusText);
	}
	return result as Route;
}
