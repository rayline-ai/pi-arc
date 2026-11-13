/**
 * Pi's conversation as an Anthropic Messages body, the format ARC reads.
 */

import { type AssistantMessage, getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";

type Block = Record<string, unknown>;

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: Block[];
}

export interface Transcript {
	system: string;
	/** UTF-8 bytes of the thinking Pi replays to the model that wrote it: not sent to ARC, but part of a local prompt. */
	thinkingBytes: number;
	messages: AnthropicMessage[];
	/** Index in `messages` → the Pi assistant message it came from, to say which model wrote it. */
	assistants: Map<number, AssistantMessage>;
}

type UserContent = string | readonly { type: string; text?: string; data?: string; mimeType?: string }[];

function userBlocks(content: UserContent): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((block) =>
		block.type === "image"
			? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
			: { type: "text", text: block.text ?? "" },
	);
}

/**
 * Thinking blocks are left out: their signatures belong to the model that
 * wrote them, and ARC reads the visible conversation. Failed or aborted
 * replies are left out with their tool results, as Pi leaves them out of
 * the next request.
 */
export function toAnthropic(messages: readonly Message[]): Transcript {
	const out: AnthropicMessage[] = [];
	const assistants = new Map<number, AssistantMessage>();
	const dropped = new Set<string>();
	let thinkingBytes = 0;
	const push = (role: AnthropicMessage["role"], blocks: Block[]) => {
		if (blocks.length === 0) return false;
		const last = out.at(-1);
		// Tool results and the next user message share one Anthropic user message.
		if (role === "user" && last?.role === "user") last.content.push(...blocks);
		else out.push({ role, content: blocks });
		return true;
	};

	for (const message of messages) {
		switch (message.role) {
			case "system":
				break;
			case "user":
				push("user", userBlocks(message.content));
				break;
			case "toolResult":
				if (dropped.has(message.toolCallId)) break;
				push("user", [
					{
						type: "tool_result",
						tool_use_id: message.toolCallId,
						is_error: message.isError,
						content: userBlocks(message.content),
					},
				]);
				break;
			case "assistant": {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					for (const block of message.content) if (block.type === "toolCall") dropped.add(block.id);
					break;
				}
				for (const block of message.content) {
					if (block.type === "thinking") thinkingBytes += Buffer.byteLength(block.thinking ?? "");
				}
				const blocks = message.content.flatMap((block): Block[] => {
					if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
					if (block.type === "toolCall") return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments }];
					return [];
				});
				if (push("assistant", blocks)) assistants.set(out.length - 1, message);
				break;
			}
		}
	}
	return { system: getCurrentSystemPrompt(messages), thinkingBytes, messages: out, assistants };
}
