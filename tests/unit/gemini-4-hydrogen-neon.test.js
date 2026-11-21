import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import { applyThinking, stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";
import { getAntigravityModelQuota } from "../../src/sse/services/antigravityQuota.js";

const require = createRequire(import.meta.url);
const mitmConfig = require("../../src/mitm/config.js");

describe("Gemini 4 Hydrogen & Neon Registry", () => {
  it("registers all tiers and bare models in antigravity registry", () => {
    const agIds = antigravityRegistry.models.map((m) => m.id);
    const expected = [
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-medium",
      "gemini-4-hydrogen-low",
      "gemini-4-hydrogen",
      "gemini-4-neon-xhigh",
      "gemini-4-neon-high",
      "gemini-4-neon-medium",
      "gemini-4-neon-low",
      "gemini-4-neon",
    ];
    for (const id of expected) {
      expect(agIds).toContain(id);
    }
  });

  it("sets correct upstreamModelId with suffix in registry", () => {
    const find = (id) => antigravityRegistry.models.find((m) => m.id === id);
    expect(find("gemini-4-hydrogen-xhigh").upstreamModelId).toBe("gemini-4-hydrogen-xhigh(xhigh)");
    expect(find("gemini-4-hydrogen-high").upstreamModelId).toBe("gemini-4-hydrogen-high(high)");
    expect(find("gemini-4-hydrogen-medium").upstreamModelId).toBe("gemini-4-hydrogen-medium(medium)");
    expect(find("gemini-4-hydrogen-low").upstreamModelId).toBe("gemini-4-hydrogen-low(low)");
    expect(find("gemini-4-hydrogen").upstreamModelId).toBe("gemini-4-hydrogen-medium(medium)");

    expect(find("gemini-4-neon-xhigh").upstreamModelId).toBe("gemini-4-neon-xhigh(xhigh)");
    expect(find("gemini-4-neon-high").upstreamModelId).toBe("gemini-4-neon-high(high)");
    expect(find("gemini-4-neon-medium").upstreamModelId).toBe("gemini-4-neon-medium(medium)");
    expect(find("gemini-4-neon-low").upstreamModelId).toBe("gemini-4-neon-low(low)");
    expect(find("gemini-4-neon").upstreamModelId).toBe("gemini-4-neon-medium(medium)");
  });
});

describe("Gemini 4 Hydrogen & Neon Capabilities & Thinking Levels", () => {
  it.each([
    ["gemini-4-hydrogen-xhigh"],
    ["gemini-4-neon-xhigh"],
    ["gemini-4-hydrogen"],
    ["gemini-4-neon"],
  ])("resolves 1M context window and gemini-level reasoning for %s", (model) => {
    const caps = getCapabilitiesForModel("antigravity", model);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("publishes low, medium, high, and xhigh thinking levels for hydrogen and neon", () => {
    expect(getThinkingLevels("antigravity", "gemini-4-hydrogen-xhigh")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getThinkingLevels("antigravity", "gemini-4-hydrogen")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getThinkingLevels("antigravity", "gemini-4-neon-xhigh")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getThinkingLevels("antigravity", "gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("preserves low, medium, high without xhigh on argon and carbon", () => {
    expect(getThinkingLevels("antigravity", "gemini-4-argon-high")).toEqual(["low", "medium", "high"]);
    expect(getThinkingLevels("antigravity", "gemini-4-carbon-high")).toEqual(["low", "medium", "high"]);
  });
});

describe("Gemini 4 Upstream ID and Wire Translation", () => {
  it.each([
    ["gemini-4-hydrogen-xhigh", "xhigh"],
    ["gemini-4-hydrogen-high", "high"],
    ["gemini-4-hydrogen-medium", "medium"],
    ["gemini-4-hydrogen-low", "low"],
    ["gemini-4-neon-xhigh", "xhigh"],
    ["gemini-4-neon-high", "high"],
    ["gemini-4-neon-medium", "medium"],
    ["gemini-4-neon-low", "low"],
  ])("resolves upstream ID and applies thinking level %s for %s", (modelId, tier) => {
    const upstreamModel = getModelUpstreamId("ag", modelId);
    expect(upstreamModel).toBe(`${modelId}(${tier})`);

    const body = {
      model: stripThinkingSuffix(upstreamModel),
      request: {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(
      modelId,
      body,
      true,
      { projectId: "p", connectionId: "c" }
    );

    expect(finalBody.model).toBe(modelId);
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: tier,
      includeThoughts: true,
    });
  });

  it("resolves bare gemini-4-hydrogen and gemini-4-neon to xhigh when requested", () => {
    expect(getModelUpstreamId("ag", "gemini-4-hydrogen", { reasoning_effort: "xhigh" }))
      .toBe("gemini-4-hydrogen-xhigh(xhigh)");
    expect(getModelUpstreamId("ag", "gemini-4-neon", { reasoning_effort: "xhigh" }))
      .toBe("gemini-4-neon-xhigh(xhigh)");
  });

  it("defaults bare models to medium when effort is omitted", () => {
    expect(getModelUpstreamId("ag", "gemini-4-hydrogen", {}))
      .toBe("gemini-4-hydrogen-medium(medium)");
    expect(getModelUpstreamId("ag", "gemini-4-neon", {}))
      .toBe("gemini-4-neon-medium(medium)");
  });

  it("clamps xhigh to high on gemini-4-carbon when requesting unsupported tier", () => {
    expect(getModelUpstreamId("ag", "gemini-4-carbon", { reasoning_effort: "xhigh" }))
      .toBe("gemini-4-carbon-high(high)");

    const body = { reasoning_effort: "xhigh" };
    applyThinking("gemini", "gemini-4-carbon-high", body, "antigravity");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  it("clamps none/minimal to low for hydrogen", () => {
    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-4-hydrogen", body, "antigravity");
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });
});

describe("Gemini 4 Hydrogen & Neon Pricing", () => {
  it("prices gemini-4-hydrogen at $1.50 input / $7.50 output", () => {
    const pricing = getPricingForModel("antigravity", "gemini-4-hydrogen-xhigh");
    expect(pricing).toEqual({
      input: 1.5,
      output: 7.5,
      cached: 0.15,
      reasoning: 11.25,
      cache_creation: 1.875,
    });
  });

  it("prices gemini-4-neon at $3.00 input / $15.00 output", () => {
    const pricing = getPricingForModel("antigravity", "gemini-4-neon-xhigh");
    expect(pricing).toEqual({
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      reasoning: 22.5,
      cache_creation: 3.75,
    });
  });

  it("retains gemini-4-* baseline ($2/$10) for carbon and argon", () => {
    expect(getPricingForModel("antigravity", "gemini-4-carbon-high")).toMatchObject({
      input: 2.0,
      output: 10.0,
    });
    expect(getPricingForModel("antigravity", "gemini-4-argon-high")).toMatchObject({
      input: 2.0,
      output: 10.0,
    });
  });
});

describe("Gemini 4 Hydrogen & Neon MITM & Quota", () => {
  it("includes all hydrogen and neon models in MITM_TOOLS defaultModels and modelAliases", () => {
    const aliases = MITM_TOOLS.antigravity.modelAliases;
    const defaultIds = MITM_TOOLS.antigravity.defaultModels.map((m) => m.id);

    expect(aliases).toContain("gemini-4-hydrogen-xhigh");
    expect(aliases).toContain("gemini-4-neon-xhigh");
    expect(aliases).toContain("gemini-4-neon-high");
    expect(aliases).toContain("gemini-4-neon-medium");
    expect(aliases).toContain("gemini-4-neon-low");
    expect(aliases).toContain("gemini-4-neon");

    expect(defaultIds).toContain("gemini-4-hydrogen-xhigh");
    expect(defaultIds).toContain("gemini-4-neon-xhigh");
    expect(defaultIds).toContain("gemini-4-neon");
  });

  it("matches xhigh patterns ahead of high in mitmConfig.MODEL_PATTERNS", () => {
    const patterns = mitmConfig.MODEL_PATTERNS.antigravity;
    const match = (name) => {
      for (const p of patterns) {
        if (p.match.test(name)) return p.alias;
      }
      return null;
    };

    expect(match("gemini-4-hydrogen-xhigh")).toBe("gemini-4-hydrogen-xhigh");
    expect(match("gemini-4-hydrogen-high")).toBe("gemini-4-hydrogen-high");
    expect(match("gemini-4-neon-xhigh")).toBe("gemini-4-neon-xhigh");
    expect(match("gemini-4-neon-high")).toBe("gemini-4-neon-high");
  });

  it("falls back to medium quota bucket for bare hydrogen and neon models", () => {
    const quotas = {
      "gemini-4-hydrogen-medium": { used: 10, total: 100, remainingPercentage: 90 },
      "gemini-4-neon-medium": { used: 20, total: 100, remainingPercentage: 80 },
    };
    expect(getAntigravityModelQuota(quotas, "gemini-4-hydrogen")).toMatchObject({ used: 10, total: 100, remainingPercentage: 90 });
    expect(getAntigravityModelQuota(quotas, "gemini-4-neon")).toMatchObject({ used: 20, total: 100, remainingPercentage: 80 });
  });
});
