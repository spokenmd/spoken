"""The client against a fake Spoken on localhost: one handler per route, the real error shapes."""

from __future__ import annotations

import io
import json
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlparse

from spoken_md import (
    AuthError,
    NotFound,
    PaymentRequired,
    Spoken,
    SpokenError,
    Throttled,
    UpstreamError,
)
from spoken_md.cli import main

DEMO = "1000651996090"
SHOW = "1469759170"
EPISODES = [
    {"id": "1", "title": "One", "date": "2026-01-01T00:00:00Z"},
    {"id": "2", "title": "Two", "date": "2026-01-08T00:00:00Z"},
    {"id": "3", "title": "Three", "date": "2026-01-15T00:00:00Z"},
]


class FakeSpoken(BaseHTTPRequestHandler):
    """Keys: pt_demo fetches only DEMO; pt_rich has credits; pt_broke has none. Episode 3 never has
    a transcript. Episode 'flaky' 502s once, then serves."""

    flaky_calls = 0
    throttle_calls = 0
    seen_headers: list = []

    def do_GET(self):  # noqa: N802
        FakeSpoken.seen_headers.append({k.lower(): v for k, v in self.headers.items()})
        url = urlparse(self.path)
        key = self.headers.get("x-api-key", "")
        if not key.startswith("pt_"):
            return self._json(401, {"error": {"code": "unauthorized", "message": "Missing API key",
                                              "demo_key": "pt_demo", "purchase_url": "https://spoken.md/#pricing"}})
        if url.path == "/search":
            q = parse_qs(url.query).get("q", [""])[0]
            results = [] if q == "nothing" else [
                {"id": DEMO, "title": "Sleep", "podcast": "Huberman Lab", "podcastId": SHOW, "date": "2026-02-01T00:00:00Z"}
            ]
            return self._json(200, {"results": results})
        if url.path == f"/podcasts/{SHOW}/episodes":
            return self._json(200, {"podcast": "A Show", "podcast_id": SHOW, "count": 3, "episodes": EPISODES})
        if url.path.startswith("/podcasts/"):
            return self._json(404, {"error": {"code": "not_found", "message": "No podcast found"}})
        if url.path == "/balance":
            if key == "pt_demo":
                return self._json(401, {"error": {"code": "unauthorized", "message": "Demo key has no balance"}})
            return self._json(200, {"credits": 42, "email": "a@b.c", "top_up": {"url": "https://spoken.md/top-up?key=" + key},
                                    "usage": {"total": 7, "recent": []}})
        if url.path == "/following":
            if key == "pt_demo":
                return self._json(401, {"error": {"code": "unauthorized", "message": "Invalid API key."}})
            return self._json(200, {
                "following": [{"podcast_id": SHOW, "podcast": "A Show", "source": "fetch", "fetch_count": 3,
                               "last_fetched_at": "2026-09-20T00:00:00Z", "newest_fetched_id": "2"}],
                "muted": [{"podcast_id": "999", "podcast": "Muted Show"}],
                "limits": {"explicit": 25, "inferred": 5, "inferred_window_days": 180},
            })
        if url.path == "/new":
            return self._json(200, {"as_of": "2026-09-24T12:00:00Z", "count": 1, "shows": [
                {"podcast_id": SHOW, "podcast": "A Show", "source": "fetch", "episodes": [
                    {"id": "3", "title": "Three", "date": "2026-01-15T00:00:00Z", "transcript_url": "https://spoken.md/transcripts/3"}]},
                {"podcast_id": "555", "podcast": "Quiet Show", "source": "explicit", "episodes": []},
            ]})
        if url.path.startswith("/transcripts/"):
            episode_id = url.path.rsplit("/", 1)[1]
            if episode_id == "flaky":
                FakeSpoken.flaky_calls += 1
                if FakeSpoken.flaky_calls == 1:
                    return self._json(502, {"error": {"code": "upstream_error", "message": "Upstream failed"}})
                return self._markdown("**A** (0:00)\nHi.", remaining=41, charged=1)
            if episode_id == "throttled":
                FakeSpoken.throttle_calls += 1
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"message":"Too Many Requests"}')
                return
            if episode_id == "3":
                return self._json(404, {"error": {"code": "not_found", "message": "No transcript for this episode"}})
            if key == "pt_demo" and episode_id != DEMO:
                # What the live API does: the demo key on any other episode is a 402, not a 401.
                return self._json(402, {"error": {"code": "payment_required", "message": "Demo key only works with the demo episode",
                                                  "top_up_url": "https://spoken.md/#pricing"}})
            if key == "pt_broke":
                return self._json(402, {"error": {"code": "payment_required", "message": "No credits",
                                                  "top_up_url": "https://spoken.md/top-up?key=pt_broke"}})
            return self._markdown(f"**Host** (0:00)\nEpisode {episode_id}.\n", remaining=41, charged=1)
        self._json(404, {"error": {"code": "not_found", "message": "No such route"}})

    def do_PUT(self):  # noqa: N802
        FakeSpoken.seen_headers.append({k.lower(): v for k, v in self.headers.items()})
        podcast_id = self.path.rsplit("/", 1)[1]
        if podcast_id == "nope":
            return self._json(404, {"error": {"code": "not_found", "message": "No podcast found for that id."}})
        if podcast_id == "full":
            return self._json(409, {"error": {"code": "follow_limit", "message": "You can follow up to 25 shows.", "limit": 25}})
        return self._json(200, {"podcast_id": podcast_id, "podcast": "A Show", "state": "following", "source": "explicit"})

    def do_DELETE(self):  # noqa: N802
        podcast_id = self.path.rsplit("/", 1)[1]
        if podcast_id == "nope":
            return self._json(404, {"error": {"code": "not_following", "message": "You are not following that show."}})
        return self._json(200, {"podcast_id": podcast_id, "podcast": "A Show", "state": "muted"})

    def _json(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _markdown(self, text, *, remaining, charged):
        raw = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/markdown; charset=utf-8")
        self.send_header("x-credits-remaining", str(remaining))
        self.send_header("X-CREDITS-CHARGED", str(charged))
        if remaining <= 10:
            self.send_header("X-Top-Up-Url", "https://spoken.md/top-up?key=x")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):  # quiet
        pass


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeSpoken)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def client(self, key="pt_rich", **kw):
        kw.setdefault("retries", 2)
        return Spoken(key, base_url=self.base, **kw)

    def test_search_returns_typed_results(self):
        results = self.client("pt_demo").search("huberman sleep")
        self.assertEqual(results[0].id, DEMO)
        self.assertEqual(results[0].podcast_id, SHOW)
        self.assertEqual(self.client("pt_demo").search("nothing"), [])

    def test_episodes_is_iterable_and_sized(self):
        show = self.client("pt_demo").episodes(SHOW)
        self.assertEqual((show.podcast, show.count, len(show)), ("A Show", 3, 3))
        self.assertEqual([e.id for e in show], ["1", "2", "3"])

    def test_transcript_parses_credit_headers_whatever_their_case(self):
        t = self.client().transcript("1")
        self.assertEqual(str(t), "**Host** (0:00)\nEpisode 1.\n")
        self.assertEqual((t.credits_remaining, t.credits_charged, t.top_up_url), (41, 1, None))

    def test_key_header_and_user_agent_are_sent(self):
        FakeSpoken.seen_headers.clear()
        self.client("pt_rich").search("x")
        sent = FakeSpoken.seen_headers[-1]
        self.assertEqual(sent["x-api-key"], "pt_rich")
        self.assertTrue(sent["user-agent"].startswith("spoken-md/"))

    def test_errors_are_typed_by_status(self):
        with self.assertRaises(AuthError) as ctx:
            self.client("nope").search("x")
        self.assertEqual(ctx.exception.purchase_url, "https://spoken.md/#pricing")
        self.assertEqual(ctx.exception.demo_key, "pt_demo")
        with self.assertRaises(PaymentRequired) as ctx2:
            self.client("pt_broke").transcript("1")
        self.assertEqual(ctx2.exception.top_up_url, "https://spoken.md/top-up?key=pt_broke")
        self.assertEqual(ctx2.exception.code, "payment_required")
        with self.assertRaises(NotFound):
            self.client().transcript("3")
        with self.assertRaises(NotFound):
            self.client().episodes("0")
        self.assertTrue(issubclass(NotFound, SpokenError))

    def test_502_is_retried_then_served(self):
        FakeSpoken.flaky_calls = 0
        t = self.client().transcript("flaky")
        self.assertEqual(FakeSpoken.flaky_calls, 2)
        self.assertEqual(t.credits_charged, 1)

    def test_502_without_retries_raises_upstream_error(self):
        FakeSpoken.flaky_calls = 0
        with self.assertRaises(UpstreamError):
            self.client(retries=0).transcript("flaky")

    def test_429_raw_body_becomes_throttled(self):
        FakeSpoken.throttle_calls = 0
        with self.assertRaises(Throttled) as ctx:
            self.client(retries=1).transcript("throttled")
        self.assertEqual(FakeSpoken.throttle_calls, 2)
        self.assertIsNone(ctx.exception.code)  # 429 carries no error shape

    def test_balance(self):
        b = self.client().balance()
        self.assertEqual((b.credits, b.email, b.usage["total"]), (42, "a@b.c", 7))
        with self.assertRaises(AuthError):
            self.client("pt_demo").balance()

    def test_following_is_typed_and_iterable(self):
        f = self.client().following()
        self.assertEqual(len(f), 1)
        self.assertEqual([x.podcast_id for x in f], [SHOW])
        self.assertEqual(f.following[0].newest_fetched_id, "2")
        self.assertEqual(f.muted, [{"podcast_id": "999", "podcast": "Muted Show"}])
        self.assertEqual(f.limits["explicit"], 25)
        with self.assertRaises(AuthError):
            self.client("pt_demo").following()

    def test_follow_and_unfollow_use_put_and_delete(self):
        f = self.client().follow(SHOW)
        self.assertEqual((f.podcast_id, f.source), (SHOW, "explicit"))
        self.assertIsNone(self.client().unfollow(SHOW))
        with self.assertRaises(NotFound):
            self.client().follow("nope")
        with self.assertRaises(NotFound):
            self.client().unfollow("nope")
        with self.assertRaises(SpokenError) as raised:
            self.client().follow("full")
        self.assertEqual(raised.exception.status, 409)

    def test_new_iterates_episodes_across_shows(self):
        new = self.client().new()
        self.assertEqual(len(new), 1)
        self.assertEqual([s.podcast for s in new.shows], ["A Show", "Quiet Show"])
        episodes = list(new)
        self.assertEqual(episodes[0].transcript_url, "https://spoken.md/transcripts/3")

    def test_archive_skips_held_ids_and_yields_none_on_404(self):
        seen = []
        items = list(self.client().archive(SHOW, skip={"1"}, pace=0, on_error=lambda e, err: seen.append(e.id)))
        self.assertEqual([(i.episode.id, i.transcript is not None) for i in items], [("2", True), ("3", False)])
        self.assertEqual(seen, ["3"])

    def test_archive_raises_on_402_so_the_caller_can_top_up(self):
        with self.assertRaises(PaymentRequired):
            list(self.client("pt_broke").archive(SHOW, pace=0))

    def test_demo_key_is_the_default(self):
        import os
        old = os.environ.pop("SPOKEN_API_KEY", None)
        try:
            self.assertEqual(Spoken(base_url=self.base).api_key, "pt_demo")
            os.environ["SPOKEN_API_KEY"] = "pt_env"
            self.assertEqual(Spoken(base_url=self.base).api_key, "pt_env")
        finally:
            os.environ.pop("SPOKEN_API_KEY", None)
            if old:
                os.environ["SPOKEN_API_KEY"] = old


class CliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeSpoken)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def run_cli(self, *args, key="pt_rich"):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(["--key", key, "--base-url", self.base, *args])
        return code, out.getvalue(), err.getvalue()

    def test_search_and_episodes_print_tab_separated_lines(self):
        code, out, _ = self.run_cli("search", "huberman sleep", key="pt_demo")
        self.assertEqual(code, 0)
        self.assertIn(f"{DEMO}\t2026-02-01\tHuberman Lab\tSleep", out)
        code, out, err = self.run_cli("episodes", SHOW)
        self.assertEqual(code, 0)
        self.assertEqual(out.count("\n"), 3)
        self.assertIn("A Show: 3 episodes", err)

    def test_transcript_to_stdout_and_to_file(self):
        code, out, err = self.run_cli("transcript", "1")
        self.assertEqual((code, out), (0, "**Host** (0:00)\nEpisode 1.\n"))
        self.assertIn("1 credit charged, 41 remaining", err)
        with TemporaryDirectory() as d:
            target = Path(d, "ep.md")
            code, out, _ = self.run_cli("transcript", "1", "-o", str(target))
            self.assertEqual((code, out), (0, ""))
            self.assertTrue(target.read_text().startswith("**Host**"))

    def test_archive_writes_files_and_is_resumable(self):
        with TemporaryDirectory() as d:
            Path(d, "1.md").write_text("already here")
            code, _, err = self.run_cli("archive", SHOW, "-o", d)
            self.assertEqual(code, 0)
            self.assertEqual(sorted(p.name for p in Path(d).glob("*.md")), ["1.md", "2.md"])
            self.assertEqual(Path(d, "1.md").read_text(), "already here")
            self.assertIn("1 fetched, 1 without a transcript, 1 were already there", err)

    def test_exit_codes_for_auth_and_credits(self):
        code, _, err = self.run_cli("balance", key="pt_demo")
        self.assertEqual(code, 1)
        self.assertIn("401", err)
        code, _, err = self.run_cli("transcript", "1", key="pt_broke")
        self.assertEqual(code, 3)
        self.assertIn("POST https://spoken.md/top-up?key=pt_broke", err)

    def test_following_and_new_print_tab_separated_lines(self):
        code, out, _ = self.run_cli("following")
        self.assertEqual(code, 0)
        self.assertIn(f"{SHOW}\tfetch\t3\tA Show", out)
        self.assertIn("999\tmuted\t-\tMuted Show", out)
        code, out, _ = self.run_cli("new")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "3\t2026-01-15\tA Show\tThree")
        code, out, _ = self.run_cli("new", "--json")
        self.assertEqual(json.loads(out)["count"], 1)

    def test_follow_and_unfollow_report_on_stderr(self):
        code, out, err = self.run_cli("follow", SHOW)
        self.assertEqual((code, out), (0, ""))
        self.assertIn("following A Show", err)
        code, _, err = self.run_cli("unfollow", SHOW)
        self.assertEqual(code, 0)
        self.assertIn("muted", err)
        code, _, err = self.run_cli("follow", "nope")
        self.assertEqual(code, 1)
        self.assertIn("No podcast", err)

    def test_no_command_prints_help(self):
        code, out, _ = self.run_cli()
        self.assertEqual(code, 2)
        self.assertIn("usage: spoken-md", out)


if __name__ == "__main__":
    unittest.main()
