/**
 * Pi's conversation as an Anthropic Messages body, one of the formats the
 * Routes API reads.
 */

import type { Message } from "@earendil-works/pi-ai";

type Block = Record<string, unknown>;

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: Block[];
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
 * wrote them, and ARC reads the visible conversation.
 */
export function toAnthropic(messages: readonly Message[]): { system: string; messages: AnthropicMessage[] } {
	const system: string[] = [];
	const out: AnthropicMessage[] = [];
	const push = (role: AnthropicMessage["role"], blocks: Block[]) => {
		if (blocks.length === 0) return;
		const last = out.at(-1);
		// Tool results follow a user message in the same turn: Anthropic wants one user message.
		if (role === "user" && last?.role === "user") last.content.push(...blocks);
		else out.push({ role, content: blocks });
	};

	for (const message of messages) {
		switch (message.role) {
			case "system": {
				// Pi's own prompt arrives as named sections.
				const sections = (message as { sections?: Record<string, string | null> }).sections ?? {};
				const content = message.content as UserContent;
				system.push(...userBlocks(content).map((block) => String(block.text ?? "")));
				system.push(...Object.values(sections).filter((section): section is string => !!section));
				break;
			}
			case "user":
				push("user", userBlocks(message.content));
				break;
			case "toolResult":
				push("user", [
					{
						type: "tool_result",
						tool_use_id: message.toolCallId,
						is_error: message.isError,
						content: userBlocks(message.content),
					},
				]);
				break;
			case "assistant":
				push(
					"assistant",
					message.content.flatMap((block): Block[] => {
						if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
						if (block.type === "toolCall") return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments }];
						return [];
					}),
				);
				break;
		}
	}
	return { system: system.filter(Boolean).join("\n\n"), messages: out };
}
