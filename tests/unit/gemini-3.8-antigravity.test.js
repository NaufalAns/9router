import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import geminiRegistry from "../../open-sse/providers/registry/gemini.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";

describe("Gemini 3.8 Flash Support & Config", () => {
  it("registers gemini-3.8-flash tiered models in antigravity provider registry", () => {
    const agIds = antigravityRegistry.models.map(m => m.id);
    expect(agIds).toContain("gemini-3.8-flash-high");
    expect(agIds).toContain("gemini-3.8-flash-medium");
    expect(agIds).toContain("gemini-3.8-flash-low");
    expect(agIds).toContain("gemini-3.8-flash");
  });

  it("registers gemini-3.8-flash in gemini provider registry", () => {
    const geminiIds = geminiRegistry.models.map(m => m.id);
    expect(geminiIds).toContain("gemini-3.8-flash");
  });

  it("resolves capabilities correctly for gemini-3.8 models with official limits", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-3.8-flash-high");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
  });

  it("defines pricing matching gemini-3.7-flash baseline", () => {
    expect(MODEL_PRICING["gemini-3.8-flash"]).toEqual(MODEL_PRICING["gemini-3.7-flash"]);
    expect(MODEL_PRICING["gemini-3.8-flash-high"]).toEqual(MODEL_PRICING["gemini-3.7-flash-high"]);
    expect(MODEL_PRICING["gemini-3.8-flash-medium"]).toEqual(MODEL_PRICING["gemini-3.7-flash-medium"]);
    expect(MODEL_PRICING["gemini-3.8-flash-low"]).toEqual(MODEL_PRICING["gemini-3.7-flash-low"]);
  });

  it("omits minimal thinking level for gemini-3.8 models and clamps MINIMAL passthrough to LOW", () => {
    expect(getThinkingLevels("antigravity", "gemini-3.8-flash-high")).toEqual(["low", "medium", "high"]);

    const executor = new AntigravityExecutor();
    const out = executor.transformRequest(
      "gemini-3.8-flash-high",
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: false },
          },
        },
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );

    expect(out.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "LOW",
      includeThoughts: false,
    });
  });

  it("preserves MINIMAL thinking level on models that still support it", () => {
    const executor = new AntigravityExecutor();
    const out = executor.transformRequest(
      "gemini-3-flash",
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: "MINIMAL" },
          },
        },
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );

    expect(out.request.generationConfig.thinkingConfig.thinkingLevel).toBe("MINIMAL");
  });
});
