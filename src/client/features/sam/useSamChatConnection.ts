import { useChat } from "@ai-sdk/react";
import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import { DefaultChatTransport, validateUIMessages, type UIMessage } from "ai";
import { useEffect, useState } from "react";
import { isNodeRuntime } from "@/lib/client-config";

// The SAM conversation's connection. On Workers it's the Agents SDK
// WebSocket to the SamChatAgent Durable Object; on the Node runtime it's plain
// HTTP streaming to the same /agents/sam-chat/<session>/... paths (spec 0023).
// Both return the same shape, so SamConversation doesn't care which it got.

// SAM streams dense tool-input deltas; unthrottled per-chunk store fanout
// re-renders the transcript per delta and trips React #185 (cloudflare/agents#1361).
const THROTTLE_MS = 50;

function useAgentConnection(sessionId: string) {
  const agent = useAgent({ agent: "sam-chat", name: sessionId });
  const chat = useAgentChat({ agent, experimental_throttle: THROTTLE_MS });
  return {
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    setMessages: chat.setMessages,
    clearHistory: chat.clearHistory,
    status: chat.status,
    stop: chat.stop,
    // The DO is settling a turn a reset interrupted; nothing can be sent
    // until that lands.
    isRecovering: chat.isRecovering,
    connectionError: chat.connectionError,
    // `identified` is false before the first connect and while reconnecting.
    identified: agent.identified,
    reconnect: () => agent.reconnect(),
  };
}

type SamChatConnection = ReturnType<typeof useAgentConnection>;

/** The stored transcript; empty when it can't be read. */
async function loadHistory(sessionId: string): Promise<UIMessage[]> {
  try {
    const response = await fetch(`/agents/sam-chat/${sessionId}/get-messages`);
    if (!response.ok) return [];
    const data: unknown = await response.json();
    return Array.isArray(data) && data.length > 0
      ? await validateUIMessages({ messages: data })
      : [];
  } catch {
    return [];
  }
}

function useHttpConnection(sessionId: string): SamChatConnection {
  const chat = useChat({
    id: sessionId,
    experimental_throttle: THROTTLE_MS,
    transport: new DefaultChatTransport({
      api: `/agents/sam-chat/${sessionId}/chat`,
      // The server keeps the transcript; it only needs the new message.
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages: messages.slice(-1) },
      }),
    }),
  });
  const { setMessages } = chat;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadHistory(sessionId)
      .then((history) => {
        if (!cancelled) setMessages(history);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, setMessages]);

  return {
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    setMessages: chat.setMessages,
    // Local only: the HTTP transport has no clear-history endpoint.
    clearHistory: () => chat.setMessages([]),
    status: chat.status,
    stop: chat.stop,
    isRecovering: false,
    connectionError: null,
    // Plain HTTP has no connection to lose; "identified" once history loaded.
    identified: loaded,
    reconnect: () => undefined,
  };
}

export const useSamChatConnection: (sessionId: string) => SamChatConnection =
  isNodeRuntime() ? useHttpConnection : useAgentConnection;
