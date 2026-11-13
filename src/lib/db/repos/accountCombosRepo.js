import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToAccountCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || null,
    model: row.model,
    provider: row.provider,
    connectionIds: parseJson(row.connectionIds, []),
    fallbackMode: row.fallbackMode || "strict",
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getAccountCombos(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { where.push("model = ?"); params.push(filter.model); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM accountCombos${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY createdAt ASC`;
  const rows = db.all(sql, params);
  return rows.map(rowToAccountCombo);
}

export async function getAccountComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM accountCombos WHERE id = ?`, [id]);
  return rowToAccountCombo(row);
}

export async function getAccountComboByModel(model, provider = null) {
  const db = await getAdapter();
  const candidates = [model];
  if (model.includes("/")) {
    candidates.push(model.split("/").slice(1).join("/"));
  } else if (provider) {
    candidates.push(`${provider}/${model}`);
  }

  for (const m of candidates) {
    let row;
    if (provider) {
      row = db.get(`SELECT * FROM accountCombos WHERE model = ? AND provider = ? AND isActive = 1`, [m, provider]);
    }
    if (!row) {
      row = db.get(`SELECT * FROM accountCombos WHERE model = ? AND isActive = 1`, [m]);
    }
    if (row) return rowToAccountCombo(row);
  }
  return null;
}

export async function getAccountComboByName(name) {
  if (!name) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM accountCombos WHERE (name = ? OR LOWER(name) = LOWER(?) OR id = ?) AND isActive = 1`, [name, name, name]);
  return rowToAccountCombo(row);
}

export async function createAccountCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const item = {
    id: uuidv4(),
    name: data.name || null,
    model: data.model,
    provider: data.provider,
    connectionIds: Array.isArray(data.connectionIds) ? data.connectionIds : [],
    fallbackMode: data.fallbackMode || "strict",
    isActive: data.isActive !== false ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO accountCombos(id, name, model, provider, connectionIds, fallbackMode, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.name,
      item.model,
      item.provider,
      stringifyJson(item.connectionIds),
      item.fallbackMode,
      item.isActive,
      item.createdAt,
      item.updatedAt,
    ]
  );
  return rowToAccountCombo(item);
}

export async function updateAccountCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM accountCombos WHERE id = ?`, [id]);
    if (!row) return;
    const existing = rowToAccountCombo(row);
    const merged = {
      ...existing,
      ...data,
      connectionIds: data.connectionIds !== undefined ? data.connectionIds : existing.connectionIds,
      updatedAt: new Date().toISOString(),
    };
    db.run(
      `UPDATE accountCombos SET name = ?, model = ?, provider = ?, connectionIds = ?, fallbackMode = ?, isActive = ?, updatedAt = ? WHERE id = ?`,
      [
        merged.name ?? null,
        merged.model,
        merged.provider,
        stringifyJson(merged.connectionIds || []),
        merged.fallbackMode || "strict",
        merged.isActive ? 1 : 0,
        merged.updatedAt,
        id,
      ]
    );
    result = merged;
  });
  return result;
}

export async function deleteAccountCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM accountCombos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
