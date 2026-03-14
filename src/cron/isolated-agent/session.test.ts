import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
  resolveSessionResetPolicy: vi.fn().mockReturnValue({ mode: "idle", idleMinutes: 60 }),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: vi.fn(),
  clearBootstrapSnapshotOnSessionRollover: vi.fn(({ sessionKey, previousSessionId }) => {
    if (sessionKey && previousSessionId) {
      clearBootstrapSnapshot(sessionKey);
    }
  }),
}));

import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { loadSessionStore, evaluateSessionFreshness } from "../../config/sessions.js";
import { resolveCronSession, DEFAULT_MAX_SESSION_INPUT_TOKENS } from "./session.js";

const NOW_MS = 1_737_600_000_000;

type SessionStore = ReturnType<typeof loadSessionStore>;
type SessionStoreEntry = SessionStore[string];
type MockSessionStoreEntry = Partial<SessionStoreEntry>;

function resolveWithStoredEntry(params?: {
  sessionKey?: string;
  entry?: MockSessionStoreEntry;
  forceNew?: boolean;
  fresh?: boolean;
  maxInputTokens?: number;
}) {
  const sessionKey = params?.sessionKey ?? "webhook:stable-key";
  const store: SessionStore = params?.entry
    ? ({ [sessionKey]: params.entry as SessionStoreEntry } as SessionStore)
    : {};
  vi.mocked(loadSessionStore).mockReturnValue(store);
  vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: params?.fresh ?? true });

  return resolveCronSession({
    cfg: {} as OpenClawConfig,
    sessionKey,
    agentId: "main",
    nowMs: NOW_MS,
    forceNew: params?.forceNew,
    maxInputTokens: params?.maxInputTokens,
  });
}

describe("resolveCronSession", () => {
  beforeEach(() => {
    vi.mocked(clearBootstrapSnapshot).mockReset();
  });

  it("preserves modelOverride and providerOverride from existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        modelOverride: "deepseek-v3-4bit-mlx",
        providerOverride: "inferencer",
        thinkingLevel: "high",
        model: "k2p5",
      },
    });

    expect(result.sessionEntry.modelOverride).toBe("deepseek-v3-4bit-mlx");
    expect(result.sessionEntry.providerOverride).toBe("inferencer");
    expect(result.sessionEntry.thinkingLevel).toBe("high");
    // The model field (last-used model) should also be preserved
    expect(result.sessionEntry.model).toBe("k2p5");
  });

  it("handles missing modelOverride gracefully", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        model: "claude-opus-4-5",
      },
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
  });

  it("handles no existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:new-job",
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
    expect(result.sessionEntry.model).toBeUndefined();
    expect(result.isNewSession).toBe(true);
  });

  // New tests for session reuse behavior (#18027)
  describe("session reuse for webhooks/cron", () => {
    it("reuses existing sessionId when session is fresh", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-123",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("existing-session-id-123");
      expect(result.isNewSession).toBe(false);
      expect(result.systemSent).toBe(true);
      expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
    });

    it("creates new sessionId when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000, // 1 day ago
          systemSent: true,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
          sendPolicy: "allow",
        },
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
      expect(result.sessionEntry.sendPolicy).toBe("allow");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("creates new sessionId when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-456",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("existing-session-id-456");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("clears delivery routing metadata and deliveryContext when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-789",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastAccountId: "acct-123",
          lastThreadId: "1737500000.123456",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.123456",
          },
          modelOverride: "gpt-5.2",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.isNewSession).toBe(true);
      // Delivery routing state must be cleared to prevent thread leaking.
      // deliveryContext must also be cleared because normalizeSessionEntryDelivery
      // repopulates lastThreadId from deliveryContext.threadId on store writes.
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
      // Per-session overrides must be preserved
      expect(result.sessionEntry.modelOverride).toBe("gpt-5.2");
    });

    it("clears delivery routing metadata when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastThreadId: "1737500000.999999",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.999999",
          },
        },
        fresh: false,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
    });

    it("preserves delivery routing metadata when reusing fresh session", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-101",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastThreadId: "1737500000.123456",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.123456",
          },
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionEntry.lastChannel).toBe("slack");
      expect(result.sessionEntry.lastTo).toBe("channel:C0XXXXXXXXX");
      expect(result.sessionEntry.lastThreadId).toBe("1737500000.123456");
      expect(result.sessionEntry.deliveryContext).toEqual({
        channel: "slack",
        to: "channel:C0XXXXXXXXX",
        threadId: "1737500000.123456",
      });
    });

    it("creates new sessionId when entry exists but has no sessionId", () => {
      const result = resolveWithStoredEntry({
        entry: {
          updatedAt: NOW_MS - 1000,
          modelOverride: "some-model",
        },
      });

      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.isNewSession).toBe(true);
      // Should still preserve other fields from entry
      expect(result.sessionEntry.modelOverride).toBe("some-model");
    });
  });

  describe("token-based session rotation", () => {
    it("forces new session when inputTokens exceeds default threshold", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "bloated-session",
          updatedAt: NOW_MS - 1000,
          inputTokens: DEFAULT_MAX_SESSION_INPUT_TOKENS + 1,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("bloated-session");
      expect(result.isNewSession).toBe(true);
    });

    it("preserves session when inputTokens is below default threshold", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "healthy-session",
          updatedAt: NOW_MS - 1000,
          inputTokens: DEFAULT_MAX_SESSION_INPUT_TOKENS - 1,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("healthy-session");
      expect(result.isNewSession).toBe(false);
    });

    it("respects custom maxInputTokens override", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "custom-threshold-session",
          updatedAt: NOW_MS - 1000,
          inputTokens: 50_001,
        },
        fresh: true,
        maxInputTokens: 50_000,
      });

      expect(result.sessionEntry.sessionId).not.toBe("custom-threshold-session");
      expect(result.isNewSession).toBe(true);
    });

    it("disables token rotation when maxInputTokens is 0", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "large-but-allowed",
          updatedAt: NOW_MS - 1000,
          inputTokens: 999_999,
        },
        fresh: true,
        maxInputTokens: 0,
      });

      expect(result.sessionEntry.sessionId).toBe("large-but-allowed");
      expect(result.isNewSession).toBe(false);
    });

    it("preserves per-session overrides when rotating due to tokens", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "bloated-with-overrides",
          updatedAt: NOW_MS - 1000,
          inputTokens: DEFAULT_MAX_SESSION_INPUT_TOKENS + 50_000,
          modelOverride: "custom-model",
          providerOverride: "custom-provider",
          sendPolicy: "allow",
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.modelOverride).toBe("custom-model");
      expect(result.sessionEntry.providerOverride).toBe("custom-provider");
      expect(result.sessionEntry.sendPolicy).toBe("allow");
    });
  });

  describe("abort-based session rotation", () => {
    it("forces new session when abortedLastRun is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "aborted-session",
          updatedAt: NOW_MS - 1000,
          abortedLastRun: true,
          inputTokens: 10_000, // below token threshold
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("aborted-session");
      expect(result.isNewSession).toBe(true);
    });

    it("clears abortedLastRun flag after rotation", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "aborted-session",
          updatedAt: NOW_MS - 1000,
          abortedLastRun: true,
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.abortedLastRun).toBe(false);
    });

    it("clears abortedLastRun flag on token-based rotation too", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "bloated-and-aborted",
          updatedAt: NOW_MS - 1000,
          abortedLastRun: true,
          inputTokens: DEFAULT_MAX_SESSION_INPUT_TOKENS + 1,
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.abortedLastRun).toBe(false);
    });

    it("does not rotate when abortedLastRun is false", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "normal-session",
          updatedAt: NOW_MS - 1000,
          abortedLastRun: false,
          inputTokens: 10_000,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("normal-session");
      expect(result.isNewSession).toBe(false);
    });

    it("preserves per-session overrides when rotating due to abort", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "aborted-with-overrides",
          updatedAt: NOW_MS - 1000,
          abortedLastRun: true,
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
    });
  });
});
