#!/usr/bin/env node
/**
 * Spoken MCP server.
 *
 * Exposes the Spoken podcast-transcript API (https://spoken.md) to MCP-compatible
 * agents (Claude Desktop, Cursor, Cline, ...). Transcripts come back as clean
 * Markdown with real speaker names — not "Speaker 1."
 *
 * Auth: set SPOKEN_API_KEY (get one at https://spoken.md). Defaults to the free
 * `pt_demo` key, which can search fully but only fetch the demo episode.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const USING_DEMO_KEY: boolean = !process.env.SPOKEN_API_KEY;
const API_KEY: string = process.env.SPOKEN_API_KEY ?? "pt_demo";
const BASE_URL: string = (process.env.SPOKEN_BASE_URL ?? "https://spoken.md").replace(/\/$/, "");

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

interface Follow {
  podcast_id: string;
  podcast: string;
  source: "fetch" | "explicit";
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

interface NewEpisode {
  id: string;
  title: string;
  date: string;
  transcript_url: string;
}

interface NewShow {
  podcast_id: string;
  podcast: string;
  source: "fetch" | "explicit";
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

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(body: string, isError = false): TextResult {
  return { content: [{ type: "text", text: body }], isError };
}

async function spokenFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "x-api-key": API_KEY, ...(init?.headers ?? {}) },
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
    401: "Missing or invalid API key. Set SPOKEN_API_KEY (get one at https://spoken.md).",
    // A 402 means two different things, and the demo case is by far the more common
    // one: no SPOKEN_API_KEY was set, so we fell back to pt_demo, which searches
    // fully but only fetches the demo episode. Telling that user to "top up" sends
    // them to buy credits for a key they do not have.
    402: USING_DEMO_KEY
      ? "No SPOKEN_API_KEY is set, so this server is using the free pt_demo key - " +
        "it can search everything but only fetch the demo episode. Get a key at " +
        "https://spoken.md and set SPOKEN_API_KEY to fetch this episode."
      : "No credits remaining. Top up at https://spoken.md.",
    404: "Episode not found or has no transcript.",
    502: "Upstream error — safe to retry in a moment.",
  };
  return `${res.status} ${res.statusText}. ${hints[res.status] ?? ""} ${detail}`.trim();
}

const server = new McpServer({ name: "spoken", version: "0.3.0" });

server.registerTool(
  "search_podcasts",
  {
    title: "Search podcasts",
    description:
      "Search published podcast episodes by text query, or paste an episode URL (Spotify, YouTube, etc.). Returns matching episodes with their id, title, podcast, podcast_id, and date. Use the id with get_transcript, or the podcast_id with list_episodes to get the show's whole back-catalog. Does not consume credits.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe("Free text (e.g. 'huberman sleep') or a pasted episode URL."),
    },
  },
  async ({ query }): Promise<TextResult> => {
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
    inputSchema: {
      episode_id: z
        .string()
        .min(1)
        .describe("Episode id returned by search_podcasts."),
    },
  },
  async ({ episode_id }): Promise<TextResult> => {
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
    inputSchema: {
      podcast_id: z
        .string()
        .min(1)
        .describe("Show id (the podcast_id field from a search_podcasts result)."),
    },
  },
  async ({ podcast_id }): Promise<TextResult> => {
    const res = await spokenFetch(
      `/podcasts/${encodeURIComponent(podcast_id)}/episodes`,
    );
    if (!res.ok) return text(await describeError(res), true);
    const data = (await res.json()) as EpisodesResponse;
    if (data.count === 0) {
      return text(`No episodes found for podcast id ${podcast_id}.`);
    }
    const lines = data.episodes.map(
      (e) => `- ${e.title} (${e.date}) · id: ${e.id}`,
    );
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
    inputSchema: {},
  },
  async (): Promise<TextResult> => {
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
    inputSchema: {},
  },
  async (): Promise<TextResult> => {
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
        ? "Following no shows yet. Fetch a transcript, or declare one with follow_podcast."
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
    inputSchema: {
      podcast_id: z.string().min(1).describe("Show id (the podcast_id field from a search_podcasts result)."),
    },
  },
  async ({ podcast_id }): Promise<TextResult> => {
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
    inputSchema: {
      podcast_id: z.string().min(1).describe("Show id, from list_following or search_podcasts."),
    },
  },
  async ({ podcast_id }): Promise<TextResult> => {
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
    inputSchema: {},
  },
  async (): Promise<TextResult> => {
    const res = await spokenFetch(`/new`);
    if (!res.ok) return text(await describeError(res), true);
    const data = (await res.json()) as NewResponse;
    if (data.shows.length === 0) {
      return text("Following no shows yet. Fetch a transcript, or declare one with follow_podcast.");
    }
    if (data.count === 0) {
      return text(`Nothing new on the ${data.shows.length} show(s) you follow as of ${data.as_of}.`);
    }
    const blocks = data.shows
      .filter((s) => s.episodes.length > 0)
      .map(
        (s) =>
          `${s.podcast} (podcast_id ${s.podcast_id}):\n` +
          s.episodes.map((e) => `- ${e.title} (${e.date}) · id: ${e.id}`).join("\n"),
      );
    return text(
      `${data.count} new episode(s) across ${blocks.length} show(s), as of ${data.as_of}. Fetch any with get_transcript (1 credit each on first fetch).\n\n${blocks.join("\n\n")}`,
    );
  },
);

async function main(): Promise<void> {
  // stderr only - stdout is the MCP protocol channel on a stdio transport.
  if (USING_DEMO_KEY) {
    console.error(
      "spoken-mcp: SPOKEN_API_KEY is not set, falling back to the free pt_demo key. " +
        "Search works fully, but transcript fetches will only succeed for the demo " +
        "episode. Get a key at https://spoken.md and set SPOKEN_API_KEY.",
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("spoken-mcp failed to start:", err);
  process.exit(1);
});
