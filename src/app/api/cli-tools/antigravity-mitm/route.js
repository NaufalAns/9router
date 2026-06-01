import { NextResponse } from "next/server";
import {
  getMitmStatus,
  startServer,
  stopServer,
  enableToolDNS,
  disableToolDNS,
  trustCert,
  getCachedPassword,
  setCachedPassword,
  loadEncryptedPassword,
  isSudoPasswordRequired,
  initDbHooks,
} from "@/mitm/manager";
import { getApiKeys, getSettings, updateSettings } from "@/lib/localDb";
import { getMitmAutoStartState, buildNextToolAutoStartSettings } from "@/mitm/autoStartState";

initDbHooks(getSettings, updateSettings);

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

function normalizeMitmRouterBaseUrlInput(input) {
  if (input == null || String(input).trim() === "") {
    return DEFAULT_MITM_ROUTER_BASE;
  }
  const t = String(input).trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(t);
  } catch {
    throw new Error("Invalid MITM router URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("MITM router URL must use http or https");
  }
  return t;
}

const isWin = process.platform === "win32";

function getPassword(provided) {
  return provided || getCachedPassword() || null;
}

function requiresSudoPassword(pwd) {
  return !isWin && !pwd && isSudoPasswordRequired();
}

function checkIsAdmin() {
  if (isWin) {
    try {
      require("child_process").execSync("net session >nul 2>&1", { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function checkPrivilege(pwd) {
  if (checkIsAdmin()) return true;
  if (isWin) return false;
  if (!isSudoPasswordRequired()) return true;
  return !!pwd;
}

async function getDefaultApiKey() {
  try {
    const keys = await getApiKeys();
    return keys.find((k) => k.isActive !== false)?.key || "sk_9router";
  } catch {
    return "sk_9router";
  }
}

function buildStatusResponse(status, settings, hasCachedPassword) {
  const autoStart = getMitmAutoStartState(settings);
  return {
    running: status.running,
    pid: status.pid || null,
    certExists: status.certExists || false,
    certTrusted: status.certTrusted || false,
    dnsStatus: status.dnsStatus || {},
    hasCachedPassword,
    isWin,
    needsSudoPassword: !isWin && !hasCachedPassword && isSudoPasswordRequired(),
    isAdmin: checkIsAdmin(),
    mitmAutoStartEnabled: autoStart.mitmAutoStartEnabled,
    antigravityDnsAutoStartEnabled: autoStart.antigravityDnsAutoStartEnabled,
    mitmRouterBaseUrl:
      (settings.mitmRouterBaseUrl && String(settings.mitmRouterBaseUrl).trim()) ||
      DEFAULT_MITM_ROUTER_BASE,
  };
}

async function getFullStatusResponse(extra = {}) {
  const status = await getMitmStatus();
  const settings = await getSettings();
  const hasCachedPassword = !!getCachedPassword() || !!(await loadEncryptedPassword());
  return { ...extra, ...buildStatusResponse(status, settings, hasCachedPassword) };
}

// GET - Full MITM status (server + per-tool DNS)
export async function GET() {
  try {
    const status = await getMitmStatus();
    const settings = await getSettings();
    const hasCachedPassword = !!getCachedPassword() || !!(await loadEncryptedPassword());
    return NextResponse.json(buildStatusResponse(status, settings, hasCachedPassword));
  } catch (error) {
    console.log("Error getting MITM status:", error.message);
    return NextResponse.json({ error: "Failed to get MITM status" }, { status: 500 });
  }
}

// POST - Start MITM server (cert + server, no DNS)
export async function POST(request) {
  try {
    const { apiKey, sudoPassword, mitmRouterBaseUrl, forceKillPort443 } = await request.json();
    const pwd = getPassword(sudoPassword) || await loadEncryptedPassword() || "";

    if (!apiKey || requiresSudoPassword(pwd)) {
      return NextResponse.json(
        { error: !apiKey ? "Missing apiKey" : "Missing sudoPassword" },
        { status: 400 }
      );
    }

    if (!checkPrivilege(pwd)) {
      return NextResponse.json(
        { error: isWin ? "Administrator required — restart 9Router as Administrator" : "Root or sudo password required to start MITM" },
        { status: 403 }
      );
    }

    if (mitmRouterBaseUrl !== undefined && mitmRouterBaseUrl !== null) {
      try {
        const normalized = normalizeMitmRouterBaseUrlInput(mitmRouterBaseUrl);
        await updateSettings({ mitmRouterBaseUrl: normalized });
      } catch (e) {
        return NextResponse.json(
          { error: e.message || "Invalid MITM router URL" },
          { status: 400 },
        );
      }
    }

    const result = await startServer(apiKey, pwd, !!forceKillPort443);
    if (!isWin) setCachedPassword(pwd);

    return NextResponse.json({ success: true, running: result.running, pid: result.pid });
  } catch (error) {
    console.log("Error starting MITM server:", error.message);
    if (error.code === "PORT_443_BUSY") {
      return NextResponse.json(
        { error: error.message, code: "PORT_443_BUSY", portOwner: error.portOwner },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message || "Failed to start MITM server" }, { status: 500 });
  }
}

// DELETE - Stop MITM server (removes all DNS first, then kills server)
export async function DELETE(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { sudoPassword } = body;
    const pwd = getPassword(sudoPassword) || await loadEncryptedPassword() || "";

    if (requiresSudoPassword(pwd)) {
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    }

    await stopServer(pwd);
    if (!isWin && sudoPassword) setCachedPassword(sudoPassword);

    return NextResponse.json({ success: true, running: false });
  } catch (error) {
    console.log("Error stopping MITM server:", error.message);
    return NextResponse.json({ error: error.message || "Failed to stop MITM server" }, { status: 500 });
  }
}

// PATCH - Toggle DNS for a specific tool (enable/disable)
export async function PATCH(request) {
  try {
    const { tool, action, sudoPassword, enabled } = await request.json();
    const pwd = getPassword(sudoPassword) || await loadEncryptedPassword() || "";

    if (!action) {
      return NextResponse.json({ error: "action required" }, { status: 400 });
    }

    if (action === "set-antigravity-autostart") {
      const nextEnabled = enabled === true;
      const settings = await getSettings();
      const currentDnsToolEnabled = settings.dnsToolEnabled || {};
      const nextDnsToolEnabled = { ...currentDnsToolEnabled, antigravity: nextEnabled };
      const anyToolEnabled = Object.values(nextDnsToolEnabled).some(Boolean);
      const nextAutoStart = buildNextToolAutoStartSettings(settings, "antigravity", nextEnabled);

      await updateSettings({
        ...nextAutoStart,
        mitmEnabled: nextEnabled ? true : anyToolEnabled,
        dnsToolEnabled: nextDnsToolEnabled,
      });

      let appliedNow = false;
      let warning = null;

      if (!checkPrivilege(pwd)) {
        warning = isWin
          ? "Administrator required — settings saved and will apply when 9Router runs as Administrator"
          : "Root or sudo password required — settings saved and will apply when privilege is available";
        return NextResponse.json(await getFullStatusResponse({ success: true, appliedNow, warning }));
      }

      try {
        if (nextEnabled) {
          let status = await getMitmStatus();
          if (!status.running) {
            await startServer(await getDefaultApiKey(), pwd);
            status = await getMitmStatus();
          }
          if (status.running) {
            await enableToolDNS("antigravity", pwd);
            appliedNow = true;
          } else {
            warning = "MITM settings saved, but server is not running";
          }
        } else {
          await disableToolDNS("antigravity", pwd);
          appliedNow = true;
        }
        if (!isWin && sudoPassword) setCachedPassword(sudoPassword);
      } catch (e) {
        warning = `Settings saved, but current session was not fully updated: ${e.message}`;
      }

      return NextResponse.json(await getFullStatusResponse({ success: true, appliedNow, warning }));
    }

    if (!tool && action !== "trust-cert") {
      return NextResponse.json({ error: "tool and action required" }, { status: 400 });
    }
    if (requiresSudoPassword(pwd)) {
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    }
    if (!checkPrivilege(pwd)) {
      return NextResponse.json(
        { error: isWin ? "Administrator required — restart 9Router as Administrator" : "Root or sudo password required to modify DNS" },
        { status: 403 }
      );
    }

    if (action === "enable") {
      await enableToolDNS(tool, pwd);
    } else if (action === "disable") {
      await disableToolDNS(tool, pwd);
    } else if (action === "trust-cert") {
      await trustCert(pwd);
      if (!isWin && sudoPassword) setCachedPassword(sudoPassword);
      const status = await getMitmStatus();
      return NextResponse.json({ success: true, certTrusted: status.certTrusted });
    } else {
      return NextResponse.json({ error: "action must be enable, disable, trust-cert, or set-antigravity-autostart" }, { status: 400 });
    }

    if (!isWin && sudoPassword) setCachedPassword(sudoPassword);

    const status = await getMitmStatus();
    return NextResponse.json({ success: true, dnsStatus: status.dnsStatus });
  } catch (error) {
    console.log("Error toggling DNS:", error.message);
    return NextResponse.json({ error: error.message || "Failed to toggle DNS" }, { status: 500 });
  }
}
