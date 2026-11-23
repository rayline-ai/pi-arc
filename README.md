# pi-arc

Rayline ARC routing for [Pi](https://pi.dev). Select one model,
`rayline/arc`. On each turn ARC picks the model: the one you run yourself
when it can do the job and the conversation fits, otherwise one of the cloud
models you choose. On an Apple Silicon Mac, when you choose local decisions
in `/rayline setup`, the routing decisions run locally, in the
[Rayline CLI](https://github.com/rayline-ai/rayline-cli)'s local process.
Pi runs the turn itself, so the footer, `/session` costs and context
limits show the model that really answered.

```
you ──▶ Pi ──route()──▶ ARC (local or hosted) ──▶ "your local GLM" or "a cloud model you chose"
         │
         ├──▶ local model   (your server)
         └──▶ cloud model   (through Rayline with your Rayline key, or your own provider key)
```

## Quick start

Requires Pi 1.1.0 or later. Install the extension:

```bash
pi install git:github.com/rayline-ai/pi-arc
```

With the default cloud models, cloud turns run through Rayline with your
Rayline API key ([create one](https://docs.rayline.ai/platform/api-keys)),
and Pi lists `arc` only once the key is set. Run `/login rayline` in Pi, set
`RAYLINE_API_KEY`, or add it to Pi's `~/.pi/agent/auth.json` (a `!command`
keeps it off disk):

```json
{ "rayline": { "type": "api_key", "key": "!op read op://Private/Rayline/credential" } }
```

Then in Pi:

```
/rayline setup
```

and choose local decisions (Rayline CLI 0.5.2 or later). Setup checks that the
Rayline CLI is installed (and shows the install command if it is missing), signs you in with
`rayline auth login`, starts the local process
(`rayline local start --decisions local`; the first start downloads about
1 GB, once), and saves `"decisions": "local"` in `~/.pi/agent/rayline.json`.

Then pick the model: run `/model`, choose `arc`, and press Ctrl+S to keep it
as the default. (`/model rayline/arc` also works, but only for the current
session; `/new` goes back to your default.)

By default ARC routes between your local models (below) and Claude Opus 5.5,
Claude Haiku 5.5 and GPT-6 Luna, all run through Rayline. Choose your own
cloud models with `cloud` in [Configuration](#configuration).

The footer shows each decision, for example
`route: local · z-ai/glm-5.3-flash · 57 ms`, and the model that answered
(`arc → <model>`). `/rayline` shows the session's decisions (the first one
encodes the whole prompt, so it is slower), the models that took the turns,
and `Hosted decisions this session: 0`. `/rayline stop` and `/rayline start`
stop and start the local process.

There is no fallback to hosted ARC: when the local process is not running or
cannot decide, the turn fails and says how to start it. After a restart the
extension finds the new address and token itself, with
`rayline local status --json`.

Local decisions are not metered. Turns served by Rayline Cloud models are
billed as usual.

## Add a local model

Serve it with any OpenAI-compatible server (vLLM, llama.cpp, ...) and add it
to `~/.pi/agent/models.json` as usual. Its `contextWindow` there is what ARC
checks the prompt against. Then map its ARC model ID to the Pi model in
`~/.pi/agent/rayline.json` (keep the `decisions` setup saved):

```json
{ "local": { "z-ai/glm-5.3-flash": "local/glm-5.3-flash" } }
```

ARC now prefers the local model when it can do the job and the conversation
fits, and uses your cloud models otherwise.

## Hosted decisions

Not on an Apple Silicon Mac, or without the Rayline CLI: run `/rayline setup`
and choose hosted decisions, or start Pi with only a Rayline key:

```bash
export RAYLINE_API_KEY=rlk-...
pi --model rayline/arc
```

Rayline's Routes API then makes each decision, with your Rayline key. The
footer shows how long the lookup took (`route: 1206 ms`), and `/rayline`
shows the session's lookups, billed tokens and the last route.

## Configuration

`~/.pi/agent/rayline.json` is optional; every field has a default. Each
model entry maps an ARC model ID to the Pi model that runs it.

| Field | Meaning | Default |
|---|---|---|
| `local` | Models you run yourself. Priced at zero and preferred when ARC expects them to do the job | none |
| `cloud` | Cloud models. `rayline/<id>` runs through Rayline with your Rayline key (`<id>` is Rayline's model name, e.g. `claude-opus-5-5` or `openai/gpt-6-luna`); `anthropic/...`, `openai/...` use your own provider key in Pi | Opus 5.5, Haiku 5.5 and GPT-6 Luna via Rayline |
| `fallback` | Pi model for a first turn ARC cannot route | the first `local` model, else Haiku via Rayline |
| `url` | Hosted Routes API URL; not with `decisions: "local"` | `https://api.rayline.ai/v1/routes` |
| `timeout_ms` | Lookup timeout | 8000 |
| `decisions` | `hosted`: Rayline's Routes API decides, with your Rayline key. `local`: the Rayline CLI's local process decides on this machine | `hosted` |

[`examples/`](examples) has a local + Rayline setup and a cloud-only one with
your own provider keys. Set `RAYLINE_PI_CONFIG` to use another file.

## How it routes

| Request | What happens |
|---|---|
| You send a message | ARC chooses. A local model is offered with whether the prompt fits its window |
| Tool follow-up | Stays on the same model, no lookup: the task keeps its prompt cache |
| Retry after an error | Stays on the same model; if the provider is overloaded, ARC chooses again without it |
| After compaction | ARC chooses again, told that the history was compacted |
| Compaction summary | Stays on the last model, no lookup |
| ARC unreachable, timeout, 429/5xx/413 | Hosted: stays on the last model (or `fallback`) and warns. Local decisions: the turn fails |
| Bad key, bad config, empty balance | The turn fails with Rayline's error, so you can fix it |

These are the Rayline CLI's settings: `arc-swift-1.0`, the
`arc-policy.prefer-local.v1` policy with `min_p_pass` 0.5, local models
priced at zero, and an execution context that tells ARC where each model runs
and which one wrote each reply. [docs/rayline-api.md](docs/rayline-api.md)
lists every field.

## What Rayline sees, and what it costs

With hosted decisions, each lookup sends the conversation, system prompt and
active tool schemas to Rayline; with local decisions, lookups stay on this
machine. A local turn runs on your server; a `rayline/` cloud turn runs
through Rayline and is billed there (Pi shows it at $0); other cloud turns go
from Pi to your provider. Local decisions are not metered. Hosted lookups
are billed per token ARC reads, take about 1–2 s, and are limited to 30 per
minute per account. See
[data and privacy](https://docs.rayline.ai/platform/data-privacy).

## Limits

- ARC reads the whole conversation on every lookup, so hosted lookups cost
  more as a session grows, and the first local decision of a session is
  slower than the rest.
- ARC is offered each model with its default reasoning and no per-turn
  steering, but Pi runs every turn at its `medium` thinking level.
- Models run through Rayline are declared to Pi with a 200k context window,
  so Pi compacts earlier than a 1M model needs.
- The local fit check is an upper bound from the prompt's bytes, as in
  the Rayline CLI without a tokenizer, so a local model is handed off early
  rather than late.

## Development

```bash
npm install
npm run check   # types
npm test        # unit tests, no network
pi -e . --model rayline/arc
```

| File | Role |
|---|---|
| `src/routes.ts` | Routes API client. No Pi imports |
| `src/execution.ts` | Hybrid's settings and execution context: action IDs, capacity, events |
| `src/transcript.ts` | Pi messages → Anthropic Messages body |
| `src/config.ts` | `rayline.json` |
| `src/router.ts` | `route()`: when to ask, what to send, fallbacks |
| `src/index.ts` | Registers the virtual model, the `rayline` provider and `/rayline` |

## License

MIT

## Contributing

Open a pull request against `main`. It needs passing `test (node 22)` and `test (node 24)` checks and a review before it merges.
