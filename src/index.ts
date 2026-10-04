#!/usr/bin/env node
/**
 * Spoken MCP server, over stdio.
 *
 * Exposes the Spoken podcast-transcript API (https://spoken.md) to MCP-compatible
 * agents (Claude Desktop, Cursor, Cline, ...). Transcripts come back as clean
 * Markdown with real speaker names — not "Speaker 1."
 *
 * Auth: set SPOKEN_API_KEY (get one at https://spoken.md). Defaults to the free
 * `pt_demo` key, which can search fully but only fetch the demo episode.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createSpokenServer } from "./server.js";

const apiKey = process.env.SPOKEN_API_KEY;
const keyHelp = "Get a key at https://spoken.md and set SPOKEN_API_KEY.";

// stderr only - stdout is the MCP protocol channel on a stdio transport.
if (!apiKey) {
  console.error(
    "spoken-mcp: SPOKEN_API_KEY is not set, falling back to the free pt_demo key. " +
      "Search works fully, but transcript fetches will only succeed for the demo " +
      `episode. ${keyHelp}`,
  );
}

serveStdio(
  () => createSpokenServer({ apiKey, baseUrl: process.env.SPOKEN_BASE_URL, keyHelp }),
  { onerror: (err) => console.error("spoken-mcp:", err) },
);
