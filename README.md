# Spoken — podcast transcript API and MCP server, clean Markdown with real speaker names

[Spoken](https://spoken.md) is a transcript API that turns any published podcast into clean Markdown with **real speaker names** — not "Speaker 1." One API call returns named, timestamped text, ready for LLMs, RAG pipelines, summarizers, and search. This repo also ships `spoken-mcp`, an MCP server that gives Claude Desktop, Claude Code, Cursor and Cline the same transcripts as tools — see [Use as an MCP server](#use-as-an-mcp-server).

It's a transcript *retrieval* API, not a speech-to-text service: it works on already-published podcasts, so you skip uploading audio, running diarization, and mapping anonymous speaker labels by hand. For published shows that's typically **5–10× cheaper** than running the audio through a transcription service.

- 🎙️ **Real speaker names**, resolved automatically
- 📄 **Clean Markdown** with timestamps, tuned for LLM context windows and RAG chunking
- 🔎 **Search** by text query or paste a Spotify/YouTube URL
- 💳 **Pay-per-use credits** — no subscription, failed calls never charged, repeat fetches free
- 🤖 **Agent-native** — ships with an [Agent Skill](./SKILL.md), [`agents.md`](https://spoken.md/agents.md), [`llms.txt`](https://spoken.md/llms.txt), and an [OpenAPI spec](https://spoken.md/.well-known/openapi.json)

Get a key at **[spoken.md](https://spoken.md)** — or try it free with the demo key `pt_demo` (search works fully; transcripts limited to the demo episode).

## Quickstart

```sh
# 1. Find an episode (by text, or paste a Spotify/YouTube URL)
curl -s 'https://spoken.md/search?q=huberman+sleep' \
  -H 'x-api-key: pt_demo'

# 2. Fetch the transcript as Markdown
curl -s 'https://spoken.md/transcripts/1000651996090' \
  -H 'x-api-key: pt_demo'
```

The transcript comes back as Markdown with named speakers and timestamps:

```md
**John Smith** (0:00)
Welcome to the show. Today we're talking about...

**Jane Doe** (0:15)
Thanks for having me.
```

## Endpoints

| Method & path | What it does | Credits |
| --- | --- | --- |
| `GET /search?q={query or URL}` | Find episodes; returns `id`, `title`, `podcast`, `podcastId`, `date` | 0 |
| `GET /podcasts/{podcastId}/episodes` | List a show's full back catalog; returns every episode's `id`, `title`, `date` | 0 |
| `GET /transcripts/{id}` | Return the Markdown transcript | 1 on first fetch, 0 on repeat |
| `GET /balance` | Current credit balance + usage history | 0 |
| `POST /buy` | New-key checkout (Stripe) | — |
| `POST /top-up?key={key}` | Returning-customer top-up (Stripe) | — |

Auth is the `x-api-key` header. Responses include `X-Credits-Remaining` and `X-Credits-Charged`. See [`agents.md`](https://spoken.md/agents.md) for the full error table and response shapes.

## Examples

- [`examples/podcast_summarizer.py`](./examples/podcast_summarizer.py) — fetch a transcript and summarize it
- [`examples/rag_pipeline.py`](./examples/rag_pipeline.py) — chunk a transcript for a vector store / RAG
- [`examples/quickstart.sh`](./examples/quickstart.sh) — search → transcript in two curl calls
- [`examples/archive-show.sh`](./examples/archive-show.sh) — archive a show's entire back catalogue, one file per episode

## Use from Python

The [`spoken-md`](./python) package wraps the API with no dependencies outside the standard library, and installs a `spoken-md` command.

```sh
pip install spoken-md
```

```python
from spoken_md import Spoken

spoken = Spoken()                                  # SPOKEN_API_KEY, or the demo key
episode = spoken.search("huberman sleep")[0]
print(spoken.transcript(episode.id))               # Markdown with real speaker names
```

`archive(podcast_id, skip=...)` walks a whole show and is resumable; errors are typed by status (`PaymentRequired` carries the top-up URL, `NotFound` means no transcript). See [python/README.md](./python/README.md).

## Use as an MCP server

This repo includes **`spoken-mcp`**, a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Spoken to MCP-compatible agents (Claude Desktop, Cursor, Cline, …). It provides eight tools:

| Tool | Description |
| --- | --- |
| `search_podcasts` | Find episodes by text or a pasted Spotify/YouTube URL |
| `list_episodes` | List a show's entire back-catalog from a `podcast_id` |
| `get_transcript` | Fetch an episode's transcript as Markdown with real speaker names |
| `get_balance` | Check remaining credits |
| `list_following` | The shows this key is kept current on, inferred from fetches or declared |
| `follow_podcast` | Declare a follow for a show (or clear a mute) |
| `unfollow_podcast` | Mute a show so it leaves the list and fetches do not re-add it |
| `list_new_episodes` | New episodes on followed shows that have not been fetched yet, with transcript links |

Keeping a knowledge base current is `list_new_episodes` on a schedule and `get_transcript` on what it lists: each fetch raises that show's floor.

Add it to your MCP client config (e.g. Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "spoken": {
      "command": "npx",
      "args": ["-y", "spoken-mcp"],
      "env": { "SPOKEN_API_KEY": "pt_your_key" }
    }
  }
}
```

`SPOKEN_API_KEY` defaults to `pt_demo` (search works fully; transcripts limited to the demo episode). Get a real key at [spoken.md](https://spoken.md).

Run from source instead:

```sh
npm install && npm run build
SPOKEN_API_KEY=pt_your_key node dist/index.js
```

## Use with AI agents

Spoken is designed to be called by agents. Point your agent at the [Agent Skill](./SKILL.md) (also served at `https://spoken.md/.well-known/skills/spoken-md/SKILL.md`), or hand it [`agents.md`](https://spoken.md/agents.md). The [OpenAPI spec](https://spoken.md/.well-known/openapi.json) makes it easy to wrap as a tool for any function-calling or MCP-compatible client (Claude, GPT, Cursor).

## Pricing

Pay-per-use credits, no subscription. New keys: 100 for $15, 500 for $50, 2,000 for $160. Machine-readable at [spoken.md/pricing.md](https://spoken.md/pricing.md).

## Links

- Website & docs: **https://spoken.md**
- Agent instructions: https://spoken.md/agents.md
- OpenAPI spec: https://spoken.md/.well-known/openapi.json
- LLM-friendly overview: https://spoken.md/llms.txt

---

Spoken is built and maintained at [spoken.md](https://spoken.md).
