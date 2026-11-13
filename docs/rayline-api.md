# How pi-rayline uses the Rayline API

The extension uses one endpoint, the public
[Routes API](https://docs.rayline.ai/arc/reference/routes), and nothing else.
All of it is in `src/routes.ts`.

## Request

`POST https://api.rayline.ai/v1/routes`

| Header | Value |
|---|---|
| `authorization` | `Bearer <Rayline API key>` |
| `x-conversation-id` | The Pi session ID, the same on every turn |

The body is an Anthropic Messages request:

| Field | Source |
|---|---|
| `model` | `arc` from `rayline.json` (default `arc-swift-1.0`) |
| `max_tokens` | `32000`. Required by the format; it does not affect the route |
| `system` | Pi's system prompt |
| `messages` | The conversation. Tool calls and results become `tool_use` and `tool_result` blocks; thinking blocks are left out |
| `tools` | The active tools' names, descriptions and schemas |
| `routing.models` | The ARC IDs in `models` whose Pi model is in the catalog and whose context window holds the conversation, minus a model whose provider just reported it was overloaded |
| `routing.prices` | `prices`, as configured |
| `routing.price_profile` | `price_profile`, as configured |
| `routing.v_value` | `v_value`, as configured |

## Response

| Field | Use |
|---|---|
| `model` | Looked up in `models` to find the Pi model to run. A model not listed there fails the turn |
| `thinking` | Mapped to Pi's thinking level (see the README) |
| `route_id` | Shown in `/rayline` |
| `usage.encoded_input_tokens` | Added to the billed tokens in `/rayline` |

Other fields (`alternatives`, `presets`, `warnings`, the `routing` echo) are
not used.

## Errors

| Status | Handling |
|---|---|
| `429`, `5xx`, `413`, network error, timeout | Fall back to the last model, or `fallback`, with a warning |
| Any other `4xx` (`401`, `402`, `400 unknown_model`, ...) | Fail the turn with Rayline's message |
