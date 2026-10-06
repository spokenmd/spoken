/**
 * The Spoken MCP server, as a factory.
 *
 * `createSpokenServer` builds a server exposing the Spoken podcast-transcript
 * API (https://spoken.md) for one API key. The stdio entry point (`index.ts`)
 * builds one from the environment; an HTTP host builds one per request, for
 * that request's key.
 */
import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export const VERSION = "0.4.2";

export interface SpokenServerOptions {
  /** A Spoken API key (`pt_...`). Omitted: the free `pt_demo` key, which searches fully but only fetches the demo episode. */
  apiKey?: string;
  /** API origin. Defaults to https://spoken.md. */
  baseUrl?: string;
  /** How this host's user gets and supplies a key; closes the missing-key error messages. Defaults to pointing at https://spoken.md. */
  keyHelp?: string;
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

/** A result for a tool that declares an output schema: the text as before, and the same facts as data. */
function structured(body: string, data: Record<string, unknown>): CallToolResult {
  return { ...text(body), structuredContent: data };
}

/**
 * The API's answer, read through the schema of what the tool returns. An answer the schema does
 * not fit is thrown as one readable line, which the SDK hands the caller as the tool's error.
 */
async function read<S extends z.ZodType>(res: Response, schema: S): Promise<z.output<S>> {
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (parsed.success) return parsed.data;
  throw new Error(
    `Spoken answered in a shape spoken-mcp ${VERSION} does not understand; a newer version may. ${z.prettifyError(parsed.error)}`,
  );
}

// What each tool returns, defined once: the output schema a client is shown, the type the
// handler works with, and the parser for the API's answer, which drops anything not named here.
const episode = z.object({
  id: z.string().describe("Episode id; pass it to get_transcript."),
  title: z.string(),
  date: z.string().describe("Release date, ISO 8601."),
});
type Episode = z.infer<typeof episode>;

const show = z.object({
  podcast_id: z.string().describe("Show id; pass it to list_episodes or follow_podcast."),
  podcast: z.string().describe("Show name."),
});

const followSource = z
  .enum(["fetch", "explicit"])
  .describe("'fetch': followed automatically from fetches. 'explicit': declared with follow_podcast.");

const searchOutput = z.object({ results: z.array(episode.extend(show.shape)) });

const episodesOutput = show.extend({
  count: z.number().describe("Episodes listed; fetching all of them costs up to this many credits."),
  episodes: z.array(episode),
});

const balanceOutput = z.object({
  credits: z.number().describe("Credits remaining; one is spent per first fetch of an episode."),
  email: z.string().optional().describe("Account email, when one is attached to the key."),
  usage: z.object({
    total: z.number().describe("Episodes fetched with this key."),
    recent: z.array(z.object({ episodeId: z.string(), accessedAt: z.string() })).describe("The 50 most recent fetches."),
  }),
});

const followingOutput = z.object({
  following: z.array(
    show.extend({
      source: followSource,
      fetch_count: z.number().describe("Episodes of this show fetched."),
      last_fetched_at: z.string().optional(),
      newest_fetched_id: z.string().optional().describe("Newest episode fetched; list_new_episodes lists what came after it."),
    }),
  ),
  muted: z.array(show),
  limits: z.object({
    explicit: z.number().describe("Most shows that can be declared with follow_podcast."),
    inferred: z.number().describe("Shows followed automatically from fetches."),
    inferred_window_days: z.number(),
  }),
});

const followChangeOutput = show.extend({ state: z.enum(["following", "muted"]) });

const newEpisodesOutput = z.object({
  as_of: z.string().describe("When the list was read, ISO 8601."),
  count: z.number().describe("New episodes across all followed shows."),
  shows: z.array(show.extend({ source: followSource, episodes: z.array(episode.extend({ transcript_url: z.string() })) })),
});

/** The search route alone spells the show id `podcastId`; every tool here calls it `podcast_id`. Read with this, never advertised. */
const searchWire = z
  .object({ results: z.array(episode.extend({ podcast: show.shape.podcast, podcastId: show.shape.podcast_id })) })
  .transform(({ results }): z.infer<typeof searchOutput> => ({
    results: results.map(({ podcastId, ...rest }) => ({ ...rest, podcast_id: podcastId })),
  }));

// Reads of published podcast content, and reads of the caller's own account.
const READS_CATALOG: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const READS_ACCOUNT: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// A follow or a mute: changes the caller's own list, reversible, and the same call twice changes nothing more.
const CHANGES_FOLLOWS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function episodeLine(e: Episode): string {
  return `- ${e.title} (${e.date}) · id: ${e.id}`;
}

/** What the wrapper reaches the API with, for the key its server was built for. */
interface Api {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  describeError(res: Response): Promise<string>;
}

/** What only the host knows about the service it fronts. */
export interface HostFacts {
  /** The one episode `get_transcript` serves without an account. */
  demoEpisodeId?: string;
}

/**
 * Whether a tool works with no account: always, never, or depending on the call. The
 * arguments are as the caller sent them, before any validation.
 */
type Anonymous = boolean | ((args: Record<string, unknown>, host: HostFacts) => boolean);

interface ToolSpec {
  name: string;
  anonymous: Anonymous;
  register(server: McpServer, api: Api): void;
}

/** For a tool that takes no arguments. */
const NO_INPUT = z.object({});

/** The request a tool makes for its arguments: a path, with the method when it is not a GET. */
type ToolRequest<Input extends z.ZodObject> = (args: Args<Input>) => string | { path: string; method: "PUT" | "DELETE" };

/** A tool's arguments as the SDK hands them over: its input schema's output. */
type Args<Input extends z.ZodObject> = StandardSchemaWithJSON.InferOutput<Input>;

/** An output schema: what `structuredContent` may hold is an object. */
type Structured = z.ZodType<Record<string, unknown>>;

/**
 * What a tool makes of the API's answer. Most read it through the output schema (or `reads`,
 * where the API spells things differently) and write a text from the data; `raw` is for the
 * one answer that is not JSON.
 */
type ToolAnswer<Input extends z.ZodObject, Out extends Structured> =
  | { outputSchema: Out; reads?: z.ZodType<z.output<Out>>; text: (data: z.output<Out>, args: Args<Input>) => string }
  | { raw: (res: Response) => Promise<string> };

/**
 * One tool: fetches, turns a failed response into the error text, reads the answer, and
 * returns it as text and as data. The tool itself only says what to request and how to
 * word the answer.
 */
function tool<Input extends z.ZodObject, Out extends Structured = Structured>(
  name: string,
  {
    anonymous = false,
    inputSchema,
    request,
    ...answer
  }: {
    title: string;
    description: string;
    inputSchema: Input;
    annotations: ToolAnnotations;
    anonymous?: Anonymous;
    request: ToolRequest<Input>;
  } & ToolAnswer<Input, Out>,
): ToolSpec {
  const { title, description, annotations } = answer;
  const outputSchema = "outputSchema" in answer ? answer.outputSchema : undefined;
  return {
    name,
    anonymous,
    register(server, api) {
      const handler = async (args: Args<Input>): Promise<CallToolResult> => {
        const wanted = request(args);
        const { path, method } = typeof wanted === "string" ? { path: wanted, method: undefined } : wanted;
        const res = await api.fetch(path, method ? { method } : undefined);
        if (!res.ok) return text(await api.describeError(res), true);
        if ("raw" in answer) return text(await answer.raw(res));
        const data = await read(res, answer.reads ?? answer.outputSchema);
        return structured(answer.text(data, args), data);
      };
      // The SDK types the callback by a conditional on `Input`, which TypeScript leaves unresolved
      // for a type parameter; the handler takes exactly what that conditional resolves to.
      server.registerTool(
        name,
        { title, description, inputSchema, outputSchema, annotations },
        handler as unknown as ToolCallback<Input>,
      );
    },
  };
}

const TOOLS: ToolSpec[] = [
  tool("search_podcasts", {
    anonymous: true,
    title: "Search podcasts",
    description:
      "Search published podcast episodes by text query, or paste an episode URL (Spotify, YouTube, etc.). Returns matching episodes with their id, title, podcast, podcast_id, and date. Use the id with get_transcript, or the podcast_id with list_episodes to get the show's whole back-catalog. Does not consume credits.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe("Free text (e.g. 'huberman sleep') or a pasted episode URL."),
    }),
    outputSchema: searchOutput,
    reads: searchWire,
    annotations: READS_CATALOG,
    request: ({ query }) => `/search?q=${encodeURIComponent(query)}`,
    text: ({ results }, { query }) => {
      if (results.length === 0) return `No episodes found for "${query}".`;
      const lines = results.map(
        (r) => `- ${r.title} — ${r.podcast} (${r.date}) · id: ${r.id} · podcast_id: ${r.podcast_id}`,
      );
      return `Found ${results.length} episode(s):\n${lines.join("\n")}`;
    },
  }),

  tool("get_transcript", {
    // One episode is served without an account; which one is the host's to say.
    anonymous: (args, host) => host.demoEpisodeId !== undefined && args.episode_id === host.demoEpisodeId,
    title: "Get transcript",
    description:
      "Fetch a podcast episode's transcript as clean Markdown with real speaker names and timestamps. Pass an episode id from search_podcasts. Costs 1 credit on the first fetch of an episode; repeat fetches are free and errors are never charged.",
    inputSchema: z.object({
      episode_id: z
        .string()
        .min(1)
        .describe("Episode id returned by search_podcasts."),
    }),
    // No output schema: the result is the transcript itself, and a structured copy would send it twice.
    annotations: READS_CATALOG,
    request: ({ episode_id }) => `/transcripts/${encodeURIComponent(episode_id)}`,
    raw: async (res) => {
      const transcript = await res.text();
      const remaining = res.headers.get("X-Credits-Remaining");
      const charged = res.headers.get("X-Credits-Charged");
      const footer =
        remaining !== null
          ? `\n\n---\nCredits charged: ${charged ?? "?"} · remaining: ${remaining}`
          : "";
      return `${transcript}${footer}`;
    },
  }),

  tool("list_episodes", {
    anonymous: true,
    title: "List a show's episodes",
    description:
      "List a podcast's entire back-catalog (every episode, newest first). Pass a podcast_id from a search_podcasts result. Returns each episode's id, title, and date — fetch any with get_transcript. Use this to transcribe a whole show. Does not consume credits itself; transcribing the returned episodes costs 1 credit each (repeat fetches are free), so make sure the key has enough credits before looping.",
    inputSchema: z.object({ podcast_id: podcastIdFromSearch }),
    outputSchema: episodesOutput,
    annotations: READS_CATALOG,
    request: ({ podcast_id }) => `/podcasts/${encodeURIComponent(podcast_id)}/episodes`,
    text: (data, { podcast_id }) => {
      if (data.count === 0) return `No episodes found for podcast id ${podcast_id}.`;
      const lines = data.episodes.map(episodeLine);
      return `${data.podcast} — ${data.count} episode(s) (transcribing all costs up to ${data.count} credits):\n${lines.join("\n")}`;
    },
  }),

  tool("get_balance", {
    title: "Get credit balance",
    description:
      "Check the current Spoken credit balance, account email, and recent usage for the configured API key. Does not consume credits.",
    inputSchema: NO_INPUT,
    outputSchema: balanceOutput,
    annotations: READS_ACCOUNT,
    request: () => `/balance`,
    text: (data) => JSON.stringify(data, null, 2),
  }),

  tool("list_following", {
    title: "List followed shows",
    description:
      "The shows this key is kept current on. Every charged fetch makes its show a follow: the five most-fetched shows from the last 180 days are followed automatically (source 'fetch'), and up to 25 more can be declared with follow_podcast (source 'explicit'). Muted shows are listed separately. Use list_new_episodes to see what is new on them. Does not consume credits; the demo key has nothing to follow with.",
    inputSchema: NO_INPUT,
    outputSchema: followingOutput,
    annotations: READS_ACCOUNT,
    request: () => `/following`,
    text: (data) => {
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
      return parts.join("\n\n");
    },
  }),

  tool("follow_podcast", {
    title: "Follow a show",
    description:
      "Declare a follow for a show, or clear a mute. Pass a podcast_id from search_podcasts. A declared follow stays until unfollow_podcast, regardless of fetch activity, and does not use one of the five automatic slots. For a show never fetched, what counts as new starts from its newest episode now. Does not consume credits.",
    inputSchema: z.object({ podcast_id: podcastIdFromSearch }),
    outputSchema: followChangeOutput,
    annotations: CHANGES_FOLLOWS,
    request: ({ podcast_id }) => ({ path: `/following/${encodeURIComponent(podcast_id)}`, method: "PUT" }),
    text: (data) => `Now following ${data.podcast} (podcast_id ${data.podcast_id}). list_new_episodes will show its new episodes.`,
  }),

  tool("unfollow_podcast", {
    title: "Stop following a show",
    description:
      "Mute a show: it leaves the followed list and later fetches do not re-add it. follow_podcast reverses it. Pass a podcast_id from list_following. Does not consume credits.",
    inputSchema: z.object({
      podcast_id: podcastId.describe("Show id, from list_following or search_podcasts."),
    }),
    outputSchema: followChangeOutput,
    annotations: CHANGES_FOLLOWS,
    request: ({ podcast_id }) => ({ path: `/following/${encodeURIComponent(podcast_id)}`, method: "DELETE" }),
    text: (data) => `Muted ${data.podcast} (podcast_id ${data.podcast_id}). follow_podcast reverses it.`,
  }),

  tool("list_new_episodes", {
    title: "List new episodes on followed shows",
    description:
      "What is new on the shows this key follows: for each show, the episodes released in the last 90 days that are newer than the newest one already fetched from it (up to 10 per show), each with a transcript_url. Episodes with no transcript are left out. Fetch any with get_transcript (1 credit each on first fetch); a fetch raises that show's floor, so the next call lists only what came after. Refreshed hourly, so a show followed moments ago may be empty until its first poll. Does not consume credits.",
    inputSchema: NO_INPUT,
    outputSchema: newEpisodesOutput,
    annotations: READS_ACCOUNT,
    request: () => `/new`,
    text: (data) => {
      if (data.shows.length === 0) return NO_FOLLOWS;
      if (data.count === 0) return `Nothing new on the ${data.shows.length} show(s) you follow as of ${data.as_of}.`;
      const blocks = data.shows
        .filter((s) => s.episodes.length > 0)
        .map((s) => `${s.podcast} (podcast_id ${s.podcast_id}):\n` + s.episodes.map(episodeLine).join("\n"));
      return `${data.count} new episode(s) across ${blocks.length} show(s), as of ${data.as_of}. Fetch any with get_transcript (1 credit each on first fetch).\n\n${blocks.join("\n\n")}`;
    },
  }),
];

/**
 * Whether a `tools/call` needs a real API key, read off the tool definitions above. False for
 * the calls that work with no account (searching, listing a show, and the demo episode when
 * the host says which episode that is); true for everything else, including a tool this
 * package does not know. A host that wants to ask for a key up front, rather than let the call
 * come back as an error, asks this.
 */
export function needsKey(toolName: string, args: unknown, host: HostFacts = {}): boolean {
  const anonymous = TOOLS.find((spec) => spec.name === toolName)?.anonymous ?? false;
  if (typeof anonymous === "boolean") return !anonymous;
  return !anonymous(args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {}, host);
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
    // Read once: a body cannot be read as JSON and then again as text. An error that is not
    // JSON (a gateway's page, say) is passed on as it came, cut short.
    const raw = await res.text().catch(() => "");
    let detail: string;
    try {
      detail = (JSON.parse(raw) as ApiError).error?.message ?? "";
    } catch {
      detail = raw.slice(0, 200);
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
      502: "Upstream error — safe to retry in a moment.",
    };
    return [`${res.status} ${res.statusText}.`, hints[res.status], detail].filter(Boolean).join(" ");
  }

  const api: Api = { fetch: spokenFetch, describeError };
  const server = new McpServer({ name: "spoken", version: VERSION });
  for (const spec of TOOLS) spec.register(server, api);

  return server;
}
