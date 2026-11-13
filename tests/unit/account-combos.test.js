import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-account-combos-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Account Combos Repository (CRUD)", () => {
  it("creates, reads, updates, and deletes account combos", async () => {
    const {
      createAccountCombo,
      getAccountCombos,
      getAccountComboById,
      getAccountComboByName,
      getAccountComboByModel,
      updateAccountCombo,
      deleteAccountCombo,
    } = await import("@/lib/db/repos/accountCombosRepo.js");

    // 1. Create
    const created = await createAccountCombo({
      name: "Antigravity Pro Carbon",
      model: "antigravity/gemini-4-carbon",
      provider: "antigravity",
      connectionIds: ["conn-pro"],
      fallbackMode: "strict",
      isActive: true,
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe("Antigravity Pro Carbon");
    expect(created.model).toBe("antigravity/gemini-4-carbon");
    expect(created.provider).toBe("antigravity");
    expect(created.connectionIds).toEqual(["conn-pro"]);
    expect(created.fallbackMode).toBe("strict");
    expect(created.isActive).toBe(true);

    // 2. Read by ID
    const byId = await getAccountComboById(created.id);
    expect(byId).toEqual(created);

    // 2b. Read by Name
    const byName = await getAccountComboByName("Antigravity Pro Carbon");
    expect(byName?.id).toBe(created.id);

    const byNameCaseInsensitive = await getAccountComboByName("antigravity pro carbon");
    expect(byNameCaseInsensitive?.id).toBe(created.id);

    const byNameAsId = await getAccountComboByName(created.id);
    expect(byNameAsId?.id).toBe(created.id);

    const byNameMissing = await getAccountComboByName("Nonexistent Combo");
    expect(byNameMissing).toBeNull();

    // 3. Read by Model (prefixed and bare)
    const byPrefixedModel = await getAccountComboByModel("antigravity/gemini-4-carbon");
    expect(byPrefixedModel?.id).toBe(created.id);

    const byBareModel = await getAccountComboByModel("gemini-4-carbon", "antigravity");
    expect(byBareModel?.id).toBe(created.id);

    // 4. List with filter
    const list = await getAccountCombos({ provider: "antigravity" });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created.id);

    // 5. Update
    const updated = await updateAccountCombo(created.id, {
      fallbackMode: "default",
      connectionIds: ["conn-pro", "conn-free-1"],
    });
    expect(updated.fallbackMode).toBe("default");
    expect(updated.connectionIds).toEqual(["conn-pro", "conn-free-1"]);

    // 6. Delete
    const deleted = await deleteAccountCombo(created.id);
    expect(deleted).toBe(true);

    const afterDelete = await getAccountComboById(created.id);
    expect(afterDelete).toBeNull();
  });
});
