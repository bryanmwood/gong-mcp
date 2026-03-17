#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';

// Redirect all console output to stderr
const originalConsole = { ...console };
console.log = (...args) => originalConsole.error(...args);
console.info = (...args) => originalConsole.error(...args);
console.warn = (...args) => originalConsole.error(...args);

dotenv.config();

const GONG_API_URL = 'https://api.gong.io/v2';
const GONG_ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const GONG_ACCESS_SECRET = process.env.GONG_ACCESS_SECRET;

if (!GONG_ACCESS_KEY || !GONG_ACCESS_SECRET) {
  console.error("Error: GONG_ACCESS_KEY and GONG_ACCESS_SECRET environment variables are required");
  process.exit(1);
}

// ---------- Rate limiting & retry ----------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- Type definitions ----------

interface GongCall {
  id: string;
  title: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  direction?: string;
  system?: string;
  scope?: string;
  media?: string;
  language?: string;
  url?: string;
}

interface GongTranscriptEntry {
  speakerId: string;
  topic?: string;
  sentences: Array<{
    start: number;
    end?: number;
    text: string;
  }>;
}

interface GongCallTranscript {
  callId: string;
  transcript: GongTranscriptEntry[];
}

interface GongParty {
  speakerId?: string;
  name?: string;
  emailAddress?: string;
  title?: string;
  userId?: string;
  affiliation?: string;
}

interface GongExtensiveCall {
  metaData: GongCall & { id: string; title: string; started?: string; url?: string };
  parties?: GongParty[];
  content?: Record<string, unknown>;
}

interface GongUser {
  id: string;
  emailAddress?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  active?: boolean;
  created?: string;
}

// ---------- Gong API Client ----------

class GongClient {
  private accessKey: string;
  private accessSecret: string;

  constructor(accessKey: string, accessSecret: string) {
    this.accessKey = accessKey;
    this.accessSecret = accessSecret;
  }

  private async generateSignature(method: string, path: string, timestamp: string, params?: unknown): Promise<string> {
    const stringToSign = `${method}\n${path}\n${timestamp}\n${params ? JSON.stringify(params) : ''}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.accessSecret);
    const messageData = encoder.encode(stringToSign);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  private async request<T>(method: string, path: string, params?: Record<string, string | undefined>, data?: Record<string, unknown>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const timestamp = new Date().toISOString();
        const url = `${GONG_API_URL}${path}`;

        const response = await axios({
          method, url, params, data,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(`${this.accessKey}:${this.accessSecret}`).toString('base64')}`,
            'X-Gong-AccessKey': this.accessKey,
            'X-Gong-Timestamp': timestamp,
            'X-Gong-Signature': await this.generateSignature(method, path, timestamp, data || params)
          }
        });

        return response.data as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const axiosErr = error as AxiosError;

        if (axiosErr.response?.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = axiosErr.response.headers['retry-after'];
          const delayMs = retryAfter
            ? parseInt(retryAfter as string, 10) * 1000
            : BASE_DELAY_MS * Math.pow(2, attempt);
          console.error(`Rate limited. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delayMs);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  // --- Paginated helpers ---

  private async paginateGet<T>(path: string, resultKey: string, params?: Record<string, string | undefined>): Promise<T[]> {
    const allResults: T[] = [];
    let cursor: string | undefined;

    do {
      const queryParams = { ...params, ...(cursor ? { cursor } : {}) };
      const response = await this.request<Record<string, unknown>>('GET', path, queryParams);
      const items = response[resultKey] as T[] | undefined;
      if (items) allResults.push(...items);
      cursor = (response.records as Record<string, unknown>)?.cursor as string | undefined;
    } while (cursor);

    return allResults;
  }

  private async paginatePost<T>(path: string, resultKey: string, body: Record<string, unknown>): Promise<T[]> {
    const allResults: T[] = [];
    let cursor: string | undefined;

    do {
      const requestBody = { ...body, ...(cursor ? { cursor } : {}) };
      const response = await this.request<Record<string, unknown>>('POST', path, undefined, requestBody);
      const items = response[resultKey] as T[] | undefined;
      if (items) allResults.push(...items);
      cursor = (response.records as Record<string, unknown>)?.cursor as string | undefined;
    } while (cursor);

    return allResults;
  }

  // --- P0: Core tools ---

  async listCalls(fromDateTime?: string, toDateTime?: string): Promise<GongCall[]> {
    const params: Record<string, string | undefined> = {};
    if (fromDateTime) params.fromDateTime = fromDateTime;
    if (toDateTime) params.toDateTime = toDateTime;
    return this.paginateGet<GongCall>('/calls', 'calls', params);
  }

  async retrieveTranscripts(callIds: string[]): Promise<GongCallTranscript[]> {
    // Gong limits to 100 call IDs per request
    const allTranscripts: GongCallTranscript[] = [];
    for (let i = 0; i < callIds.length; i += 100) {
      const batch = callIds.slice(i, i + 100);
      const transcripts = await this.paginatePost<GongCallTranscript>(
        '/calls/transcript', 'callTranscripts',
        { filter: { callIds: batch } }
      );
      allTranscripts.push(...transcripts);
    }
    return allTranscripts;
  }

  async searchCalls(args: {
    fromDateTime?: string;
    toDateTime?: string;
    participantEmail?: string;
    callTitle?: string;
  }): Promise<GongExtensiveCall[]> {
    const filter: Record<string, unknown> = {};
    if (args.fromDateTime) filter.fromDateTime = args.fromDateTime;
    if (args.toDateTime) filter.toDateTime = args.toDateTime;

    const contentSelector = {
      exposedFields: { parties: true, content: false }
    };

    const calls = await this.paginatePost<GongExtensiveCall>(
      '/calls/extensive', 'calls',
      { filter, contentSelector }
    );

    // Client-side filtering for participant and title
    let results = calls;
    if (args.participantEmail) {
      const email = args.participantEmail.toLowerCase();
      results = results.filter(c =>
        c.parties?.some(p => (p.emailAddress || '').toLowerCase().includes(email))
      );
    }
    if (args.callTitle) {
      const title = args.callTitle.toLowerCase();
      results = results.filter(c =>
        (c.metaData.title || '').toLowerCase().includes(title)
      );
    }

    return results;
  }

  async getCallDetails(callId: string): Promise<GongExtensiveCall | null> {
    const calls = await this.paginatePost<GongExtensiveCall>(
      '/calls/extensive', 'calls',
      {
        filter: { callIds: [callId] },
        contentSelector: { exposedFields: { parties: true, content: true } }
      }
    );
    return calls[0] || null;
  }

  // --- P1: Context tools ---

  async listUsers(): Promise<GongUser[]> {
    return this.paginateGet<GongUser>('/users', 'users');
  }
}

const gongClient = new GongClient(GONG_ACCESS_KEY, GONG_ACCESS_SECRET);

// ---------- Tool definitions ----------

const LIST_CALLS_TOOL: Tool = {
  name: "list_calls",
  description: "List Gong calls with optional date range filtering. Returns call IDs, titles, start times, and duration. Use search_calls for richer filtering.",
  inputSchema: {
    type: "object",
    properties: {
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format (e.g. 2024-03-01T00:00:00Z)"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format (e.g. 2024-03-31T23:59:59Z)"
      }
    }
  }
};

const RETRIEVE_TRANSCRIPTS_TOOL: Tool = {
  name: "retrieve_transcripts",
  description: "Retrieve full transcripts for specified call IDs. Returns speaker IDs, topics, and timestamped sentences. Use list_users to resolve speaker IDs to names.",
  inputSchema: {
    type: "object",
    properties: {
      callIds: {
        type: "array",
        items: { type: "string" },
        description: "Array of Gong call IDs to retrieve transcripts for"
      }
    },
    required: ["callIds"]
  }
};

const SEARCH_CALLS_TOOL: Tool = {
  name: "search_calls",
  description: "Search Gong calls with rich filtering: by date range, participant email, and/or call title keyword. Returns full call metadata including participant names and emails. More powerful than list_calls.",
  inputSchema: {
    type: "object",
    properties: {
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format (e.g. 2026-03-01T00:00:00Z)"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format (e.g. 2026-03-31T23:59:59Z)"
      },
      participantEmail: {
        type: "string",
        description: "Filter by participant email address (partial match, case-insensitive). E.g. 'dan.oersnes' or 'reflection.ai'"
      },
      callTitle: {
        type: "string",
        description: "Filter by call title keyword (partial match, case-insensitive). E.g. 'Reflection' or 'xAI'"
      }
    }
  }
};

const GET_CALL_DETAILS_TOOL: Tool = {
  name: "get_call_details",
  description: "Get full metadata for a single call including all participants (names, emails, titles), duration, and content. Use this to drill into a specific call after finding it with search_calls or list_calls.",
  inputSchema: {
    type: "object",
    properties: {
      callId: {
        type: "string",
        description: "The Gong call ID"
      }
    },
    required: ["callId"]
  }
};

const SEARCH_TRANSCRIPTS_TOOL: Tool = {
  name: "search_transcripts",
  description: "Search across call transcripts for specific content. Finds calls matching the query text within transcript sentences. Returns matching excerpts with speaker info, timestamps, and call links. Useful for finding specific discussions, quotes, or topics across many calls.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text to search for in transcripts (case-insensitive). Can be a word, phrase, or comma-separated keywords. E.g. 'pricing', 'terminal bench', 'copenhagen, river, swimming'"
      },
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format"
      },
      participantEmail: {
        type: "string",
        description: "Only search calls where this person participated (email, partial match)"
      },
      speakerOnly: {
        type: "boolean",
        description: "If true, only match sentences spoken by the participant (requires participantEmail). Default false."
      },
      contextSentences: {
        type: "number",
        description: "Number of surrounding sentences to include for context. Default 2."
      },
      maxResults: {
        type: "number",
        description: "Maximum number of matching excerpts to return. Default 20."
      }
    },
    required: ["query"]
  }
};

const LIST_USERS_TOOL: Tool = {
  name: "list_users",
  description: "List all Gong users (internal team members) with their IDs, names, emails, and titles. Use this to resolve speaker IDs from transcripts to actual names. Also useful for finding a person's email to use with search_calls.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

// ---------- Type guards ----------

function isListCallsArgs(args: unknown): args is { fromDateTime?: string; toDateTime?: string } {
  return typeof args === "object" && args !== null;
}

function isRetrieveTranscriptsArgs(args: unknown): args is { callIds: string[] } {
  return (
    typeof args === "object" && args !== null &&
    "callIds" in args && Array.isArray((args as { callIds: unknown }).callIds)
  );
}

function isSearchCallsArgs(args: unknown): args is {
  fromDateTime?: string; toDateTime?: string;
  participantEmail?: string; callTitle?: string;
} {
  return typeof args === "object" && args !== null;
}

function isGetCallDetailsArgs(args: unknown): args is { callId: string } {
  return typeof args === "object" && args !== null && "callId" in args;
}

function isSearchTranscriptsArgs(args: unknown): args is {
  query: string; fromDateTime?: string; toDateTime?: string;
  participantEmail?: string; speakerOnly?: boolean;
  contextSentences?: number; maxResults?: number;
} {
  return typeof args === "object" && args !== null && "query" in args;
}

// ---------- Search transcripts implementation ----------

interface TranscriptMatch {
  callId: string;
  callTitle: string;
  callUrl: string;
  callDate: string;
  speakerName: string;
  speakerEmail: string;
  timestampMs: number;
  timestamp: string;
  matchedText: string;
  context: string[];
}

async function searchTranscriptsImpl(args: {
  query: string; fromDateTime?: string; toDateTime?: string;
  participantEmail?: string; speakerOnly?: boolean;
  contextSentences?: number; maxResults?: number;
}): Promise<TranscriptMatch[]> {
  const contextSize = args.contextSentences ?? 2;
  const maxResults = args.maxResults ?? 20;

  // 1. Find matching calls
  const calls = await gongClient.searchCalls({
    fromDateTime: args.fromDateTime,
    toDateTime: args.toDateTime,
    participantEmail: args.participantEmail,
  });

  if (calls.length === 0) return [];

  // 2. Build participant lookup: callId -> { speakerId -> { name, email } }
  const participantMap = new Map<string, Map<string, { name: string; email: string }>>();
  for (const call of calls) {
    const speakers = new Map<string, { name: string; email: string }>();
    for (const party of call.parties || []) {
      if (party.speakerId) {
        speakers.set(String(party.speakerId), {
          name: party.name || 'Unknown',
          email: party.emailAddress || ''
        });
      }
    }
    participantMap.set(String(call.metaData.id), speakers);
  }

  // 3. Find the target speaker ID per call (if speakerOnly)
  let targetSpeakerIds: Map<string, string> | undefined;
  if (args.speakerOnly && args.participantEmail) {
    targetSpeakerIds = new Map();
    const email = args.participantEmail.toLowerCase();
    for (const [callId, speakers] of participantMap) {
      for (const [sid, info] of speakers) {
        if (info.email.toLowerCase().includes(email)) {
          targetSpeakerIds.set(callId, sid);
          break;
        }
      }
    }
  }

  // 4. Retrieve transcripts in batches
  const callIds = calls.map(c => String(c.metaData.id));
  const transcripts = await gongClient.retrieveTranscripts(callIds);

  // 5. Search through transcripts
  const queryTerms = args.query.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
  const matches: TranscriptMatch[] = [];

  for (const t of transcripts) {
    const callId = String(t.callId);
    const call = calls.find(c => String(c.metaData.id) === callId);
    if (!call) continue;

    const speakers = participantMap.get(callId) || new Map();
    const targetSid = targetSpeakerIds?.get(callId);

    // Flatten all sentences
    const allSentences: Array<{ sid: string; text: string; start: number }> = [];
    for (const entry of t.transcript) {
      for (const s of entry.sentences) {
        allSentences.push({ sid: String(entry.speakerId), text: s.text, start: s.start });
      }
    }

    for (let i = 0; i < allSentences.length; i++) {
      const sent = allSentences[i];

      // If speakerOnly, skip sentences not from the target speaker
      if (targetSid && sent.sid !== targetSid) continue;

      const lowerText = sent.text.toLowerCase();
      const isMatch = queryTerms.every(term => lowerText.includes(term));
      if (!isMatch) continue;

      // Gather context
      const contextStart = Math.max(0, i - contextSize);
      const contextEnd = Math.min(allSentences.length - 1, i + contextSize);
      const contextLines: string[] = [];
      for (let j = contextStart; j <= contextEnd; j++) {
        const cs = allSentences[j];
        const speaker = speakers.get(cs.sid);
        const name = speaker?.name || `Speaker ${cs.sid}`;
        const prefix = j === i ? '>>> ' : '    ';
        const mins = Math.floor(cs.start / 60000);
        const secs = Math.floor((cs.start % 60000) / 1000);
        contextLines.push(`${prefix}[${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}] ${name}: ${cs.text}`);
      }

      const speaker = speakers.get(sent.sid);
      const mins = Math.floor(sent.start / 60000);
      const secs = Math.floor((sent.start % 60000) / 1000);

      matches.push({
        callId,
        callTitle: call.metaData.title,
        callUrl: call.metaData.url || `https://app.gong.io/call?id=${callId}`,
        callDate: call.metaData.started || call.metaData.scheduled || '',
        speakerName: speaker?.name || `Speaker ${sent.sid}`,
        speakerEmail: speaker?.email || '',
        timestampMs: sent.start,
        timestamp: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
        matchedText: sent.text,
        context: contextLines,
      });

      if (matches.length >= maxResults) break;
    }

    if (matches.length >= maxResults) break;
  }

  return matches;
}

// ---------- Server ----------

const server = new Server(
  { name: "gong-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    LIST_CALLS_TOOL,
    RETRIEVE_TRANSCRIPTS_TOOL,
    SEARCH_CALLS_TOOL,
    GET_CALL_DETAILS_TOOL,
    SEARCH_TRANSCRIPTS_TOOL,
    LIST_USERS_TOOL,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "list_calls": {
        if (!isListCallsArgs(args)) throw new Error("Invalid arguments for list_calls");
        const { fromDateTime, toDateTime } = args as { fromDateTime?: string; toDateTime?: string };
        const calls = await gongClient.listCalls(fromDateTime, toDateTime);
        return {
          content: [{ type: "text", text: JSON.stringify(calls, null, 2) }],
          isError: false,
        };
      }

      case "retrieve_transcripts": {
        if (!isRetrieveTranscriptsArgs(args)) throw new Error("Invalid arguments for retrieve_transcripts");
        const transcripts = await gongClient.retrieveTranscripts((args as { callIds: string[] }).callIds);
        return {
          content: [{ type: "text", text: JSON.stringify(transcripts, null, 2) }],
          isError: false,
        };
      }

      case "search_calls": {
        if (!isSearchCallsArgs(args)) throw new Error("Invalid arguments for search_calls");
        const calls = await gongClient.searchCalls(args as {
          fromDateTime?: string; toDateTime?: string;
          participantEmail?: string; callTitle?: string;
        });
        // Return a cleaner format
        const results = calls.map(c => ({
          id: c.metaData.id,
          title: c.metaData.title,
          date: c.metaData.started || c.metaData.scheduled,
          url: c.metaData.url,
          duration: c.metaData.duration,
          participants: (c.parties || []).map(p => ({
            name: p.name,
            email: p.emailAddress,
            speakerId: p.speakerId,
            affiliation: p.affiliation,
          })),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          isError: false,
        };
      }

      case "get_call_details": {
        if (!isGetCallDetailsArgs(args)) throw new Error("Invalid arguments for get_call_details");
        const call = await gongClient.getCallDetails((args as { callId: string }).callId);
        if (!call) {
          return {
            content: [{ type: "text", text: "Call not found" }],
            isError: false,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(call, null, 2) }],
          isError: false,
        };
      }

      case "search_transcripts": {
        if (!isSearchTranscriptsArgs(args)) throw new Error("Invalid arguments for search_transcripts");
        const matches = await searchTranscriptsImpl(args as {
          query: string; fromDateTime?: string; toDateTime?: string;
          participantEmail?: string; speakerOnly?: boolean;
          contextSentences?: number; maxResults?: number;
        });

        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: "No matches found." }],
            isError: false,
          };
        }

        // Format results readably
        const formatted = matches.map((m, i) => {
          return [
            `--- Match ${i + 1} ---`,
            `Call: ${m.callTitle}`,
            `Date: ${m.callDate}`,
            `Link: ${m.callUrl}`,
            `Speaker: ${m.speakerName} (${m.speakerEmail})`,
            `Time: ${m.timestamp}`,
            '',
            ...m.context,
            '',
          ].join('\n');
        });

        return {
          content: [{ type: "text", text: formatted.join('\n') }],
          isError: false,
        };
      }

      case "list_users": {
        const users = await gongClient.listUsers();
        const formatted = users.map(u => ({
          id: u.id,
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          email: u.emailAddress,
          title: u.title,
          active: u.active,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
          isError: false,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const axiosErr = error as AxiosError;
    const status = axiosErr.response?.status;
    const detail = status ? ` (HTTP ${status})` : '';
    return {
      content: [{ type: "text", text: `Error${detail}: ${message}` }],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
