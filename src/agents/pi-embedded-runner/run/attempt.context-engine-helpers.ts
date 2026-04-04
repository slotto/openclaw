import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../../context-engine/types.js";
import { estimateMessagesTokens } from "../../compaction.js";
import { deriveSessionTotalTokens } from "../../../agents/usage.js";

/**
 * Extract participants (agents + humans) from a session key.
 * Format: agent:agentId:provider:chatType:channelOrUserId[:thread:threadId]
 * 
 * Returns array of participant IDs:
 * - For channels: [agentId] (TODO: query runtime for other agents in channel)
 * - For DMs: [agentId, userId]
 * - For groups: [agentId] (TODO: extract group members)
 */
function extractParticipantsFromSessionKey(sessionKey?: string): string[] {
  if (!sessionKey) {
    return [];
  }

  const parts = sessionKey.split(':');
  if (parts.length < 2 || parts[0] !== 'agent') {
    return [];
  }

  const agentId = parts[1]; // e.g., "main", "nova"
  const participants = [agentId];

  // For direct messages, extract the user ID
  // Format: agent:agentId:provider:direct:userId
  if (parts.length >= 5 && parts[3] === 'direct') {
    const userId = parts[4];
    if (userId && userId !== agentId) {
      participants.push(userId);
    }
  }

  // TODO: For channels/groups, query runtime to get all agents with sessions for this channel
  // TODO: Query messaging provider API to get human members

  return participants;
}

export type AttemptContextEngine = ContextEngine;

export async function runAttemptContextEngineBootstrap(params: {
  hadSessionFile: boolean;
  contextEngine?: AttemptContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  sessionManager: unknown;
  runtimeContext?: ContextEngineRuntimeContext;
  runMaintenance: (params: {
    contextEngine?: unknown;
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    reason: "bootstrap";
    sessionManager: unknown;
    runtimeContext?: ContextEngineRuntimeContext;
  }) => Promise<unknown>;
  warn: (message: string) => void;
}) {
  if (
    !params.hadSessionFile ||
    !(params.contextEngine?.bootstrap || params.contextEngine?.maintain)
  ) {
    return;
  }
  try {
    if (typeof params.contextEngine?.bootstrap === "function") {
      await params.contextEngine.bootstrap({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
      });
    }
    await params.runMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: "bootstrap",
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
    });
  } catch (bootstrapErr) {
    params.warn(`context engine bootstrap failed: ${String(bootstrapErr)}`);
  }
}

export async function assembleAttemptContextEngine(params: {
  contextEngine?: AttemptContextEngine;
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  tokenBudget?: number;
  modelId: string;
  prompt?: string;
}) {
  if (!params.contextEngine) {
    return undefined;
  }
  return await params.contextEngine.assemble({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    messages: params.messages,
    tokenBudget: params.tokenBudget,
    model: params.modelId,
    ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
  });
}

export async function finalizeAttemptContextEngineTurn(params: {
  contextEngine?: AttemptContextEngine;
  promptError: boolean;
  aborted: boolean;
  yieldAborted: boolean;
  sessionIdUsed: string;
  sessionKey?: string;
  sessionFile: string;
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  tokenBudget?: number;
  runtimeContext?: ContextEngineRuntimeContext;
  runMaintenance: (params: {
    contextEngine?: unknown;
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    reason: "turn";
    sessionManager: unknown;
    runtimeContext?: ContextEngineRuntimeContext;
  }) => Promise<unknown>;
  sessionManager: unknown;
  warn: (message: string) => void;
}) {
  if (!params.contextEngine) {
    return { postTurnFinalizationSucceeded: true };
  }

  let postTurnFinalizationSucceeded = true;

  if (typeof params.contextEngine.afterTurn === "function") {
    try {
      // Extract actual prompt token count from last assistant message's usage
      let currentTokenCount = estimateMessagesTokens(params.messagesSnapshot);
      
      // Find the last assistant message with usage data
      for (let i = params.messagesSnapshot.length - 1; i >= 0; i--) {
        const msg = params.messagesSnapshot[i];
        if (msg.role === 'assistant' && msg.usage) {
          const derived = deriveSessionTotalTokens({ usage: msg.usage as any });
          if (typeof derived === 'number') {
            currentTokenCount = derived;
            break;
          }
        }
      }

      // Extract participants for cross-channel continuity
      const participants = extractParticipantsFromSessionKey(params.sessionKey);

      await params.contextEngine.afterTurn({
        sessionId: params.sessionIdUsed,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        messages: params.messagesSnapshot,
        prePromptMessageCount: params.prePromptMessageCount,
        tokenBudget: params.tokenBudget,
        participants,
        runtimeContext: {
          ...params.runtimeContext,
          currentTokenCount,
        },
      });
    } catch (afterTurnErr) {
      postTurnFinalizationSucceeded = false;
      params.warn(`context engine afterTurn failed: ${String(afterTurnErr)}`);
    }
  } else {
    const newMessages = params.messagesSnapshot.slice(params.prePromptMessageCount);
    if (newMessages.length > 0) {
      if (typeof params.contextEngine.ingestBatch === "function") {
        try {
          await params.contextEngine.ingestBatch({
            sessionId: params.sessionIdUsed,
            sessionKey: params.sessionKey,
            messages: newMessages,
          });
        } catch (ingestErr) {
          postTurnFinalizationSucceeded = false;
          params.warn(`context engine ingest failed: ${String(ingestErr)}`);
        }
      } else {
        for (const msg of newMessages) {
          try {
            await params.contextEngine.ingest?.({
              sessionId: params.sessionIdUsed,
              sessionKey: params.sessionKey,
              message: msg,
            });
          } catch (ingestErr) {
            postTurnFinalizationSucceeded = false;
            params.warn(`context engine ingest failed: ${String(ingestErr)}`);
          }
        }
      }
    }
  }

  if (
    !params.promptError &&
    !params.aborted &&
    !params.yieldAborted &&
    postTurnFinalizationSucceeded
  ) {
    await params.runMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionIdUsed,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: "turn",
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
    });
  }

  return { postTurnFinalizationSucceeded };
}
