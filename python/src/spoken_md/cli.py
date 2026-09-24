"""`spoken-md`: the API from a terminal.

    spoken-md search "huberman sleep"
    spoken-md episodes 1469759170
    spoken-md transcript 1000651996090 > episode.md
    spoken-md archive 1469759170 -o my-first-million/
    spoken-md balance
    spoken-md following
    spoken-md follow 1469759170
    spoken-md unfollow 1469759170
    spoken-md new

The key comes from `--key`, then `SPOKEN_API_KEY`, then the demo key.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

from . import __version__
from .client import DEFAULT_BASE_URL, PaymentRequired, Spoken, SpokenError


def main(argv: Optional[List[str]] = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 2
    spoken = Spoken(args.key, base_url=args.base_url)
    try:
        return args.run(spoken, args)
    except PaymentRequired as error:
        top_up = f" Top up: POST {error.top_up_url}" if error.top_up_url else ""
        print(f"spoken-md: {error.message}{top_up}", file=sys.stderr)
        return 3
    except SpokenError as error:
        print(f"spoken-md: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spoken-md",
        description="Podcast transcripts as Markdown with real speaker names. https://spoken.md",
    )
    parser.add_argument("--key", help="API key (default: $SPOKEN_API_KEY, then the demo key pt_demo)")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=argparse.SUPPRESS)
    parser.add_argument("--version", action="version", version=f"spoken-md {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="command")

    search = sub.add_parser("search", help="find episodes by text, or paste an episode URL")
    search.add_argument("query")
    search.add_argument("--json", action="store_true", help="print the results as JSON")
    search.set_defaults(run=_search)

    episodes = sub.add_parser("episodes", help="list every fetchable episode of a show (free)")
    episodes.add_argument("podcast_id")
    episodes.add_argument("--json", action="store_true", help="print the list as JSON")
    episodes.set_defaults(run=_episodes)

    transcript = sub.add_parser("transcript", help="fetch one transcript as Markdown (1 credit, repeats free)")
    transcript.add_argument("episode_id")
    transcript.add_argument("-o", "--output", type=Path, help="write to this file instead of stdout")
    transcript.set_defaults(run=_transcript)

    archive = sub.add_parser("archive", help="fetch a whole show, one .md file per episode, resumable")
    archive.add_argument("podcast_id")
    archive.add_argument("-o", "--output", type=Path, default=Path("."), help="directory for the files (default: .)")
    archive.set_defaults(run=_archive)

    balance = sub.add_parser("balance", help="credits and recent usage for this key (free)")
    balance.set_defaults(run=_balance)

    following = sub.add_parser("following", help="the shows this key is kept current on (free)")
    following.add_argument("--json", action="store_true", help="print the list as JSON")
    following.set_defaults(run=_following)

    follow = sub.add_parser("follow", help="declare a follow for a show, or clear a mute (free)")
    follow.add_argument("podcast_id")
    follow.set_defaults(run=_follow)

    unfollow = sub.add_parser("unfollow", help="mute a show so it leaves the list (free)")
    unfollow.add_argument("podcast_id")
    unfollow.set_defaults(run=_unfollow)

    new = sub.add_parser("new", help="unfetched episodes on the shows you follow (free)")
    new.add_argument("--json", action="store_true", help="print the list as JSON")
    new.set_defaults(run=_new)
    return parser


def _search(spoken: Spoken, args: argparse.Namespace) -> int:
    results = spoken.search(args.query)
    if args.json:
        print(json.dumps([r.__dict__ for r in results], indent=2))
        return 0
    if not results:
        print("no episodes with a transcript match that query", file=sys.stderr)
        return 1
    for r in results:
        print(f"{r.id}\t{r.date[:10]}\t{r.podcast}\t{r.title}\t(show {r.podcast_id})")
    return 0


def _episodes(spoken: Spoken, args: argparse.Namespace) -> int:
    show = spoken.episodes(args.podcast_id)
    if args.json:
        print(json.dumps({"podcast": show.podcast, "podcast_id": show.podcast_id, "count": show.count,
                          "episodes": [e.__dict__ for e in show.episodes]}, indent=2))
        return 0
    print(f"{show.podcast}: {show.count} episodes with a transcript", file=sys.stderr)
    for e in show.episodes:
        print(f"{e.id}\t{e.date[:10]}\t{e.title}")
    return 0


def _transcript(spoken: Spoken, args: argparse.Namespace) -> int:
    transcript = spoken.transcript(args.episode_id)
    if args.output:
        args.output.write_text(transcript.markdown, encoding="utf-8")
        print(f"wrote {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(transcript.markdown)
        if not transcript.markdown.endswith("\n"):
            sys.stdout.write("\n")
    if transcript.credits_remaining is not None:
        charged = "1 credit" if transcript.credits_charged == 1 else "no credit"
        print(f"{charged} charged, {transcript.credits_remaining} remaining", file=sys.stderr)
    return 0


def _archive(spoken: Spoken, args: argparse.Namespace) -> int:
    out: Path = args.output
    out.mkdir(parents=True, exist_ok=True)
    done = {p.stem for p in out.glob("*.md")}
    show = spoken.episodes(args.podcast_id)
    todo = [e for e in show.episodes if e.id not in done]
    print(f"{show.podcast}: {len(show.episodes)} episodes, {len(done)} already in {out}, {len(todo)} to fetch",
          file=sys.stderr)
    fetched = missing = 0
    for item in spoken.archive(args.podcast_id, skip=done):
        if item.transcript is None:
            missing += 1
            print(f"  skip  {item.episode.id}  no transcript: {item.episode.title}", file=sys.stderr)
            continue
        (out / f"{item.episode.id}.md").write_text(item.transcript.markdown, encoding="utf-8")
        fetched += 1
        remaining = item.transcript.credits_remaining
        tail = f"  ({remaining} credits left)" if remaining is not None else ""
        print(f"  saved {item.episode.id}  {item.episode.title}{tail}", file=sys.stderr)
    print(f"done: {fetched} fetched, {missing} without a transcript, {len(done)} were already there", file=sys.stderr)
    return 0


def _balance(spoken: Spoken, args: argparse.Namespace) -> int:
    balance = spoken.balance()
    print(json.dumps(balance.raw, indent=2))
    return 0


def _following(spoken: Spoken, args: argparse.Namespace) -> int:
    following = spoken.following()
    if args.json:
        print(json.dumps({"following": [f.__dict__ for f in following], "muted": following.muted, "limits": following.limits}, indent=2))
        return 0
    if not following.following:
        print("following no shows yet; fetch a transcript, or `spoken-md follow <podcast_id>`", file=sys.stderr)
        return 1
    for f in following:
        print(f"{f.podcast_id}\t{f.source}\t{f.fetch_count}\t{f.podcast}")
    for m in following.muted:
        print(f"{m.get('podcast_id', '')}\tmuted\t-\t{m.get('podcast', '')}")
    return 0


def _follow(spoken: Spoken, args: argparse.Namespace) -> int:
    f = spoken.follow(args.podcast_id)
    print(f"following {f.podcast} ({f.podcast_id})", file=sys.stderr)
    return 0


def _unfollow(spoken: Spoken, args: argparse.Namespace) -> int:
    spoken.unfollow(args.podcast_id)
    print(f"muted {args.podcast_id}", file=sys.stderr)
    return 0


def _new(spoken: Spoken, args: argparse.Namespace) -> int:
    new = spoken.new()
    if args.json:
        print(json.dumps({"as_of": new.as_of, "count": new.count, "shows": [
            {**s.__dict__, "episodes": [e.__dict__ for e in s.episodes]} for s in new.shows
        ]}, indent=2))
        return 0
    for show in new.shows:
        for e in show.episodes:
            print(f"{e.id}\t{e.date[:10]}\t{show.podcast}\t{e.title}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
