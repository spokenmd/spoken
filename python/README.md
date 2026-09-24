# spoken-md

A podcast transcript API returns a podcast episode as text in one request, instead of as audio.
There are two kinds. A retrieval API hands back the transcript a show has already published, in
seconds and for cents. A transcription API generates one from the audio, in minutes and for
dollars, with speakers labelled "Speaker 0".

[Spoken](https://spoken.md) is the first kind. This package is its Python client: any published
podcast episode as Markdown with real speaker names and timestamps, one call, no dependencies
outside the standard library.

```sh
pip install spoken-md
```

```python
from spoken_md import Spoken

spoken = Spoken()                                  # SPOKEN_API_KEY from the environment, else the demo key
episode = spoken.search("huberman sleep")[0]       # search by text, or paste a Spotify or YouTube link
transcript = spoken.transcript(episode.id)         # Markdown, 1 credit the first time, free after that
print(transcript)
```

```md
**Andrew Huberman** (0:00)
Welcome to the Huberman Lab podcast, where we discuss science and
science-based tools for everyday life. Today my guest is Dr. Matt Walker...

**Matt Walker** (0:45)
Thank you for having me, Andrew.
```

The demo key `pt_demo` needs no signup. It searches and lists any show, and fetches the demo
episode. A key of your own comes from [spoken.md](https://spoken.md): 100 transcripts for $15,
credits never expire, errors are never charged.

## A whole show

Listing a show's episodes is free, and every id it returns has a transcript. `archive` walks the
list, skips what you already hold, and yields the episode with `transcript=None` for the rare
episode that has no transcript today.

```python
from pathlib import Path
from spoken_md import Spoken

spoken = Spoken("pt_your_key")
show = spoken.episodes(episode.podcast_id)          # podcast_id comes with every search result
out = Path(show.podcast)
out.mkdir(exist_ok=True)

done = {p.stem for p in out.glob("*.md")}            # re-running only fetches what is missing
for item in spoken.archive(show.podcast_id, skip=done):
    if item.transcript:
        (out / f"{item.episode.id}.md").write_text(item.transcript.markdown)
```

A 300-episode show is 300 credits. Re-running it later costs nothing for the episodes already on
disk, and a scheduled run picks up new episodes as they publish.

## From the terminal

The package installs a `spoken-md` command with the same verbs.

```sh
export SPOKEN_API_KEY=pt_your_key            # or --key, or leave it unset for the demo key

spoken-md search "acquired costco"           # id, date, show, title per line; --json for JSON
spoken-md episodes 1050462261                # every fetchable episode of a show, free
spoken-md transcript 1000625088063 > costco.md
spoken-md archive 1050462261 -o acquired/    # one .md per episode, resumable
spoken-md balance
spoken-md following                          # the shows this key is kept current on
spoken-md follow 1050462261                  # declare a follow, or clear a mute
spoken-md new                                # unfetched episodes on those shows: id, date, show, title
```

## Keeping a folder current

Every charged fetch makes its show a follow, and `new()` lists what those shows have published
that you have not fetched. A scheduled run of this is the whole job:

```python
inbox = Path("inbox")
for episode in spoken.new():                  # newest first, across every followed show
    (inbox / f"{episode.id}.md").write_text(spoken.transcript(episode.id).markdown)
```

Each fetch raises that show's floor, so the next run lists only what came after. Shows you
never fetched from can be declared with `spoken.follow(podcast_id)`; `spoken.unfollow()` mutes
one so later fetches do not re-add it.

## Errors

Every non-2xx response raises a typed error, so a loop can decide without reading a body.

| Error | Status | Meaning | Charged | Retry |
| --- | --- | --- | --- | --- |
| `AuthError` | 401 | Missing or invalid key. Carries `purchase_url` and `demo_key`. | No | No, fix the key |
| `PaymentRequired` | 402 | No credits left. Carries `top_up_url`; `POST` to it. | No | After topping up |
| `NotFound` | 404 | No such episode, or no published transcript for it. | No | No |
| `Throttled` | 429 | Throttled under load. | No | Yes |
| `UpstreamError` | 502 | Upstream failure. | No | Yes |

`Throttled` and `UpstreamError` are retried twice with backoff before they reach you; set
`Spoken(retries=0)` to see every one. All five subclass `SpokenError`.

```python
from spoken_md import NotFound, PaymentRequired, Spoken

spoken = Spoken("pt_your_key")
try:
    transcript = spoken.transcript("1000625088063")
except NotFound:
    ...                                              # this episode has no transcript
except PaymentRequired as e:
    print("top up:", e.top_up_url)
```

## What comes back

`transcript()` returns a `Transcript`: `.markdown`, `.credits_remaining`, `.credits_charged`
(1 on a first fetch, 0 on a repeat), and `.top_up_url` when the balance is low. `str()` on it is
the Markdown. `search()` returns `Episode` objects with `id`, `title`, `podcast`, `podcast_id`
and `date`. `episodes()` returns a `Show` you can iterate. `balance()` returns credits, the
attached email and recent usage. `following()` returns `Follow` objects (`podcast_id`, `podcast`,
`source`, `fetch_count`, `newest_fetched_id`) plus the muted shows and the limits; `new()` returns
a `WhatsNew` you can iterate for `NewEpisode` objects (`id`, `title`, `date`, `transcript_url`),
with `.shows` keeping them grouped.

## When Spoken is the wrong tool

Spoken returns the published transcript of a podcast episode and nothing else. For your own
audio, a meeting or an unpublished recording, use a speech-to-text API and add diarization. For
YouTube videos that are not distributed as podcasts, use a YouTube transcript tool. Word-level
timestamps and caption files are out of scope. The full list, with what to use instead, is in
[agents.md](https://spoken.md/agents.md).

## More

- [Agent instructions](https://spoken.md/agents.md), the routes and response shapes this client wraps
- [OpenAPI spec](https://spoken.md/.well-known/openapi.json)
- [MCP server](https://github.com/spokenmd/spoken) for Claude Desktop, Cursor and Cline: `npx spoken-mcp`
- [Pricing](https://spoken.md/pricing.md)

MIT licensed. Issues and pull requests: [github.com/spokenmd/spoken](https://github.com/spokenmd/spoken).
