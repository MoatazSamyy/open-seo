# 0023 — SAM on Node

## Status

Proposed (October 2026), fork milestone 3f. Experimental, Node runtime only.

## Context

SAM, the in-app agent, is `SamChatAgent`, a Cloudflare Agents SDK (`Think`)
Durable Object: one per chat session, holding the transcript in its SQLite,
streaming over a WebSocket, and handling compaction and recovery of turns a
reset interrupted. The SDK also relies on Durable Object facets,
`ctx.exports`, `transactionSync`, and Workers WebSocket hibernation. Node has
none of these, and emulating them would tie the Node runtime to SDK
internals that change between releases.

## Decision

1. **A separate, small chat path for Node.** `samNodeChat.ts` runs a SAM turn
   with the AI SDK's `streamText` and streams it back as an AI SDK UI message
   stream over plain HTTP. Transcripts are stored in `sam_node_messages`, one
   row per message in order, declared for both dialects.
2. **Shared, not copied.** The system prompt, project-memory block, MCP
   toolset, step and token limits, session context, auth context, and session
   titling moved from `SamChatAgent` into `samSession.ts`, which both
   runtimes use. Skills are the same source: a catalog in the system prompt
   and a `load_skill` tool on Node, Think's skill registry on Workers.
3. **Same URLs, different transport.** Node serves `get-messages`, `rewind`,
   and `chat` under `/agents/sam-chat/<session>/`, the paths the Workers agent
   uses, after the same session authorization (`samChatAccess.ts`). On the
   client, `useSamChatConnection` returns one shape from either the Agents SDK
   hooks (Workers) or the AI SDK's `useChat` (Node), picked once from the
   runtime the server reports.
4. **The server owns the transcript.** The client sends only its new message;
   the server appends it to the stored history, saves it before the turn,
   and saves the finished transcript after. Failed turns don't store their
   empty reply. A rewind stops the session's in-flight turn before deleting.
5. **Left out on Node.** Billing (Node never runs hosted mode); between-turn
   compaction, replaced by pruning tool calls older than the last four
   messages from what the model sees; and recovery of a turn the process died
   during, which the user resends.

## Alternatives considered

- **Emulate Durable Objects and WebSockets so `SamChatAgent` runs unchanged.**
  One implementation, but it would mean emulating facets, `ctx.exports`,
  `WebSocketPair`, and hibernation, with every Agents SDK upgrade a risk.
- **Move Workers SAM onto the HTTP path too.** Rejected for now: it would drop
  Think's compaction and recovery for hosted users.

## Consequences

- SAM works on Node with an OpenRouter key.
- Two chat transports exist; behavior that matters for both belongs in
  `samSession.ts`.
- Very long Node chats grow without summarization, and older tool results
  leave the model's view.
