// Guards D3: antigravity 429/503 retry merged into base via computeRetryDelay hook.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";

const MAX = 10000;
function res(status, headers = {}, body = null) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => (body == null ? "" : JSON.stringify(body)) }),
  };
}

describe("antigravity computeRetryDelay hook (D3)", () => {
  const ag = new AntigravityExecutor();

  it("uses Retry-After header (seconds → ms) when within cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "5" }), 1)).toBe(5000);
  });

  it("vetoes (false) when Retry-After exceeds cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "60" }), 1)).toBe(false);
  });

  it("parses retry time from error body when no header", async () => {
    const r = res(429, {}, { error: { message: "quota will reset after 3s" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(3000);
  });

  it("exponential backoff for 429 when no retry info", async () => {
    expect(await ag.computeRetryDelay(res(429), 1)).toBe(Math.min(1000 * 2 ** 1, MAX));
    expect(await ag.computeRetryDelay(res(429), 3)).toBe(Math.min(1000 * 2 ** 3, MAX));
  });

  it("503 without retry info → transient backoff", async () => {
    expect(await ag.computeRetryDelay(res(503), 1)).toBe(2000);
  });

  it("retries Antigravity agent terminated body even when status is not 429", async () => {
    const r = res(500, {}, { error: { message: "Agent execution terminated due to error" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(2000);
  });

  it("retries high traffic body", async () => {
    const r = res(500, {}, { error: { message: "Our servers are experiencing high traffic" } });
    expect(await ag.computeRetryDelay(r, 2)).toBe(4000);
  });

  it("vetoes (false) when error message contains quota exhaustion to avoid hanging on limited account", async () => {
    const r1 = res(429, {}, { error: { message: "Quota exceeded for quota metric 'Queries' of service 'daily-cloudcode-pa.googleapis.com'" } });
    expect(await ag.computeRetryDelay(r1, 1)).toBe(false);

    const r2 = res(429, {}, { error: { message: "Resource has been exhausted (e.g. check quota)." } });
    expect(await ag.computeRetryDelay(r2, 1)).toBe(false);
  });

  it("parseError extracts precise resetsAtMs from reset after string with spaces", () => {
    const now = Date.now();
    const r = res(429, {}, { error: { message: "Your quota will reset after 2h 7m 23s" } });
    const parsed = ag.parseError(r, JSON.stringify({ error: { message: "Your quota will reset after 2h 7m 23s" } }));
    const expectedMs = (2 * 3600 + 7 * 60 + 23) * 1000;
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(now + expectedMs - 1000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(now + expectedMs + 2000);
  });

  it("parseError extracts precise resetsAtMs from Google RPC RetryInfo", () => {
    const now = Date.now();
    const body = {
      error: {
        code: 429,
        message: "Resource exhausted",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "120s"
          }
        ]
      }
    };
    const r = res(429, {}, body);
    const parsed = ag.parseError(r, JSON.stringify(body));
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(now + 120000 - 1000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(now + 120000 + 2000);
  });

  it("does not retry non-transient 400 errors", async () => {
    const r = res(400, {}, { error: { message: "Invalid request" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("deduplicates sanitized tool names", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [
          { name: "read/file", parameters: { type: "object", properties: {} } },
          { name: "read file", parameters: { type: "object", properties: {} } },
          { name: "read/file", parameters: { type: "object", properties: {} } },
        ] }],
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.request.tools[0].functionDeclarations.map(fn => fn.name)).toEqual(["read_file"]);
  });

  it("registry uses the daily IDE cloudcode host and user agent", () => {
    expect(antigravity.transport.baseUrls).toEqual(["https://daily-cloudcode-pa.googleapis.com"]);
    expect(antigravity.transport.headers["User-Agent"]).toBe("antigravity/ide/2.11.0 darwin/arm64");
  });

  it("buildHeaders matches official IDE stream headers", () => {
    ag._lastSessionId = "sess-123";
    const h = ag.buildHeaders({ accessToken: "tok" }, true);
    expect(h["User-Agent"]).toBe("antigravity/ide/2.11.0 darwin/arm64");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h).not.toHaveProperty("X-Machine-Session-Id");
    expect(h).not.toHaveProperty("x-request-source");
    expect(h).not.toHaveProperty("Accept");
  });

  it("transforms chat requests with official IDE requestId shape and 64000 token cap", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
        generationConfig: { maxOutputTokens: 90000 },
        sessionId: "-3750763034362895579",
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d{13}\/[0-9a-f-]{36}\/\d+$/);
    expect(out.request.generationConfig.maxOutputTokens).toBe(64000);
  });
});
