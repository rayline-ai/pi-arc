# pi-rayline

Rayline ARC routing for [Pi](https://pi.dev). Select one model, `rayline/arc`,
and ARC chooses which of your models answers each turn. Pi runs that model with
your own provider keys, so the footer, `/session` costs and context limits all
show the model that really answered.

```
you ──▶ Pi ──route()──▶ Rayline Routes API ──▶ "openai/gpt-6-luna, thinking on"
         │
         └──▶ runs openai/gpt-6-luna with your OpenAI key
```

## Install

```bash
pi install git:github.com/rayline-ai/pi-rayline
```

Requires Pi 1.1.0 or later and a Rayline API key
([create one](https://docs.rayline.ai/platform/api-keys)).

## Configure

**1. Key.** Set `RAYLINE_API_KEY`, or add it to Pi's `~/.pi/agent/auth.json`
(a `!command` keeps it off disk):

```json
{ "rayline": { "type": "api_key", "key": "!op read op://Private/Rayline/credential" } }
```

**2. Models.** Create `~/.pi/agent/rayline.json`. Each entry maps an ARC model
ID to the Pi model that runs it:

```json
{
  "models": {
    "anthropic/claude-opus-5.5": "anthropic/claude-opus-5-5",
    "anthropic/claude-haiku-5.5": "anthropic/claude-haiku-5-5",
    "openai/gpt-6-luna": "openai/gpt-6-luna"
  },
  "fallback": "anthropic/claude-haiku-5-5"
}
```

ARC chooses only among these models, so list the ones you have keys for.
[`examples/`](examples) has a cloud setup and one with a model you run
yourself.

| Field | Default | Meaning |
|---|---|---|
| `models` | required | ARC model ID → Pi model (`provider/id`) |
| `arc` | `arc-swift-1.0` | `arc-swift-1.0` favors cost, `arc-sage-1.0` favors quality, `arc-1.0` uses your `v_value` |
| `v_value` | | What one successful result is worth to you, in USD (0.1–30). Only with `arc-1.0` |
| `prices` | catalog | Your prices per ARC model ID, in USD per million tokens. Use 0 for a model you run yourself |
| `price_profile` | | A saved price profile, `{ "id": "...", "version": 3 }` |
| `fallback` | | Pi model for a first turn ARC cannot route |
| `url` | `https://api.rayline.ai/v1/routes` | Routes API URL |
| `timeout_ms` | `5000` | Lookup timeout |

Set `RAYLINE_PI_CONFIG` to use another file.

## Use

```bash
pi --model rayline/arc
```

The footer shows the model that answered (`arc → gpt-6-luna`) and how long the
lookup took (`route: 1206 ms`). `/rayline` shows this session's lookups, billed
tokens and the last route.

## How it routes

| Request | What happens |
|---|---|
| You send a message | ARC chooses among the models whose context window holds the conversation |
| Tool follow-up | Stays on the same model, no lookup: the task keeps its prompt cache |
| Retry after an error | Stays on the same model; if the provider is overloaded, ARC chooses again without it |
| Compaction summary | Stays on the last model, no lookup |
| ARC is unreachable, times out or returns 429/5xx/413 | Stays on the last model (or `fallback`) and warns |
| Bad key, bad config, empty balance | The turn fails with Rayline's error, so you can fix it |

ARC returns a model and a reasoning setting. The extension maps the setting to
Pi's thinking level: off → `off`, a budget of up to 2,000 tokens → `low`, up
to 4,000 → `medium`, more → `high`, and no budget → `medium`.

## What Rayline sees, and what it costs

Each lookup sends the conversation, system prompt and active tool schemas to
Rayline, with the Pi session ID as `x-conversation-id`. It runs nothing: the
model call goes from Pi to your provider. Lookups are billed per token ARC
reads (`usage.encoded_input_tokens`), take about 1–2 s, and are limited to 30
per minute per account. Routes API requests are never used to train ARC; see
[data and privacy](https://docs.rayline.ai/platform/data-privacy).

[docs/rayline-api.md](docs/rayline-api.md) lists every field the extension
sends and reads.

## Limits

- The Routes API does not keep conversations yet, so each lookup reads the
  whole conversation again and costs more as a session grows.
- ARC's per-turn steering (`thinking_level`) is not applied.

## Development

```bash
npm install
npm run check   # types
npm test        # unit tests, no network
pi -e . --model rayline/arc
```

Code layout, from the API outward:

| File | Role |
|---|---|
| `src/routes.ts` | Routes API client and types. No Pi imports |
| `src/transcript.ts` | Pi messages → Anthropic Messages body |
| `src/config.ts` | `rayline.json` |
| `src/router.ts` | `route()`: when to ask, which candidates, fallbacks |
| `src/index.ts` | Registers the virtual model, the key and `/rayline` |

## License

MIT
