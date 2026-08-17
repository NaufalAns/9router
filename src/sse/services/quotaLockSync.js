import { updateProviderConnection, getProviderConnections, getProviderConnectionById } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

/**
 * Synchronizes per-model quota availability from usage data into modelLock_* fields in SQLite DB.
 * - When quota is exhausted (remainingPercentage=0 or used>=total or remainingFraction=0) and resetAt is in the future:
 *   sets modelLock_${model} = resetAt (e.g. 5d 10h into the future).
 * - When quota is available: clears stale modelLock_${model} = null.
 * @param {string} connectionId
 * @param {object} usage
 */
export async function syncUsageQuotaLocks(connectionId, usage) {
  if (!connectionId || !usage?.quotas || typeof usage.quotas !== "object") return;
  const now = Date.now();
  const lockUpdates = {};

  for (const [modelKey, quota] of Object.entries(usage.quotas)) {
    if (!quota) continue;
    const remainingPercentage = typeof quota.remainingPercentage === "number" ? quota.remainingPercentage : null;
    const remainingFraction = typeof quota.remainingFraction === "number" ? quota.remainingFraction : null;
    const used = typeof quota.used === "number" ? quota.used : 0;
    const total = typeof quota.total === "number" ? quota.total : 0;

    const isExhausted = (remainingPercentage !== null && remainingPercentage <= 0) ||
                        (remainingFraction !== null && remainingFraction <= 0) ||
                        (total > 0 && used >= total);

    if (isExhausted && quota.resetAt) {
      const resetTimeMs = new Date(quota.resetAt).getTime();
      if (resetTimeMs > now) {
        lockUpdates[`modelLock_${modelKey}`] = new Date(resetTimeMs).toISOString();
      }
    } else if ((remainingPercentage !== null && remainingPercentage > 0) ||
               (remainingFraction !== null && remainingFraction > 0) ||
               (total > 0 && used < total)) {
      lockUpdates[`modelLock_${modelKey}`] = null;
    }
  }

  if (Object.keys(lockUpdates).length > 0) {
    await updateProviderConnection(connectionId, lockUpdates);
  }
}

/**
 * Fetch usage for a single connection and sync its quota locks to DB.
 * Safe to run in background.
 * @param {string|object} connectionOrId
 */
export async function syncConnectionQuotaLocks(connectionOrId) {
  try {
    const connection = typeof connectionOrId === "string"
      ? await getProviderConnectionById(connectionOrId)
      : connectionOrId;
    if (!connection || !connection.id || connection.isActive === false) return;

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    const usage = await getUsageForProvider(connection, proxyOptions, { force: true });
    if (usage && usage.quotas) {
      await syncUsageQuotaLocks(connection.id, usage);
    }
  } catch {
    // Non-blocking background sync
  }
}

/**
 * Syncs quota locks across all active connections that support quota discovery
 * (e.g. antigravity, gemini-cli, kiro, codex, github).
 */
export async function syncAllProviderQuotaLocks() {
  try {
    const connections = await getProviderConnections({ isActive: true });
    const quotaProviders = ["antigravity", "gemini-cli", "kiro", "codex", "github"];
    const eligible = connections.filter(c => quotaProviders.includes(c.provider));

    for (const conn of eligible) {
      await syncConnectionQuotaLocks(conn);
    }
  } catch {
    // Non-blocking
  }
}
