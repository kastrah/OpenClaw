import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveSessionResetPolicy,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";

/**
 * Default input-token ceiling for cron sessions. When a session's
 * `inputTokens` exceeds this value the next run will start a fresh
 * session instead of reusing the bloated one.
 */
export const DEFAULT_MAX_SESSION_INPUT_TOKENS = 150_000;

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
  /** Override the token-based rotation threshold. 0 disables. */
  maxInputTokens?: number;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  // Check if we can reuse an existing session
  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;

  if (!params.forceNew && entry?.sessionId) {
    // Evaluate freshness using the configured reset policy
    // Cron/webhook sessions use "direct" reset type (1:1 conversation style)
    const resetPolicy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: "direct",
    });
    const freshness = evaluateSessionFreshness({
      updatedAt: entry.updatedAt,
      now: params.nowMs,
      policy: resetPolicy,
    });

    if (freshness.fresh) {
      // Token-based rotation: force a new session when the last run's input
      // tokens exceeded the configured ceiling. This prevents context
      // accumulation from causing repeated timeouts across cron runs.
      const maxInputTokens = params.maxInputTokens ?? DEFAULT_MAX_SESSION_INPUT_TOKENS;
      const entryInputTokens = entry.inputTokens ?? 0;

      if (maxInputTokens > 0 && entryInputTokens > maxInputTokens) {
        // Context too large — rotate to fresh session
        sessionId = crypto.randomUUID();
        isNewSession = true;
        systemSent = false;
      } else if (entry.abortedLastRun) {
        // Last run was aborted or timed out — rotate so the next run starts
        // with a clean context instead of replaying the bloated conversation.
        sessionId = crypto.randomUUID();
        isNewSession = true;
        systemSent = false;
      } else {
        // Reuse existing session
        sessionId = entry.sessionId;
        isNewSession = false;
        systemSent = entry.systemSent ?? false;
      }
    } else {
      // Session expired, create new
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }
  } else {
    // No existing session or forced new
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId: isNewSession ? entry?.sessionId : undefined,
  });

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...entry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    // When starting a fresh session (forceNew / isolated), clear delivery routing
    // state inherited from prior sessions. Without this, lastThreadId leaks into
    // the new session and causes announce-mode cron deliveries to post as thread
    // replies instead of channel top-level messages.
    // deliveryContext must also be cleared because normalizeSessionEntryDelivery
    // repopulates lastThreadId from deliveryContext.threadId on store writes.
    ...(isNewSession && {
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
      deliveryContext: undefined,
    }),
    // Clear the abort flag when rotating to avoid a perpetual rotation loop.
    ...(isNewSession ? { abortedLastRun: false } : {}),
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession };
}
