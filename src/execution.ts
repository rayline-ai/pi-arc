/**
 * What rayline local tells ARC besides the conversation: where each model
 * runs, whether the prompt fits a local model, and which model wrote each
 * reply (`routing.execution`, version `arc-execution-context.v2`). The
 * `prefer-local` policy needs it to prefer a model you run yourself.
 */

import type { Target } from "./config.ts";
import { sha256 } from "./routes.ts";
import type { Transcript } from "./transcript.ts";

/** rayline local's routing settings. */
export const ARC_MODEL = "arc-swift-1.0";
export const PRESET = "swift";
export const POLICY = { preset: "arc-policy.prefer-local.v1", overrides: { selection: { min_p_pass: 0.5 } } };
const ZERO = { input: 0, cache_read: 0, cache_write: 0, output: 0 };

/** The thinking-control registry's `default` control: the model's own reasoning, no steering. */
const DEFAULT_CONTROL = "628d285537ca7cdb52c4bd3433cea7a1ec36005a14dbc67ffa1c40487d7b8ad0";
/** The longest preamble a served chat template adds, as rayline local assumes. */
const TEMPLATE_MARGIN_TOKENS = 512;
/** Start of the user message Pi writes in place of compacted history. */
const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:";

/** ARC's worker name: the model ID without its vendor, e.g. `glm-5.3-flash`. */
export const workerOf = (arc: string) => arc.slice(arc.indexOf("/") + 1);

/** ARC's action ID for a model, derived as rayline local derives it. */
export const actionIdOf = (arc: string) =>
	sha256(JSON.stringify({ control_id: DEFAULT_CONTROL, model: workerOf(arc) }));

/** `routing` as rayline local sends it: local models free, prefer-local, plus the execution context. */
export function routing(targets: Target[], execution: unknown) {
	const local = targets.filter((target) => target.placement === "local");
	return {
		policy: POLICY,
		...(local.length > 0 && { prices: Object.fromEntries(local.map((target) => [target.arc, ZERO])) }),
		execution,
	};
}

export interface LocalWindow {
	/** The model's context window, in tokens. */
	window: number;
	/** The reply allowance: the model's `maxTokens`, at most a quarter of the window and 32000. */
	output: number;
}

export const replyAllowance = (window: number, maxTokens: number) =>
	Math.min(maxTokens, 32_000, Math.max(1_024, Math.floor(window / 4)));

/**
 * Whether the prompt fits a local model, stated as rayline local states it
 * without a tokenizer: an upper bound from the prompt's UTF-8 bytes (no BPE
 * token is shorter than a byte) plus 5%, a chat-template margin and the reply.
 * prefer-local leaves out a local model whose capacity is unknown. With an
 * image the bound is only an estimate, which ARC does not count as a fit.
 */
export function capacity(promptBytes: number, { window, output }: LocalWindow, images = false) {
	const required = Math.ceil(promptBytes * 1.05) + TEMPLATE_MARGIN_TOKENS + output;
	const fits = required <= window;
	return {
		fits,
		reason: fits ? null : "context_capacity",
		required,
		available: window,
		available_source: "configured",
		units: null,
		provenance: images ? "caller_estimated" : "caller_bounded",
	};
}

export interface ExecutionInput {
	transcript: Transcript;
	sessionId: string;
	reason: "user" | "continuation" | "retry";
	/** The conversation's start changed since the last request (Pi compacted or edited it). */
	rewritten: boolean;
	/** ARC model ID of each Pi model, for models in `targets`. */
	arcOf(provider: string, id: string): string | undefined;
	/** The model that answered last, if it is a target. */
	lastServed?: string;
	/** Set when asking again in the same turn because the chosen model's provider was unavailable. */
	reconsult?: { retryOf: string };
	/** Offered targets, with the capacity of each local one. */
	targets: { target: Target; capacity?: ReturnType<typeof capacity> | null }[];
}

export function executionContext(input: ExecutionInput) {
	const { messages, assistants } = input.transcript;
	const history = [...assistants].flatMap(([message, assistant]) => {
		const arc = input.arcOf(assistant.provider, assistant.model);
		return arc ? [{ message, action_id: actionIdOf(arc) }] : [];
	});
	const last = messages.at(-1);
	const answered = messages.some((message) => message.role === "assistant");
	const event = (kind: string | null, compaction: unknown = null) => ({
		kind,
		basis: kind ? "explicit_client" : "unknown",
		compaction,
	});

	let stated = event(null);
	if (input.rewritten && String(messages[0]?.content[0]?.text ?? "").startsWith(COMPACTION_PREFIX)) {
		// Right after compaction nothing new has been answered, so an assistant message after the summary is Pi's retained tail.
		stated = event("compaction", { summary_message: 0, retained_from: answered ? 1 : null, new: true });
	} else if (input.reason === "user") {
		stated = event(answered ? "user_message" : "task_start");
	} else if (last?.content.some((block) => block.type === "tool_result")) {
		stated = event("tool_result");
	}

	const served = input.lastServed && actionIdOf(input.lastServed);
	return {
		version: "arc-execution-context.v2",
		turn: {
			id: sha256(`${input.sessionId}\0main\0${messages.length}\0${sha256(JSON.stringify(last ?? null))}`),
			attempt: input.reconsult ? 2 : 1,
			epoch: messages.length > 0 ? sha256(JSON.stringify(messages[0])) : "",
			retry_of: input.reconsult?.retryOf ?? null,
			reconsult: input.reconsult ? "veto" : null,
		},
		event: stated,
		last_served:
			input.lastServed && served
				? {
						action_id: served,
						worker: workerOf(input.lastServed),
						message: history.findLast((entry) => entry.action_id === served)?.message ?? null,
					}
				: null,
		history,
		hold: null,
		expect: null,
		targets: input.targets.map(({ target, capacity }) => ({
			action_id: actionIdOf(target.arc),
			worker: workerOf(target.arc),
			placement: target.placement,
			cache: null,
			capacity: capacity ?? null,
		})),
	};
}
