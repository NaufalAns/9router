import { describe, it, expect, vi, beforeEach } from "vitest";
import { getProviderCredentials } from "@/sse/services/auth.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getAccountCombos: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  getAccountCombos: mocks.getAccountCombos,
  validateApiKey: vi.fn(),
}));

describe("Account Combos with getProviderCredentials", () => {
  const connPro = {
    id: "conn-pro",
    name: "pro@antigravity.ai",
    provider: "antigravity",
    isActive: true,
    priority: 1,
  };
  const connFree1 = {
    id: "conn-free-1",
    name: "free1@antigravity.ai",
    provider: "antigravity",
    isActive: true,
    priority: 2,
  };
  const connFree2 = {
    id: "conn-free-2",
    name: "free2@antigravity.ai",
    provider: "antigravity",
    isActive: true,
    priority: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.getProxyPools.mockResolvedValue([]);
    mocks.getProviderConnections.mockResolvedValue([connPro, connFree1, connFree2]);
  });

  it("strict mode: routes to assigned account only", async () => {
    mocks.getAccountCombos.mockResolvedValue([
      {
        id: "combo-1",
        model: "antigravity/gemini-4-carbon",
        provider: "antigravity",
        connectionIds: ["conn-pro"],
        fallbackMode: "strict",
        isActive: true,
      },
    ]);

    const creds = await getProviderCredentials("antigravity", null, "antigravity/gemini-4-carbon");
    expect(creds).not.toBeNull();
    expect(creds.connectionId).toBe("conn-pro");
  });

  it("strict mode: returns allUnsupported when assigned account is excluded/unavailable", async () => {
    mocks.getAccountCombos.mockResolvedValue([
      {
        id: "combo-1",
        model: "antigravity/gemini-4-carbon",
        provider: "antigravity",
        connectionIds: ["conn-pro"],
        fallbackMode: "strict",
        isActive: true,
      },
    ]);

    // conn-pro is excluded (e.g. previous error in request attempt)
    const creds = await getProviderCredentials("antigravity", ["conn-pro"], "antigravity/gemini-4-carbon");
    expect(creds).toEqual(expect.objectContaining({
      allUnsupported: true,
      lastError: expect.stringContaining("No active accounts available"),
      lastErrorCode: 400,
    }));
  });

  it("default mode: prioritizes assigned account when available", async () => {
    mocks.getAccountCombos.mockResolvedValue([
      {
        id: "combo-2",
        model: "antigravity/gemini-4-carbon",
        provider: "antigravity",
        connectionIds: ["conn-free-2"],
        fallbackMode: "default",
        isActive: true,
      },
    ]);

    const creds = await getProviderCredentials("antigravity", null, "antigravity/gemini-4-carbon");
    expect(creds.connectionId).toBe("conn-free-2");
  });

  it("default mode: falls back to other provider accounts when assigned account is excluded", async () => {
    mocks.getAccountCombos.mockResolvedValue([
      {
        id: "combo-2",
        model: "antigravity/gemini-4-carbon",
        provider: "antigravity",
        connectionIds: ["conn-free-2"],
        fallbackMode: "default",
        isActive: true,
      },
    ]);

    const creds = await getProviderCredentials("antigravity", ["conn-free-2"], "antigravity/gemini-4-carbon");
    expect(creds.connectionId).toBe("conn-pro");
  });

  it("inactive combo: does not restrict accounts", async () => {
    // getAccountCombos with { isActive: true } returns empty if combo is inactive
    mocks.getAccountCombos.mockResolvedValue([]);

    const creds = await getProviderCredentials("antigravity", null, "antigravity/gemini-4-carbon");
    expect(creds.connectionId).toBe("conn-pro");
  });

  it("matches account combo by combo name", async () => {
    mocks.getAccountCombos.mockResolvedValue([
      {
        id: "combo-1",
        name: "Antigravity Pro Carbon",
        model: "antigravity/gemini-4-carbon",
        provider: "antigravity",
        connectionIds: ["conn-pro"],
        fallbackMode: "strict",
        isActive: true,
      },
    ]);

    const creds = await getProviderCredentials("antigravity", null, "gemini-4-carbon", {
      requestedModel: "Antigravity Pro Carbon",
    });
    expect(creds.connectionId).toBe("conn-pro");
  });

  it("uses options.accountCombo directly when provided", async () => {
    const creds = await getProviderCredentials("antigravity", null, "gemini-4-carbon", {
      accountCombo: {
        id: "combo-custom",
        name: "Custom Combo",
        model: "antigravity/gemini-4-carbon",
        provider: "antigravity",
        connectionIds: ["conn-free-1"],
        fallbackMode: "strict",
        isActive: true,
      },
    });
    expect(creds.connectionId).toBe("conn-free-1");
  });
});
