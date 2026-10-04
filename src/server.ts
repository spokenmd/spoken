/**
 * The Spoken MCP server, as a factory.
 *
 * `createSpokenServer` builds a server exposing the Spoken podcast-transcript
 * API (https://spoken.md) for one API key. The stdio entry point (`index.ts`)
 * builds one from the environment; an HTTP host builds one per request, for
 * that request's key.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

export const VERSION = "0.4.0";

export interface SpokenServerOptions {
  /** A Spoken API key (`pt_...`). Omitted: the free `pt_demo` key, which searches fully but only fetches the demo episode. */
  apiKey?: string;
  /** API origin. Defaults to https://spoken.md. */
  baseUrl?: string;
  /** How this host's user gets and supplies a key; closes the missing-key error messages. Defaults to pointing at https://spoken.md. */
  keyHelp?: string;
}

interface SearchResult {
  id: string;
  title: string;
  podcast: string;
  podcastId: string;
  date: string;
}

interface SearchResponse {
  results: SearchResult[];
}

interface EpisodeRef {
  id: string;
  title: string;
  date: string;
}

interface EpisodesResponse {
  podcast: string;
  podcast_id: string;
  count: number;
  episodes: EpisodeRef[];
}

type FollowSource = "fetch" | "explicit";

interface Follow {
  podcast_id: string;
  podcast: string;
  source: FollowSource;
  fetch_count: number;
  last_fetched_at?: string;
  newest_fetched_id?: string;
}

interface FollowingResponse {
  following: Follow[];
  muted: Array<{ podcast_id: string; podcast: string }>;
  limits: { explicit: number; inferred: number; inferred_window_days: number };
}

interface FollowChange {
  podcast_id: string;
  podcast: string;
  state: "following" | "muted";
}

interface NewEpisode extends EpisodeRef {
  transcript_url: string;
}

interface NewShow {
  podcast_id: string;
  podcast: string;
  source: FollowSource;
  episodes: NewEpisode[];
}

interface NewResponse {
  as_of: string;
  count: number;
  shows: NewShow[];
}

interface ApiError {
  error?: { code?: string; message?: string };
}

const DEMO_KEY = "pt_demo";
const NO_FOLLOWS = "Following no shows yet. Fetch a transcript, or declare one with follow_podcast.";

const podcastId = z.string().min(1);
const podcastIdFromSearch = podcastId.describe("Show id (the podcast_id field from a search_podcasts result).");

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: body }], isError };
}

function episodeLine(e: EpisodeRef): string {
  return `- ${e.title} (${e.date}) · id: ${e.id}`;
}

export function createSpokenServer(options: SpokenServerOptions = {}): McpServer {
  const apiKey = options.apiKey || DEMO_KEY;
  const usingDemoKey = apiKey === DEMO_KEY;
  const baseUrl = (options.baseUrl ?? "https://spoken.md").replace(/\/$/, "");
  const keyHelp = options.keyHelp ?? "Get a key at https://spoken.md.";

  async function spokenFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "x-api-key": apiKey, ...(init?.headers ?? {}) },
    });
  }

  /** Turn a non-200 response into a helpful, agent-readable message. */
  async function describeError(res: Response): Promise<string> {
    if (res.status === 429) {
      return "429 Too Many Requests — Spoken is temporarily throttled. Back off and retry shortly.";
    }
    let detail = "";
    try {
      const json = (await res.json()) as ApiError;
      detail = json.error?.message ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    const hints: Record<number, string> = {
      401: `Missing or invalid API key. ${keyHelp}`,
      // A 402 means two different things, and the demo case is by far the more common
      // one: no key was given, so we fell back to pt_demo, which searches fully but
      // only fetches the demo episode. Telling that user to "top up" sends them to
      // buy credits for a key they do not have.
      402: usingDemoKey
        ? "No API key is set, so this server is using the free pt_demo key - " +
          `it can search everything but only fetch the demo episode. ${keyHelp}`
        : "No credits remaining. Top up at https://spoken.md.",
      404: "Episode not found or has no transcript.",
      502: "Upstream error — safe to retry in a moment.",
    };
    return `${res.status} ${res.statusText}. ${hints[res.status] ?? ""} ${detail}`.trim();
  }

  const server = new McpServer({ name: "spoken", version: VERSION });

  server.registerTool(
    "search_podcasts",
    {
      title: "Search podcasts",
      description:
        "Search published podcast episodes by text query, or paste an episode URL (Spotify, YouTube, etc.). Returns matching episodes with their id, title, podcast, podcast_id, and date. Use the id with get_transcript, or the podcast_id with list_episodes to get the show's whole back-catalog. Does not consume credits.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Free text (e.g. 'huberman sleep') or a pasted episode URL."),
      }),
    },
    async ({ query }) => {
      const res = await spokenFetch(`/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return text(await describeError(res), true);
      const { results } = (await res.json()) as SearchResponse;
      if (results.length === 0) return text(`No episodes found for "${query}".`);
      const lines = results.map(
        (r) => `- ${r.title} — ${r.podcast} (${r.date}) · id: ${r.id} · podcast_id: ${r.podcastId}`,
      );
      return text(`Found ${results.length} episode(s):\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "get_transcript",
    {
      title: "Get transcript",
      description:
        "Fetch a podcast episode's transcript as clean Markdown with real speaker names and timestamps. Pass an episode id from search_podcasts. Costs 1 credit on the first fetch of an episode; repeat fetches are free and errors are never charged.",
      inputSchema: z.object({
        episode_id: z
          .string()
          .min(1)
          .describe("Episode id returned by search_podcasts."),
      }),
    },
    async ({ episode_id }) => {
      const res = await spokenFetch(`/transcripts/${encodeURIComponent(episode_id)}`);
      if (!res.ok) return text(await describeError(res), true);
      const transcript = await res.text();
      const remaining = res.headers.get("X-Credits-Remaining");
      const charged = res.headers.get("X-Credits-Charged");
      const footer =
        remaining !== null
          ? `\n\n---\nCredits charged: ${charged ?? "?"} · remaining: ${remaining}`
          : "";
      return text(`${transcript}${footer}`);
    },
  );

  server.registerTool(
    "list_episodes",
    {
      title: "List a show's episodes",
      description:
        "List a podcast's entire back-catalog (every episode, newest first). Pass a podcast_id from a search_podcasts result. Returns each episode's id, title, and date — fetch any with get_transcript. Use this to transcribe a whole show. Does not consume credits itself; transcribing the returned episodes costs 1 credit each (repeat fetches are free), so make sure the key has enough credits before looping.",
      inputSchema: z.object({ podcast_id: podcastIdFromSearch }),
    },
    async ({ podcast_id }) => {
      const res = await spokenFetch(
        `/podcasts/${encodeURIComponent(podcast_id)}/episodes`,
      );
      if (!res.ok) return text(await describeError(res), true);
      const data = (await res.json()) as EpisodesResponse;
      if (data.count === 0) {
        return text(`No episodes found for podcast id ${podcast_id}.`);
      }
      const lines = data.episodes.map(episodeLine);
      return text(
        `${data.podcast} — ${data.count} episode(s) (transcribing all costs up to ${data.count} credits):\n${lines.join("\n")}`,
      );
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get credit balance",
      description:
        "Check the current Spoken credit balance, account email, and recent usage for the configured API key. Does not consume credits.",
    },
    async () => {
      const res = await spokenFetch(`/balance`);
      if (!res.ok) return text(await describeError(res), true);
      const body = await res.json();
      return text(JSON.stringify(body, null, 2));
    },
  );

  server.registerTool(
    "list_following",
    {
      title: "List followed shows",
      description:
        "The shows this key is kept current on. Every charged fetch makes its show a follow: the five most-fetched shows from the last 180 days are followed automatically (source 'fetch'), and up to 25 more can be declared with follow_podcast (source 'explicit'). Muted shows are listed separately. Use list_new_episodes to see what is new on them. Does not consume credits; the demo key has nothing to follow with.",
    },
    async () => {
      const res = await spokenFetch(`/following`);
      if (!res.ok) return text(await describeError(res), true);
      const data = (await res.json()) as FollowingResponse;
      const lines = data.following.map(
        (f) =>
          `- ${f.podcast} · podcast_id: ${f.podcast_id} · ${f.source === "explicit" ? "declared" : "from your fetches"}` +
          ` · ${f.fetch_count} fetched` +
          (f.newest_fetched_id ? ` · newest fetched: ${f.newest_fetched_id}` : ""),
      );
      const muted = data.muted.map((m) => `- ${m.podcast} · podcast_id: ${m.podcast_id}`);
      const parts = [
        data.following.length === 0
          ? NO_FOLLOWS
          : `Following ${data.following.length} show(s) (up to ${data.limits.explicit} declared, ${data.limits.inferred} automatic):\n${lines.join("\n")}`,
      ];
      if (muted.length > 0) parts.push(`Muted (unfollow_podcast; follow_podcast reverses it):\n${muted.join("\n")}`);
      return text(parts.join("\n\n"));
    },
  );

  server.registerTool(
    "follow_podcast",
    {
      title: "Follow a show",
      description:
        "Declare a follow for a show, or clear a mute. Pass a podcast_id from search_podcasts. A declared follow stays until unfollow_podcast, regardless of fetch activity, and does not use one of the five automatic slots. For a show never fetched, what counts as new starts from its newest episode now. Does not consume credits.",
      inputSchema: z.object({ podcast_id: podcastIdFromSearch }),
    },
    async ({ podcast_id }) => {
      const res = await spokenFetch(`/following/${encodeURIComponent(podcast_id)}`, { method: "PUT" });
      if (!res.ok) {
        if (res.status === 409) {
          return text("409 — declared-follow limit reached. Unfollow a show with unfollow_podcast first.", true);
        }
        if (res.status === 404) return text(`404 — no podcast with id ${podcast_id}.`, true);
        return text(await describeError(res), true);
      }
      const data = (await res.json()) as FollowChange;
      return text(`Now following ${data.podcast} (podcast_id ${data.podcast_id}). list_new_episodes will show its new episodes.`);
    },
  );

  server.registerTool(
    "unfollow_podcast",
    {
      title: "Stop following a show",
      description:
        "Mute a show: it leaves the followed list and later fetches do not re-add it. follow_podcast reverses it. Pass a podcast_id from list_following. Does not consume credits.",
      inputSchema: z.object({
        podcast_id: podcastId.describe("Show id, from list_following or search_podcasts."),
      }),
    },
    async ({ podcast_id }) => {
      const res = await spokenFetch(`/following/${encodeURIComponent(podcast_id)}`, { method: "DELETE" });
      if (!res.ok) {
        if (res.status === 404) return text(`404 — not following podcast id ${podcast_id}.`, true);
        return text(await describeError(res), true);
      }
      const data = (await res.json()) as FollowChange;
      return text(`Muted ${data.podcast} (podcast_id ${data.podcast_id}). follow_podcast reverses it.`);
    },
  );

  server.registerTool(
    "list_new_episodes",
    {
      title: "List new episodes on followed shows",
      description:
        "What is new on the shows this key follows: for each show, the episodes released in the last 90 days that are newer than the newest one already fetched from it (up to 10 per show), each with a transcript_url. Episodes with no transcript are left out. Fetch any with get_transcript (1 credit each on first fetch); a fetch raises that show's floor, so the next call lists only what came after. Refreshed hourly, so a show followed moments ago may be empty until its first poll. Does not consume credits.",
    },
    async () => {
      const res = await spokenFetch(`/new`);
      if (!res.ok) return text(await describeError(res), true);
      const data = (await res.json()) as NewResponse;
      if (data.shows.length === 0) {
        return text(NO_FOLLOWS);
      }
      if (data.count === 0) {
        return text(`Nothing new on the ${data.shows.length} show(s) you follow as of ${data.as_of}.`);
      }
      const blocks = data.shows
        .filter((s) => s.episodes.length > 0)
        .map(
          (s) =>
            `${s.podcast} (podcast_id ${s.podcast_id}):\n` +
            s.episodes.map(episodeLine).join("\n"),
        );
      return text(
        `${data.count} new episode(s) across ${blocks.length} show(s), as of ${data.as_of}. Fetch any with get_transcript (1 credit each on first fetch).\n\n${blocks.join("\n\n")}`,
      );
    },
  );

  return server;
}
