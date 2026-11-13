"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, Button, Modal, Input, Select, Toggle, Badge, ConfirmModal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getModelsByProviderId } from "@/shared/constants/models";
import { AI_PROVIDERS, resolveProviderId, getProviderAlias } from "@/shared/constants/providers";

export default function AccountCombosSection({ activeProviders = [] }) {
  const [accountCombos, setAccountCombos] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  const fetchAccountCombos = async () => {
    try {
      const res = await fetch("/api/account-combos");
      if (res.ok) {
        const data = await res.json();
        setAccountCombos(data.accountCombos || []);
      }
    } catch (err) {
      console.log("Error fetching account combos:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [acRes, cmRes] = await Promise.all([
          fetch("/api/account-combos"),
          fetch("/api/models/custom"),
        ]);
        if (acRes.ok) {
          const data = await acRes.json();
          if (!ignore) setAccountCombos(data.accountCombos || []);
        }
        if (cmRes.ok) {
          const cmData = await cmRes.json();
          if (!ignore) setCustomModels(cmData.models || []);
        }
      } catch (err) {
        if (!ignore) console.log("Error fetching account combos or custom models:", err);
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  // Map connections by ID for quick lookup
  const connectionMap = useMemo(() => {
    const map = new Map();
    for (const conn of activeProviders) {
      if (conn?.id) map.set(conn.id, conn);
    }
    return map;
  }, [activeProviders]);

  const handleToggleActive = async (combo) => {
    const nextState = !combo.isActive;
    try {
      setAccountCombos((prev) =>
        prev.map((c) => (c.id === combo.id ? { ...c, isActive: nextState } : c))
      );
      await fetch(`/api/account-combos/${combo.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextState }),
      });
    } catch (err) {
      console.log("Error updating account combo active state:", err);
      await fetchAccountCombos();
    }
  };

  const handleDelete = (combo) => {
    setConfirmState({
      title: "Delete Account Combo",
      message: `Delete account combo for model "${combo.model}"?`,
      confirmText: "Delete",
      variant: "danger",
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/account-combos/${combo.id}`, { method: "DELETE" });
          if (res.ok) {
            setAccountCombos((prev) => prev.filter((c) => c.id !== combo.id));
          }
        } catch (err) {
          console.log("Error deleting account combo:", err);
        } finally {
          setConfirmState(null);
        }
      },
    });
  };

  const handleSaveModal = async (formData) => {
    try {
      if (editingItem) {
        const res = await fetch(`/api/account-combos/${editingItem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchAccountCombos();
          setModalOpen(false);
          setEditingItem(null);
        } else {
          const err = await res.json();
          alert(err.error || "Failed to update account combo");
        }
      } else {
        const res = await fetch("/api/account-combos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchAccountCombos();
          setModalOpen(false);
          setEditingItem(null);
        } else {
          const err = await res.json();
          alert(err.error || "Failed to create account combo");
        }
      }
    } catch (err) {
      console.log("Error saving account combo:", err);
    }
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return accountCombos;
    return accountCombos.filter((c) => {
      if (c.model?.toLowerCase().includes(q)) return true;
      if (c.name?.toLowerCase().includes(q)) return true;
      if (c.provider?.toLowerCase().includes(q)) return true;
      // Search assigned connection names
      for (const id of c.connectionIds || []) {
        const conn = connectionMap.get(id);
        if (conn && (conn.name?.toLowerCase().includes(q) || conn.email?.toLowerCase().includes(q))) {
          return true;
        }
      }
      return false;
    });
  }, [accountCombos, searchQuery, connectionMap]);

  return (
    <div className="flex flex-col gap-4">
      {/* Top action bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-main">Combo Akun (Model-to-Account Mapping)</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Kelompokkan akun berdasarkan model. Arahkan model tertentu ke akun spesifik (misal: model Pro hanya ke Akun Pro, model Flash ke semua akun). Urutan akun mengikuti prioritas provider.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-60">
            <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search account combos…"
              className="w-full rounded-[10px] border border-transparent bg-surface-2 py-1.5 pl-9 pr-8 text-xs text-text-main placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </div>
          <Button
            size="sm"
            icon="add"
            onClick={() => {
              setEditingItem(null);
              setModalOpen(true);
            }}
            className="whitespace-nowrap"
          >
            Create Combo Akun
          </Button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <Card padding="sm">
          <div className="py-8 text-center text-xs text-text-muted">Loading account combos…</div>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <div className="text-center py-10">
            <div className="inline-flex items-center justify-center size-12 rounded-full bg-primary/10 text-primary mb-3">
              <span className="material-symbols-outlined text-[28px]">switch_account</span>
            </div>
            <p className="text-sm font-medium text-text-main mb-1">
              {searchQuery ? "No matching account combos" : "Belum ada Combo Akun"}
            </p>
            <p className="text-xs text-text-muted mb-4 max-w-md mx-auto">
              {searchQuery
                ? `Tidak ditemukan combo akun dengan kata kunci "${searchQuery}".`
                : "Buat aturan combo akun untuk membatasi atau mengarahkan model AI tertentu hanya ke akun-akun yang Anda tentukan."}
            </p>
            <Button
              size="sm"
              icon="add"
              onClick={() => {
                setEditingItem(null);
                setModalOpen(true);
              }}
            >
              Create Combo Akun
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {filtered.map((item) => {
            const providerInfo = AI_PROVIDERS[item.provider] || { name: item.provider, color: "#666" };
            const assignedCount = (item.connectionIds || []).length;
            const isStrict = item.fallbackMode === "strict";

            return (
              <Card key={item.id} padding="sm" className={!item.isActive ? "opacity-60" : ""}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-1 items-start gap-3">
                    <ProviderIcon
                      src={`/providers/${item.provider}.png`}
                      alt={providerInfo.name}
                      size={24}
                      fallbackText={(providerInfo.name || item.provider).slice(0, 2).toUpperCase()}
                      fallbackColor={providerInfo.color}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="font-mono text-xs font-semibold text-text-main bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">
                          {item.model}
                        </code>
                        {item.name && (
                          <span className="text-xs text-text-muted font-medium">({item.name})</span>
                        )}
                        <Badge variant={isStrict ? "primary" : "default"} size="sm">
                          {isStrict ? "Strict" : "Fallback Default"}
                        </Badge>
                      </div>

                      {/* Assigned accounts chips */}
                      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] text-text-muted font-medium">
                          Akun ({assignedCount}):
                        </span>
                        {assignedCount === 0 ? (
                          <span className="text-[11px] text-red-500 italic">Belum ada akun dipilih</span>
                        ) : (
                          item.connectionIds.map((connId) => {
                            const conn = connectionMap.get(connId);
                            const name = conn?.name || conn?.email || connId.slice(0, 8);
                            const active = conn && conn.isActive !== false;
                            return (
                              <span
                                key={connId}
                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono border ${
                                  active
                                    ? "bg-surface-2 border-border/60 text-text-main"
                                    : "bg-red-500/10 border-red-500/20 text-red-500"
                                }`}
                              >
                                <span className={`size-1.5 rounded-full ${active ? "bg-green-500" : "bg-red-500"}`} />
                                <span className="truncate max-w-[140px]">{name}</span>
                                {conn?.priority && (
                                  <span className="text-text-muted font-normal">#{conn.priority}</span>
                                )}
                              </span>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t border-border/30 sm:border-0">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingItem(item);
                          setModalOpen(true);
                        }}
                        className="p-1 rounded text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        title="Edit Combo Akun"
                      >
                        <span className="material-symbols-outlined text-[18px]">edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(item)}
                        className="p-1 rounded text-red-500 hover:bg-red-500/10 transition-colors"
                        title="Delete Combo Akun"
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    </div>
                    <Toggle
                      size="sm"
                      checked={item.isActive ?? true}
                      onChange={() => handleToggleActive(item)}
                      title={(item.isActive ?? true) ? "Disable combo akun" : "Enable combo akun"}
                    />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create / Edit Modal */}
      {modalOpen && (
        <AccountComboModal
          isOpen={modalOpen}
          initialData={editingItem}
          activeProviders={activeProviders}
          customModels={customModels}
          onClose={() => {
            setModalOpen(false);
            setEditingItem(null);
          }}
          onSave={handleSaveModal}
        />
      )}

      {/* Confirm Delete */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Confirm"}
        variant={confirmState?.variant || "danger"}
      />
    </div>
  );
}

function AccountComboModal({ isOpen, initialData, activeProviders = [], customModels = [], onClose, onSave }) {
  // Extract distinct providers that have at least one connection
  const availableProviderIds = useMemo(() => {
    const set = new Set();
    for (const conn of activeProviders) {
      if (conn?.provider) set.add(conn.provider);
    }
    return Array.from(set);
  }, [activeProviders]);

  const defaultProvider = initialData?.provider || availableProviderIds[0] || "antigravity";
  const initialModel = initialData?.model || getModelsByProviderId(defaultProvider)?.[0]?.id || "";

  const [provider, setProvider] = useState(defaultProvider);
  const [model, setModel] = useState(initialModel);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [name, setName] = useState(initialData?.name || "");
  const [fallbackMode, setFallbackMode] = useState(initialData?.fallbackMode || "strict");
  const [selectedConnectionIds, setSelectedConnectionIds] = useState(initialData?.connectionIds || []);
  const [isActive, setIsActive] = useState(initialData?.isActive !== false);

  // Accounts for current selected provider
  const providerConnections = useMemo(() => {
    return activeProviders
      .filter((c) => c.provider === provider && c.isActive !== false)
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  }, [activeProviders, provider]);

  // Models for current selected provider (combining static registry, custom models, and connection enabled models)
  const providerModels = useMemo(() => {
    const staticList = getModelsByProviderId(provider) || [];
    const alias = getProviderAlias(provider) || provider;

    const matchingCustom = (customModels || [])
      .filter((m) => m.providerAlias === alias || m.providerAlias === provider)
      .map((m) => ({
        id: m.id,
        name: m.name ? `${m.name} (${m.id})` : m.id,
        isCustom: true,
      }));

    const connectionModels = [];
    for (const conn of activeProviders) {
      if (conn.provider === provider && Array.isArray(conn.providerSpecificData?.enabledModels)) {
        for (const em of conn.providerSpecificData.enabledModels) {
          if (em && typeof em === "string") {
            const clean = em.startsWith(`${alias}/`) ? em.slice(alias.length + 1) : em;
            connectionModels.push({ id: clean, name: clean, isConnectionModel: true });
          }
        }
      }
    }

    const seen = new Set();
    const result = [];
    const add = (m) => {
      const id = typeof m === "string" ? m : m.id;
      if (!id || seen.has(id)) return;
      seen.add(id);
      result.push(typeof m === "string" ? { id, name: id } : m);
    };

    staticList.forEach(add);
    matchingCustom.forEach(add);
    connectionModels.forEach(add);

    return result;
  }, [provider, customModels, activeProviders]);

  // When provider changes in create mode, reset model and connection selection
  const handleProviderChange = (newProvider) => {
    setProvider(newProvider);
    if (!initialData) {
      const staticList = getModelsByProviderId(newProvider) || [];
      const alias = getProviderAlias(newProvider) || newProvider;
      const matchingCustom = (customModels || []).filter(
        (m) => m.providerAlias === alias || m.providerAlias === newProvider
      );
      const firstModel = staticList[0]?.id || matchingCustom[0]?.id || "";
      setModel(firstModel);
      setSelectedConnectionIds([]);
    }
  };

  const toggleConnection = (id) => {
    setSelectedConnectionIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    setSelectedConnectionIds(providerConnections.map((c) => c.id));
  };

  const handleDeselectAll = () => {
    setSelectedConnectionIds([]);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const cleanModel = model.trim();
    if (!cleanModel) {
      alert("Model wajib diisi.");
      return;
    }
    if (selectedConnectionIds.length === 0) {
      if (!confirm("Tidak ada akun yang dipilih untuk model ini. Lanjutkan?")) return;
    }
    onSave({
      provider,
      model: cleanModel,
      name: name.trim() || null,
      fallbackMode,
      connectionIds: selectedConnectionIds,
      isActive,
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={initialData ? "Edit Combo Akun" : "Create Combo Akun"}
      size="md"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Provider Select */}
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Provider</label>
          <Select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
            disabled={!!initialData}
            options={availableProviderIds.map((pId) => {
              const info = AI_PROVIDERS[pId] || { name: pId };
              return { value: pId, label: info.name };
            })}
          />
        </div>

        {/* Model Picker */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-text-muted">Target Model</label>
            <button
              type="button"
              onClick={() => setCustomModelMode(!customModelMode)}
              className="text-[11px] text-primary hover:underline"
            >
              {customModelMode ? "Pilih dari daftar" : "Ketik manual model ID"}
            </button>
          </div>
          {customModelMode ? (
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. gemini-4-carbon-high or antigravity/gemini-4-carbon-high"
              required
            />
          ) : (
            <Select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              options={
                providerModels.length > 0
                  ? providerModels.map((m) => ({
                      value: m.id,
                      label: m.isCustom
                        ? `[Custom] ${m.name || m.id}`
                        : m.isConnectionModel
                          ? `[Connection] ${m.name || m.id}`
                          : `${m.name || m.id} (${m.id})`,
                    }))
                  : [{ value: model || "", label: model || "No predefined models" }]
              }
            />
          )}
        </div>

        {/* Label Name (Optional) */}
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Nama / Keterangan (Opsional)</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Akun Pro Tier Khusus"
          />
        </div>

        {/* Assigned Accounts Checklist */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-medium text-text-muted">
              Pilih Akun yang Melayani Model Ini ({selectedConnectionIds.length}/{providerConnections.length})
            </label>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={handleSelectAll}
                className="text-primary hover:underline"
              >
                Pilih Semua
              </button>
              <span className="text-text-muted/40">|</span>
              <button
                type="button"
                onClick={handleDeselectAll}
                className="text-text-muted hover:text-text-main"
              >
                Hapus Semua
              </button>
            </div>
          </div>

          {providerConnections.length === 0 ? (
            <div className="rounded-lg border border-border/50 bg-black/[0.02] dark:bg-white/[0.02] p-3 text-center text-xs text-text-muted">
              Tidak ada akun aktif untuk provider {provider}.
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-border/50 bg-surface-2/40 p-2">
              {providerConnections.map((conn) => {
                const isChecked = selectedConnectionIds.includes(conn.id);
                const title = conn.name || conn.email || conn.id;
                return (
                  <label
                    key={conn.id}
                    className={`flex items-center justify-between gap-2 p-2 rounded-md cursor-pointer transition-colors ${
                      isChecked
                        ? "bg-primary/10 border border-primary/20 text-text-main"
                        : "hover:bg-black/5 dark:hover:bg-white/5 text-text-muted"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleConnection(conn.id)}
                        className="rounded border-border text-primary focus:ring-primary"
                      />
                      <span className="text-xs font-medium truncate">{title}</span>
                      {conn.email && conn.name && conn.email !== conn.name && (
                        <span className="text-[10px] text-text-muted truncate">({conn.email})</span>
                      )}
                    </div>
                    {conn.priority && (
                      <span className="text-[10px] text-text-muted font-mono shrink-0">#{conn.priority}</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Fallback Mode */}
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1.5">Fallback Mode</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setFallbackMode("strict")}
              className={`p-2.5 rounded-lg border text-left transition-all ${
                fallbackMode === "strict"
                  ? "border-primary bg-primary/10 text-text-main"
                  : "border-border/50 hover:bg-black/5 dark:hover:bg-white/5 text-text-muted"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium text-xs">
                <span className="material-symbols-outlined text-[16px] text-primary">lock</span>
                Strict
              </div>
              <p className="text-[10px] text-text-muted mt-1">
                Hanya gunakan akun yang dipilih. Tolak request jika semua akun yang dipilih habis.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setFallbackMode("default")}
              className={`p-2.5 rounded-lg border text-left transition-all ${
                fallbackMode === "default"
                  ? "border-primary bg-primary/10 text-text-main"
                  : "border-border/50 hover:bg-black/5 dark:hover:bg-white/5 text-text-muted"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium text-xs">
                <span className="material-symbols-outlined text-[16px] text-primary">alt_route</span>
                Fallback Default
              </div>
              <p className="text-[10px] text-text-muted mt-1">
                Prioritaskan akun yang dipilih dulu. Jika habis, coba akun provider lainnya.
              </p>
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
