import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getAccountCombos: vi.fn(),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("/v1/models filtering with Account Combos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.getCombos.mockResolvedValue([]);
    db.getCustomModels.mockResolvedValue([]);
    db.getModelAliases.mockResolvedValue({});
  });

  it("strict mode hides model if all assigned accounts are inactive or offline", async () => {
    // Only conn-free is active, but gemini-4-carbon is strictly bound to conn-pro (id: 1) which is not active
    db.getProviderConnections.mockResolvedValue([
      { id: 2, provider: "antigravity", isActive: true },
    ]);
    db.getAccountCombos.mockResolvedValue([
      {
        id: "ac-1",
        model: "antigravity/gemini-4-carbon",
        provider: "antigravity",
        connectionIds: [1], // connection 1 is not in active connections
        fallbackMode: "strict",
        isActive: true,
      },
    ]);

    const models = await buildModelsList(["llm"]);
    const hasCarbon = models.some((m) => m.id === "ag/gemini-4-carbon");
    expect(hasCarbon).toBe(false);
  });

  it("strict mode retains model if at least one assigned account is active", async () => {
    // Both conn-pro (1) and conn-free (2) are active
    db.getProviderConnections.mockResolvedValue([
      { id: 1, provider: "antigravity", isActive: true },
      { id: 2, provider: "antigravity", isActive: true },
    ]);
    db.getAccountCombos.mockResolvedValue([
      {
        id: "ac-1",
        model: "antigravity/gemini-4-carbon",
        provider: "antigravity",
        connectionIds: [1],
        fallbackMode: "strict",
        isActive: true,
      },
    ]);

    const models = await buildModelsList(["llm"]);
    const hasCarbon = models.some((m) => m.id === "ag/gemini-4-carbon");
    expect(hasCarbon).toBe(true);
  });
});
