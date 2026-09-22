"""Spoken: podcast transcripts as Markdown with real speaker names.

    from spoken_md import Spoken

    spoken = Spoken()                      # reads SPOKEN_API_KEY, falls back to pt_demo
    episode = spoken.search("huberman sleep")[0]
    print(spoken.transcript(episode.id))

Docs: https://spoken.md/agents.md
"""

from .client import (
    DEFAULT_BASE_URL,
    DEMO_KEY,
    ArchiveItem,
    AuthError,
    Balance,
    Episode,
    EpisodeRef,
    NotFound,
    PaymentRequired,
    Show,
    Spoken,
    SpokenError,
    Throttled,
    Transcript,
    UpstreamError,
)

__version__ = "0.1.0"

__all__ = [
    "ArchiveItem",
    "AuthError",
    "Balance",
    "DEFAULT_BASE_URL",
    "DEMO_KEY",
    "Episode",
    "EpisodeRef",
    "NotFound",
    "PaymentRequired",
    "Show",
    "Spoken",
    "SpokenError",
    "Throttled",
    "Transcript",
    "UpstreamError",
    "__version__",
]
