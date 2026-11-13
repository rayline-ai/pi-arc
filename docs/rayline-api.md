# How pi-rayline uses the Rayline API

Two endpoints, both with the Rayline key:

- `POST /v1/routes` ([Routes API](https://docs.rayline.ai/arc/reference/routes)) on every lookup, in `src/routes.ts`.
- `POST /v1/messages` for a cloud model mapped to `rayline/<id>`: Pi's own
  Anthropic client, with that model pinned.

Every value below is what `raydock hybrid` sends.

## Routes request

| Header | Value |
|---|---|
| `authorization` | `Bearer <Rayline key>` |
| `x-conversation-id` | sha256 of the Pi session ID |
| `x-rayline-branch-id` | sha256 of `main` |
| `x-rayline-wire-format` | `anthropic.messages.v1` |

| Body field | Value |
|---|---|
| `model` | `arc-swift-1.0` |
| `max_tokens` | `32000` (required by the format; no effect on the route) |
| `system`, `messages`, `tools` | Pi's system prompt, conversation (thinking blocks left out) and active tools |
| `routing.policy` | `{"preset": "arc-policy.prefer-local.v1", "overrides": {"selection": {"min_p_pass": 0.5}}}` |
| `routing.prices` | Every `local` model at 0 for all four legs |
| `routing.execution` | The execution context below |

### `routing.execution` (`arc-execution-context.v2`)

| Field | Value |
|---|---|
| `turn` | `id` from the session and the last message, `epoch` = sha256 of the first message. `attempt` 1; on a re-ask after an overloaded provider, `attempt` 2, `reconsult` `veto` and `retry_of` the replaced route |
| `event.kind` | `task_start`, `user_message`, `tool_result` or `compaction`, with `basis` `explicit_client` |
| `history` | For each assistant message, the action of the model that wrote it |
| `last_served` | The action, worker and message index of the model that answered last |
| `targets` | One per configured model not just reported overloaded: `action_id`, `worker`, `placement` (`local`/`cloud`), `cache: null`, and for a local model a `capacity` fact |
| `hold`, `expect` | `null` |

**Action ID.** ARC names each choice it can make (a model with a reasoning
setting) by an action ID. `raydock hybrid` derives it as
`sha256({"control_id":"628d…8ad0","model":"<worker>"})`, where the control is
the `default` entry of Rayline's thinking-control registry (the model's own
reasoning) and the worker is the ARC model ID without its vendor
(`glm-5.3-flash`). The extension does the same.

**Capacity.** `required = ceil(prompt bytes × 1.05) + 512 + reply allowance`,
against the Pi model's `contextWindow`. Prompt bytes include the thinking Pi
replays to the model that wrote it. The reply allowance is the model's
`maxTokens`, at most 32000 and at most a quarter of the window (at least 1024). With an image in the conversation the bound is
marked `caller_estimated`, which ARC does not count as a fit.

## Routes response

| Field | Use |
|---|---|
| `routing.execution` | Must be `applied` for this `turn.id`, or the turn fails |
| `routing.policy` | Must be `applied` with the `prefer-local` preset, or the turn fails |
| `presets.swift.identity.action_id` | The chosen action, mapped back to the configured model. An action that was not offered fails the turn |
| `route_id`, `usage.encoded_input_tokens` | Shown in `/rayline` |

## Errors

| Status | Handling |
|---|---|
| `429`, `5xx`, `413`, network error, timeout | Fall back to the last model, or `fallback`, with a warning |
| Any other `4xx` | Fail the turn with Rayline's message |
