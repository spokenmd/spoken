"""The Spoken API over urllib. No third-party dependencies.

Every method maps to one route in https://spoken.md/agents.md. Errors are typed by status so a
caller can tell "top up" (402) from "this episode has no transcript" (404) from "retry" (429, 502)
without reading a body.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Set

DEFAULT_BASE_URL = "https://spoken.md"
DEMO_KEY = "pt_demo"
_VERSION = "0.1.0"


# --- Errors ---------------------------------------------------------------------------------


class SpokenError(Exception):
    """Any non-2xx response. `status` is the HTTP status; `code` and `message` come from the JSON
    body when there is one (401, 402, 404, 502 carry `{"error": {"code", "message", ...}}`)."""

    status: int = 0

    def __init__(self, status: int, body: Any = None, message: Optional[str] = None):
        self.status = status
        self.body = body
        error = body.get("error") if isinstance(body, dict) else None
        self.code: Optional[str] = error.get("code") if isinstance(error, dict) else None
        self.message: str = message or (error.get("message") if isinstance(error, dict) else None) or f"HTTP {status}"
        super().__init__(f"{status} {self.message}")

    def _field(self, name: str) -> Optional[str]:
        error = self.body.get("error") if isinstance(self.body, dict) else None
        value = error.get(name) if isinstance(error, dict) else None
        return value if isinstance(value, str) else None


class AuthError(SpokenError):
    """401: missing or invalid key. `purchase_url` is where a key comes from."""

    @property
    def demo_key(self) -> Optional[str]:
        return self._field("demo_key")

    @property
    def purchase_url(self) -> Optional[str]:
        return self._field("purchase_url")


class PaymentRequired(SpokenError):
    """402: no credits left. POST to `top_up_url` (it redirects to Stripe Checkout)."""

    @property
    def top_up_url(self) -> Optional[str]:
        return self._field("top_up_url")


class NotFound(SpokenError):
    """404: the episode or show does not exist, or the episode has no published transcript.
    Retrying does not help; nothing was charged."""


class Throttled(SpokenError):
    """429: the service is throttled under load. Back off and retry. Nothing was charged."""


class UpstreamError(SpokenError):
    """502: upstream failure. Safe to retry. Nothing was charged."""


_ERRORS = {401: AuthError, 402: PaymentRequired, 404: NotFound, 429: Throttled, 502: UpstreamError}
_RETRYABLE = (429, 502)


# --- Response types -------------------------------------------------------------------------


@dataclass(frozen=True)
class Episode:
    """One `/search` result."""

    id: str
    title: str
    podcast: str
    podcast_id: str
    date: str

    @classmethod
    def _from(cls, d: Dict[str, Any]) -> "Episode":
        return cls(
            id=str(d.get("id", "")),
            title=str(d.get("title", "")),
            podcast=str(d.get("podcast", "")),
            podcast_id=str(d.get("podcastId", "")),
            date=str(d.get("date", "")),
        )


@dataclass(frozen=True)
class EpisodeRef:
    """One entry of a show's episode list."""

    id: str
    title: str
    date: str

    @classmethod
    def _from(cls, d: Dict[str, Any]) -> "EpisodeRef":
        return cls(id=str(d.get("id", "")), title=str(d.get("title", "")), date=str(d.get("date", "")))


@dataclass(frozen=True)
class Show:
    """A show's full episode list, from `/podcasts/{podcastId}/episodes`. Every id in it is
    fetchable: episodes with no transcript are already left out."""

    podcast: str
    podcast_id: str
    count: int
    episodes: List[EpisodeRef]

    def __iter__(self) -> Iterator[EpisodeRef]:
        return iter(self.episodes)

    def __len__(self) -> int:
        return len(self.episodes)


@dataclass(frozen=True)
class Transcript:
    """A transcript and the credit headers that came with it. `str(transcript)` is the Markdown."""

    episode_id: str
    markdown: str
    credits_remaining: Optional[int]
    credits_charged: Optional[int]
    top_up_url: Optional[str] = None

    def __str__(self) -> str:
        return self.markdown


@dataclass(frozen=True)
class Balance:
    """`/balance`: credits, the Stripe email if one is attached, top-up links and recent usage.
    `raw` is the whole response for fields this client does not name."""

    credits: int
    email: Optional[str]
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def usage(self) -> Dict[str, Any]:
        usage = self.raw.get("usage")
        return usage if isinstance(usage, dict) else {}

    @property
    def top_up(self) -> Dict[str, Any]:
        top_up = self.raw.get("top_up")
        return top_up if isinstance(top_up, dict) else {}


@dataclass(frozen=True)
class ArchiveItem:
    """One step of `Spoken.archive`: the episode and its transcript, or `None` when the fetch
    returned 404 (listed, but no transcript today)."""

    episode: EpisodeRef
    transcript: Optional[Transcript]


# --- Client ---------------------------------------------------------------------------------


class Spoken:
    """Client for https://spoken.md.

    Args:
        api_key: A `pt_…` key. Defaults to `SPOKEN_API_KEY` from the environment, then to the
            demo key, which searches and lists any show but fetches only the demo episode.
        base_url: Override for tests or a proxy.
        timeout: Seconds per request. A transcript is fetched and named on first request, so the
            default is generous.
        retries: How many times 429 and 502 are retried, with backoff. Nothing else is retried.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        retries: int = 2,
        user_agent: Optional[str] = None,
    ):
        self.api_key = api_key or os.environ.get("SPOKEN_API_KEY") or DEMO_KEY
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.user_agent = user_agent or f"spoken-md/{_VERSION} (python urllib)"

    # -- routes --

    def search(self, query: str) -> List[Episode]:
        """`GET /search?q=`: free text, or a pasted episode URL from Spotify, YouTube or any
        podcast app. Never charged. Every result is fetchable."""
        data, _ = self._get_json("/search", {"q": query})
        results = data.get("results") if isinstance(data, dict) else None
        return [Episode._from(r) for r in results or [] if isinstance(r, dict)]

    def episodes(self, podcast_id: str) -> Show:
        """`GET /podcasts/{podcastId}/episodes`: a show's whole back catalogue. Never charged."""
        data, _ = self._get_json(f"/podcasts/{urllib.parse.quote(str(podcast_id))}/episodes")
        episodes = data.get("episodes") if isinstance(data, dict) else None
        refs = [EpisodeRef._from(e) for e in episodes or [] if isinstance(e, dict)]
        return Show(
            podcast=str(data.get("podcast", "")),
            podcast_id=str(data.get("podcast_id", podcast_id)),
            count=int(data.get("count", len(refs)) or 0),
            episodes=refs,
        )

    def transcript(self, episode_id: str) -> Transcript:
        """`GET /transcripts/{id}`: the Markdown transcript. One credit on first fetch, none on a
        repeat fetch, none on any error."""
        body, headers = self._request(f"/transcripts/{urllib.parse.quote(str(episode_id))}", accept="text/markdown")
        return Transcript(
            episode_id=str(episode_id),
            markdown=body,
            credits_remaining=_int_header(headers, "X-Credits-Remaining"),
            credits_charged=_int_header(headers, "X-Credits-Charged"),
            top_up_url=headers.get("X-Top-Up-Url") or None,
        )

    def balance(self) -> Balance:
        """`GET /balance`: credits and usage for this key. Free. The demo key gets a 401."""
        data, _ = self._get_json("/balance")
        raw = data if isinstance(data, dict) else {}
        email = raw.get("email")
        return Balance(credits=int(raw.get("credits", 0) or 0), email=email if isinstance(email, str) else None, raw=raw)

    def archive(
        self,
        podcast_id: str,
        *,
        skip: Optional[Iterable[str]] = None,
        pace: float = 0.34,
        on_error: Optional[Callable[[EpisodeRef, SpokenError], None]] = None,
    ) -> Iterator[ArchiveItem]:
        """Every transcript of a show, one at a time, oldest listing order preserved.

        Resumable: pass the ids you already hold as `skip` and they are not fetched. A 404 yields
        the episode with `transcript=None`; `on_error` sees it first if given. A 402 is raised,
        because the right response is to top up and run again with the same `skip`. `pace` is the
        sleep between fetches, about three requests a second by default.

            done = {p.stem for p in Path("show").glob("*.md")}
            for item in spoken.archive(show.podcast_id, skip=done):
                if item.transcript:
                    Path("show", f"{item.episode.id}.md").write_text(item.transcript.markdown)
        """
        skipped: Set[str] = set(skip or ())
        show = self.episodes(podcast_id)
        first = True
        for episode in show.episodes:
            if episode.id in skipped:
                continue
            if not first and pace > 0:
                time.sleep(pace)
            first = False
            try:
                yield ArchiveItem(episode, self.transcript(episode.id))
            except NotFound as error:
                if on_error:
                    on_error(episode, error)
                yield ArchiveItem(episode, None)

    # -- transport --

    def _get_json(self, path: str, params: Optional[Dict[str, str]] = None) -> "tuple[Any, Dict[str, str]]":
        body, headers = self._request(path, params=params, accept="application/json")
        try:
            return json.loads(body), headers
        except ValueError:
            raise SpokenError(200, message=f"Expected JSON from {path}, got: {body[:80]!r}")

    def _request(
        self,
        path: str,
        *,
        params: Optional[Dict[str, str]] = None,
        accept: str = "*/*",
    ) -> "tuple[str, Dict[str, str]]":
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"x-api-key": self.api_key, "Accept": accept, "User-Agent": self.user_agent}
        attempt = 0
        while True:
            request = urllib.request.Request(url, headers=headers, method="GET")
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return _decode(response.read()), _headers(response.headers)
            except urllib.error.HTTPError as http_error:
                status = http_error.code
                raw = http_error.read()
                if status in _RETRYABLE and attempt < self.retries:
                    attempt += 1
                    time.sleep(min(2.0 ** attempt, 8.0))
                    continue
                raise _typed_error(status, raw) from None
            except urllib.error.URLError as url_error:
                if attempt < self.retries:
                    attempt += 1
                    time.sleep(min(2.0 ** attempt, 8.0))
                    continue
                raise SpokenError(0, message=f"Could not reach {self.base_url}: {url_error.reason}") from None


def _typed_error(status: int, raw: bytes) -> SpokenError:
    text = _decode(raw)
    body: Any
    try:
        body = json.loads(text) if text else None
    except ValueError:
        body = text or None
    cls = _ERRORS.get(status, SpokenError)
    return cls(status, body)


def _decode(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace")


def _headers(message: Any) -> Dict[str, str]:
    # http.client headers are case-insensitive on read but not on iteration; normalise the names
    # the client looks at so callers get one spelling.
    out: Dict[str, str] = {}
    for key, value in message.items():
        out[_canonical(key)] = value
    return out


def _canonical(name: str) -> str:
    return "-".join(part[:1].upper() + part[1:].lower() for part in name.split("-"))


def _int_header(headers: Dict[str, str], name: str) -> Optional[int]:
    value = headers.get(name)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None
