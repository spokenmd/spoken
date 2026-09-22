"""Summarize a podcast episode with Spoken + an LLM.

Spoken returns a clean Markdown transcript with real speaker names, so the
transcript is ready to drop straight into a model prompt — no diarization
cleanup needed.

Usage:
    export SPOKEN_API_KEY=pt_...        # get one at https://spoken.md
    export ANTHROPIC_API_KEY=sk-ant-... # or swap in any LLM you like
    python podcast_summarizer.py "huberman sleep"

Docs: https://spoken.md/agents.md
"""

import os
import sys

import requests
from anthropic import Anthropic  # pip install anthropic  (swap for any LLM)

SPOKEN_API_KEY = os.environ.get("SPOKEN_API_KEY", "pt_demo")
SPOKEN_BASE = "https://spoken.md"


def find_episode(query: str) -> dict:
    """Search by text or a pasted Spotify/YouTube URL; return the top match."""
    resp = requests.get(
        f"{SPOKEN_BASE}/search",
        params={"q": query},
        headers={"x-api-key": SPOKEN_API_KEY},
        timeout=30,
    )
    resp.raise_for_status()
    results = resp.json()["results"]
    if not results:
        sys.exit(f"No episodes found for {query!r}")
    return results[0]


def fetch_transcript(episode_id: str) -> str:
    """Fetch the Markdown transcript. Costs 1 credit on first fetch, 0 on repeat."""
    resp = requests.get(
        f"{SPOKEN_BASE}/transcripts/{episode_id}",
        headers={"x-api-key": SPOKEN_API_KEY},
        timeout=60,
    )
    resp.raise_for_status()
    print(f"Credits remaining: {resp.headers.get('X-Credits-Remaining', '?')}")
    return resp.text


def summarize(transcript_markdown: str, title: str) -> str:
    client = Anthropic()
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": (
                f"Summarize this podcast episode ({title}) in 5 bullet points, "
                f"attributing key claims to the named speaker:\n\n{transcript_markdown}"
            ),
        }],
    )
    return message.content[0].text


if __name__ == "__main__":
    query = sys.argv[1] if len(sys.argv) > 1 else "huberman sleep"
    episode = find_episode(query)
    print(f"Found: {episode['title']} — {episode['podcast']} ({episode['date']})")
    transcript = fetch_transcript(episode["id"])
    print("\n--- Summary ---\n")
    print(summarize(transcript, episode["title"]))
