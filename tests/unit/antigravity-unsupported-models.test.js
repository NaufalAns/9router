import { describe, it, expect, vi, beforeEach } from "vitest";
import { isUnsupportedModelError, markAccountUnavailable, getProviderCredentials } from "@/sse/services/auth.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getAccountCombos: vi.fn(async () => []),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  getAccountCombos: mocks.getAccountCombos,
  validateApiKey: vi.fn(),
}));

describe("Antigravity unsupported models handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.getProxyPools.mockResolvedValue([]);
  });

  describe("isUnsupportedModelError", () => {
    it("detects 'Thinking level MINIMAL is not supported for this model' error on Antigravity", () => {
      const errorMsg = '[400]: Thinking level MINIMAL is not supported for this model. Please retry with other thinking level. {"code":400,"message":"Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.","status":"INVALID_ARGUMENT"}';
      expect(isUnsupportedModelError("antigravity", 400, errorMsg)).toBe(true);
      expect(isUnsupportedModelError("ag", 400, errorMsg)).toBe(true);
    });

    it("detects generic 'not supported for this model' on Antigravity", () => {
      expect(isUnsupportedModelError("antigravity", 400, "Model is not supported for this account/project")).toBe(true);
      expect(isUnsupportedModelError("antigravity", 400, "not supported for this model")).toBe(true);
      expect(isUnsupportedModelError("antigravity", 400, "model not supported")).toBe(true);
    });

    it("returns false for regular rate-limit or transient errors", () => {
      expect(isUnsupportedModelError("antigravity", 429, "Resource exhausted: quota exceeded")).toBe(false);
      expect(isUnsupportedModelError("antigravity", 500, "Internal server error")).toBe(false);
      expect(isUnsupportedModelError("antigravity", 401, "Invalid token")).toBe(false);
    });

    it("returns false for non-antigravity providers unless supported", () => {
      const errorMsg = "Thinking level MINIMAL is not supported for this model.";
      expect(isUnsupportedModelError("openai", 400, errorMsg)).toBe(false);
    });
  });

  describe("markAccountUnavailable with unsupported model", () => {
    it("records unsupported model on connection and triggers fallback immediately", async () => {
      const mockConn = {
        id: "conn-1",
        name: "akoenbertiga@gmail.com",
        unsupportedModels: [],
      };
      mocks.getProviderConnections.mockResolvedValue([mockConn]);
      mocks.updateProviderConnection.mockResolvedValue({});

      const errorText = 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.';
      const res = await markAccountUnavailable("conn-1", 400, errorText, "antigravity", "gemini-3.8-flash-high");

      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBe(0);
      expect(mocks.updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
        unsupportedModels: ["gemini-3.8-flash-high"],
        errorCode: 400,
      }));
    });

    it("strips thinking suffix when saving to unsupportedModels", async () => {
      const mockConn = {
        id: "conn-2",
        name: "test@gmail.com",
        unsupportedModels: ["gemini-4-argon-high"],
      };
      mocks.getProviderConnections.mockResolvedValue([mockConn]);
      mocks.updateProviderConnection.mockResolvedValue({});

      const errorText = 'Thinking level MINIMAL is not supported for this model.';
      const res = await markAccountUnavailable("conn-2", 400, errorText, "antigravity", "gemini-3.8-flash-high(high)");

      expect(res.shouldFallback).toBe(true);
      expect(mocks.updateProviderConnection).toHaveBeenCalledWith("conn-2", expect.objectContaining({
        unsupportedModels: ["gemini-4-argon-high", "gemini-3.8-flash-high"],
      }));
    });

    it("does not duplicate model if already present in unsupportedModels", async () => {
      const mockConn = {
        id: "conn-3",
        name: "test@gmail.com",
        unsupportedModels: ["gemini-3.8-flash-high"],
      };
      mocks.getProviderConnections.mockResolvedValue([mockConn]);

      const errorText = 'Thinking level MINIMAL is not supported for this model.';
      const res = await markAccountUnavailable("conn-3", 400, errorText, "antigravity", "gemini-3.8-flash-high");

      expect(res.shouldFallback).toBe(true);
      expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    });
  });

  describe("getProviderCredentials filtering", () => {
    it("skips accounts that have the requested model in unsupportedModels", async () => {
      const conn1 = {
        id: "acc-1",
        name: "Account 1",
        priority: 1,
        unsupportedModels: ["gemini-3.8-flash-high"],
      };
      const conn2 = {
        id: "acc-2",
        name: "Account 2",
        priority: 2,
        unsupportedModels: [],
      };
      mocks.getProviderConnections.mockResolvedValue([conn1, conn2]);

      const creds = await getProviderCredentials("antigravity", null, "gemini-3.8-flash-high");

      expect(creds).not.toBeNull();
      expect(creds.connectionId).toBe("acc-2");
    });

    it("matches models even if requested with a thinking suffix", async () => {
      const conn1 = {
        id: "acc-1",
        name: "Account 1",
        priority: 1,
        unsupportedModels: ["gemini-3.8-flash-high"],
      };
      const conn2 = {
        id: "acc-2",
        name: "Account 2",
        priority: 2,
        unsupportedModels: [],
      };
      mocks.getProviderConnections.mockResolvedValue([conn1, conn2]);

      const creds = await getProviderCredentials("antigravity", null, "gemini-3.8-flash-high(high)");

      expect(creds).not.toBeNull();
      expect(creds.connectionId).toBe("acc-2");
    });

    it("allows the account for other models that are not in unsupportedModels", async () => {
      const conn1 = {
        id: "acc-1",
        name: "Account 1",
        priority: 1,
        unsupportedModels: ["gemini-3.8-flash-high"],
      };
      mocks.getProviderConnections.mockResolvedValue([conn1]);

      const creds = await getProviderCredentials("antigravity", null, "gemini-3.8-flash-low");

      expect(creds).not.toBeNull();
      expect(creds.connectionId).toBe("acc-1");
    });

    it("returns allUnsupported: true when all accounts have the model in unsupportedModels", async () => {
      const conn1 = {
        id: "acc-1",
        name: "Account 1",
        priority: 1,
        unsupportedModels: ["gemini-3.8-flash-high"],
      };
      const conn2 = {
        id: "acc-2",
        name: "Account 2",
        priority: 2,
        unsupportedModels: ["gemini-3.8-flash-high"],
      };
      mocks.getProviderConnections.mockResolvedValue([conn1, conn2]);

      const creds = await getProviderCredentials("antigravity", null, "gemini-3.8-flash-high");

      expect(creds).toEqual(expect.objectContaining({
        allUnsupported: true,
        lastErrorCode: 400,
      }));
    });
  });
});
