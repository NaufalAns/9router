import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connections: { gemini: [], antigravity: [], "gemini-cli": [] },
  accountComboByName: null,
  accountComboByModel: null,
}));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getProviderConnections: async ({ provider }) => state.connections[provider] ?? [],
  getAccountComboByName: async (name) =>
    state.accountComboByName && state.accountComboByName.name === name ? state.accountComboByName : null,
  getAccountComboByModel: async (model) =>
    state.accountComboByModel && state.accountComboByModel.model === model ? state.accountComboByModel : null,
}));

import { getModelInfo } from "../../src/sse/services/model.js";

describe("bare gemini-* and account combo model routing", () => {
  beforeEach(() => {
    state.connections = { gemini: [], antigravity: [], "gemini-cli": [] };
    state.accountComboByName = null;
    state.accountComboByModel = null;
  });

  it("keeps provider gemini when nothing is connected", async () => {
    expect(await getModelInfo("gemini-4-hydrogen")).toEqual({
      provider: "gemini",
      model: "gemini-4-hydrogen",
    });
  });

  it("routes bare gemini-4-hydrogen to antigravity when gemini has no active connection", async () => {
    state.connections.antigravity = [{ id: "ag-1", isActive: true }];
    state.connections["gemini-cli"] = [{ id: "gc-1", isActive: true }];
    expect(await getModelInfo("gemini-4-hydrogen")).toEqual({
      provider: "antigravity",
      model: "gemini-4-hydrogen",
    });
  });

  it("routes bare gemini-2.5-flash to gemini-cli when gemini has no active connection", async () => {
    state.connections["gemini-cli"] = [{ id: "gc-1", isActive: true }];
    expect(await getModelInfo("gemini-2.5-flash")).toEqual({
      provider: "gemini-cli",
      model: "gemini-2.5-flash",
    });
  });

  it("keeps provider gemini when a gemini connection is active", async () => {
    state.connections.gemini = [{ id: "g-1", isActive: true }];
    state.connections.antigravity = [{ id: "ag-1", isActive: true }];
    expect(await getModelInfo("gemini-4-hydrogen")).toEqual({
      provider: "gemini",
      model: "gemini-4-hydrogen",
    });
  });

  it("resolves bare model matching an active account combo", async () => {
    const combo = {
      id: "ac-1",
      name: null,
      model: "gemini-4-hydrogen",
      provider: "antigravity",
      connectionIds: ["ag-pro"],
      fallbackMode: "strict",
      isActive: true,
    };
    state.accountComboByModel = combo;
    expect(await getModelInfo("gemini-4-hydrogen")).toEqual({
      provider: "antigravity",
      model: "gemini-4-hydrogen",
      accountCombo: combo,
    });
  });

  it("resolves account combo by name", async () => {
    const combo = {
      id: "ac-2",
      name: "Antigravity Pro Hydrogen",
      model: "gemini-4-hydrogen",
      provider: "antigravity",
      connectionIds: ["ag-pro"],
      fallbackMode: "strict",
      isActive: true,
    };
    state.accountComboByName = combo;
    expect(await getModelInfo("Antigravity Pro Hydrogen")).toEqual({
      provider: "antigravity",
      model: "gemini-4-hydrogen",
      accountCombo: combo,
    });
  });

  it("does not alter explicit gemini/ provider prefix", async () => {
    state.connections.antigravity = [{ id: "ag-1", isActive: true }];
    expect(await getModelInfo("gemini/gemini-4-hydrogen")).toEqual({
      provider: "gemini",
      model: "gemini-4-hydrogen",
    });
  });
});
