/**
 * Client for the Rayline Routes API (`POST /v1/routes`). No Pi imports.
 * https://docs.rayline.ai/arc/reference/routes
 */

import { createHash } from "node:crypto";
import type { AnthropicMessage } from "./transcript.ts";

export const ROUTES_URL = "https://api.rayline.ai/v1/routes";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface RouteRequest {
	/** An ARC model ID, e.g. `arc-swift-1.0`. */
	model: string;
	/** Required by the Anthropic Messages format; does not affect the route. */
	max_tokens: number;
	system?: string;
	messages: AnthropicMessage[];
	tools?: { name: string; description: string; input_schema: unknown }[];
	routing: Record<string, unknown>;
}

/** One result: the route at a preset (`presets.swift`), or the top level. */
export interface RouteResult {
	model?: string;
	worker?: string;
	thinking?: { mode: "on" | "off"; budget_tokens: number | null };
	/** With an execution context: the action ARC chose. */
	identity?: { action_id?: string };
}

export interface RouteResponse extends RouteResult {
	route_id?: string;
	presets?: Record<string, RouteResult>;
	/** Echo of each `routing` member, with `status` `applied` or `unsupported`. */
	routing?: Record<string, { status?: string } | undefined>;
	usage?: { encoded_input_tokens?: number };
	latency_ms?: number;
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
	/** The Pi session: the same on every turn of one conversation. */
	sessionId: string;
	url?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function requestRoute(body: RouteRequest, options: RequestOptions): Promise<RouteResponse> {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 8_000);
	const response = await fetch(options.url ?? ROUTES_URL, {
		method: "POST",
		redirect: "error",
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		// The same identity headers raydock hybrid sends.
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${options.apiKey}`,
			"x-conversation-id": sha256(options.sessionId),
			"x-rayline-branch-id": sha256("main"),
			"x-rayline-wire-format": "anthropic.messages.v1",
		},
		body: JSON.stringify(body),
	});
	const result = await response.json().catch(() => undefined);
	if (!response.ok) {
		throw new RoutesError(response.status, result?.error?.code, result?.error?.message ?? response.statusText);
	}
	return result as RouteResponse;
}
