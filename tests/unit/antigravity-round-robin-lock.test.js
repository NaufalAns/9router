import { describe, it, expect, vi } from "vitest";
import { isModelLockActive, buildModelLockUpdate } from "open-sse/services/accountFallback.js";
import { AntigravityExecutor } from "open-sse/executors/antigravity.js";

const { updatedDb } = vi.hoisted(() => ({
  updatedDb: {}
}));

vi.mock("@/lib/localDb", () => ({
  updateProviderConnection: vi.fn(async (id, data) => {
    Object.assign(updatedDb, data);
  }),
  getProviderConnections: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(async () => null),
}));

describe("antigravity round-robin per-model quota skipping", () => {
  const ag = new AntigravityExecutor();

  it("extracts exact reset timestamp for 429 quota exhaustion", () => {
    const now = Date.now();
    const errorBody = {
      error: {
        code: 429,
        message: "Your quota will reset after 2h7m23s"
      }
    };
    const response = {
      status: 429,
      headers: { get: () => null }
    };

    const parsed = ag.parseError(response, JSON.stringify(errorBody));
    const expectedDelayMs = (2 * 3600 + 7 * 60 + 23) * 1000;
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(now + expectedDelayMs - 1000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(now + expectedDelayMs + 2000);
  });

  it("locks only the exhausted model on the limited account while keeping other models available", () => {
    const cooldownMs = 2 * 3600 * 1000; // 2 hours
    const lockUpdate = buildModelLockUpdate("gemini-3.6-flash-high", cooldownMs);

    const account1 = {
      id: "acc-1",
      name: "Account 1",
      ...lockUpdate
    };

    const account2 = {
      id: "acc-2",
      name: "Account 2"
    };

    const account3 = {
      id: "acc-3",
      name: "Account 3"
    };

    const allAccounts = [account1, account2, account3];

    // For gemini-3.6-flash-high, account1 is modelLocked and filtered out
    const availableFor36Flash = allAccounts.filter(c => !isModelLockActive(c, "gemini-3.6-flash-high"));
    expect(availableFor36Flash.map(a => a.id)).toEqual(["acc-2", "acc-3"]);

    // For gemini-3.7-flash-high, account1 is NOT locked and remains available
    const availableFor37Flash = allAccounts.filter(c => !isModelLockActive(c, "gemini-3.7-flash-high"));
    expect(availableFor37Flash.map(a => a.id)).toEqual(["acc-1", "acc-2", "acc-3"]);

    // For claude-sonnet-4-6, account1 is NOT locked
    const availableForClaude = allAccounts.filter(c => !isModelLockActive(c, "claude-sonnet-4-6"));
    expect(availableForClaude.map(a => a.id)).toEqual(["acc-1", "acc-2", "acc-3"]);
  });

  it("vetoes in-flight retry on quota errors so round-robin fallback triggers without delay", async () => {
    const res = (status, msg) => ({
      status,
      headers: { get: () => null },
      clone: () => ({ text: async () => JSON.stringify({ error: { message: msg } }) })
    });

    // Quota exhaustion -> computeRetryDelay returns false (no 14s retry loop)
    expect(await ag.computeRetryDelay(res(429, "Your quota will reset after 2h7m23s"), 1)).toBe(false);
    expect(await ag.computeRetryDelay(res(429, "Quota exceeded for quota metric 'Queries'"), 1)).toBe(false);
    expect(await ag.computeRetryDelay(res(429, "Resource has been exhausted (e.g. check quota)."), 1)).toBe(false);
    expect(await ag.computeRetryDelay(res(429, '{"code":429,"message":"Resource has been exhausted","details":[{"reason":"INSUFFICIENT_G1_CREDITS_BALANCE"}]}'), 1)).toBe(false);
  });

  it("syncUsageQuotaLocks writes multi-day resetAt locks into DB for exhausted models (0% remaining)", async () => {
    const { syncUsageQuotaLocks } = await import("@/sse/services/quotaLockSync.js");

    const usage = {
      quotas: {
        "gemini-3.7-flash-high": {
          used: 1000,
          total: 1000,
          remainingPercentage: 0,
          resetAt: "2026-08-22T22:13:00.000Z"
        },
        "gemini-3.6-flash-high": {
          used: 1000,
          total: 1000,
          remainingPercentage: 0,
          resetAt: "2026-08-22T22:13:00.000Z"
        },
        "claude-sonnet-4-6": {
          used: 0,
          total: 1000,
          remainingPercentage: 100,
          resetAt: "2026-08-24T12:00:00.000Z"
        }
      }
    };

    await syncUsageQuotaLocks("acc-cheat", usage);

    // Gemini models locked until 2026-08-22T22:13:00.000Z (~5 days in future)
    expect(updatedDb["modelLock_gemini-3.7-flash-high"]).toBe("2026-08-22T22:13:00.000Z");
    expect(updatedDb["modelLock_gemini-3.6-flash-high"]).toBe("2026-08-22T22:13:00.000Z");

    // Claude model has 100% quota -> modelLock is explicitly cleared (null)
    expect(updatedDb["modelLock_claude-sonnet-4-6"]).toBe(null);

    // Verify isModelLockActive behavior on the updated record
    const record = { id: "acc-cheat", ...updatedDb };
    expect(isModelLockActive(record, "gemini-3.7-flash-high")).toBe(true);
    expect(isModelLockActive(record, "gemini-3.6-flash-high")).toBe(true);
    expect(isModelLockActive(record, "claude-sonnet-4-6")).toBe(false);
  });
});
