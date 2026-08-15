import { describe, it, expect, vi, beforeEach } from "vitest";
import { isModelLockActive, buildModelLockUpdate } from "open-sse/services/accountFallback.js";
import { AntigravityExecutor } from "open-sse/executors/antigravity.js";

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
  });
});
