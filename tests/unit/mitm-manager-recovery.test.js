import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const managerPath = fileURLToPath(new URL("../../src/mitm/manager.js", import.meta.url));
const source = fs.readFileSync(managerPath, "utf8");

function harness({ platform = "win32", savedDns = { antigravity: true, cursor: false }, healthFails = false,
  gracefulExitDelay = 0, forceExitDelay = 0, retainAliveOnTaskkill = false } = {}) {
  const files = new Map();
  const alive = new Set();
  const children = [];
  const settings = { mitmEnabled: true, dnsToolEnabled: { ...savedDns } };
  let nextPid = 200;
  let failHealth = healthFails;
  const addDNSEntry = vi.fn(async () => {});
  const removeDNSEntry = vi.fn(async () => {});
  const removeAllDNSEntries = vi.fn(async () => {});
  const log = vi.fn();
  const err = vi.fn();
  const fakeFs = {
    existsSync: p => p.endsWith("server.js") || p.endsWith("rootCA.crt") || p.endsWith("rootCA.key") || files.has(p),
    readFileSync: p => files.get(p) ?? "",
    writeFileSync: (p, value, options) => {
      if (options?.flag === "wx" && files.has(p)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(p, String(value));
    },
    unlinkSync: p => { if (!files.delete(p)) throw new Error("missing"); },
  };
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.killed = false;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn(signal => {
      child.killed = true;
      const delay = signal === "SIGKILL" ? forceExitDelay : gracefulExitDelay;
      if (delay === null) return true;
      if (delay) setTimeout(() => child.crash(0), delay);
      else child.crash(0);
      return true;
    });
    child.crash = code => {
      if (child.exitCode !== null) return;
      alive.delete(child.pid);
      child.exitCode = code;
      child.killed = true;
      child.emit("exit", code);
    };
    alive.add(child.pid);
    children.push(child);
    return child;
  });
  const exec = vi.fn((command, _opts, callback) => {
    if (command.startsWith("taskkill") && !retainAliveOnTaskkill) alive.delete(Number(command.match(/\d+$/)?.[0]));
    callback?.(null, "0");
  });
  const https = {
    request(_options, callback) {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        callback(response);
        response.emit("data", JSON.stringify(failHealth ? { ok: false } : { ok: true, pid: children.at(-1)?.pid }));
        response.emit("end");
      });
      return request;
    },
  };
  const net = {
    createServer() {
      const server = new EventEmitter();
      server.listen = () => queueMicrotask(() => server.emit("listening"));
      server.close = callback => callback();
      return server;
    },
  };
  const dnsConfig = {
    TOOL_HOSTS: { antigravity: ["a.test"], cursor: ["c.test"] },
    addDNSEntry,
    removeDNSEntry,
    removeAllDNSEntries,
    removeAllDNSEntriesSync: vi.fn(),
    checkAllDNSStatus: () => ({}),
    isSudoAvailable: () => true,
    isSudoPasswordRequired: () => false,
    execWithPassword: vi.fn(async () => {}),
  };
  const dependencies = {
    child_process: { exec, spawn, execSync: vi.fn(() => "0") },
    fs: fakeFs, path, os: { tmpdir: () => "/tmp", homedir: () => "/home/test" }, net, https,
    crypto: { createHash: () => ({ update: () => ({ digest: () => Buffer.alloc(32) }) }), randomBytes: () => Buffer.alloc(12),
      createCipheriv: () => ({ update: () => Buffer.from("pw"), final: () => Buffer.alloc(0), getAuthTag: () => Buffer.alloc(16) }),
      createDecipheriv: () => ({ setAuthTag: () => {}, update: () => "pw", final: () => "" }) },
    "./dns/dnsConfig": dnsConfig,
    "./winElevated.js": { isAdmin: () => true, runElevatedPowerShell: vi.fn(async () => {}), quotePs: s => s },
    "./cert/generate": { generateCert: vi.fn(async () => {}) },
    "./cert/install": { installCert: vi.fn(async () => {}), uninstallCert: vi.fn(async () => {}), checkCertInstalled: vi.fn(async () => true) },
    "./cert/rootCA": { isCertExpired: () => false },
    "./paths": { DATA_DIR: "/fake", MITM_DIR: "/fake" },
    "./logger": { log, err }, "./config": { LSOF_BIN: "lsof" },
  };
  const context = {
    require: id => {
      if (!(id in dependencies)) throw new Error(`Unexpected dependency ${id}`);
      return dependencies[id];
    },
    module: { exports: {} }, __dirname: path.dirname(managerPath), Buffer, Date, URL, setTimeout, clearTimeout,
    process: { platform, pid: 100, execPath: "/node", env: {}, cwd: () => "/fake",
      kill: (pid, signal) => {
        if (signal !== 0 || !alive.has(pid)) throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }, stdout: { write: vi.fn() } },
  };
  vm.runInNewContext(source, context, { filename: managerPath });
  const manager = context.module.exports;
  manager.initDbHooks(async () => settings, async updates => { Object.assign(settings, updates); });
  return { manager, settings, children, files, alive, spawn, addDNSEntry, removeDNSEntry, removeAllDNSEntries, log, err,
    setFailHealth: value => { failHealth = value; } };
}

afterEach(() => { vi.useRealTimers(); });

describe("MITM restart and DNS lifecycle (mocked, no ports or hosts writes)", () => {
  it("restores only saved enabled tools on manual start and when reusing a live PID", async () => {
    const app = harness();
    await app.manager.startServer("key");
    expect(app.addDNSEntry).toHaveBeenCalledExactlyOnceWith("antigravity", null);
    expect(app.settings.dnsToolEnabled).toEqual({ antigravity: true, cursor: false });

    const reused = harness();
    reused.files.set(path.join("/fake", ".mitm.pid"), "777");
    reused.alive.add(777);
    await reused.manager.startServer("key");
    expect(reused.spawn).not.toHaveBeenCalled();
    expect(reused.addDNSEntry).toHaveBeenCalledExactlyOnceWith("antigravity", null);
  });

  it("leaves preferences intact when DNS restoration fails", async () => {
    const app = harness();
    app.addDNSEntry.mockRejectedValueOnce(new Error("no permission"));
    await app.manager.startServer("key");
    expect(app.settings.dnsToolEnabled.antigravity).toBe(true);
    expect(app.err).toHaveBeenCalledWith(expect.stringContaining("DNS restore failed"));
  });

  it("removes redirects after a failed manual start with no listener", async () => {
    const app = harness({ healthFails: true });
    await expect(app.manager.startServer("key")).rejects.toThrow("MITM server failed to start");
    expect(app.removeAllDNSEntries).toHaveBeenCalledOnce();
    expect(app.settings.dnsToolEnabled.antigravity).toBe(true);
  });

  it("waits for an asynchronous child exit before cleaning up a failed health check", async () => {
    vi.useFakeTimers();
    const app = harness({ healthFails: true, gracefulExitDelay: 250 });
    const starting = app.manager.startServer("key");
    const rejected = expect(starting).rejects.toThrow("MITM server failed to start");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.children[0].kill).toHaveBeenCalledOnce();
    expect(app.removeAllDNSEntries).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(app.removeAllDNSEntries).not.toHaveBeenCalled();
    expect(app.alive.has(app.children[0].pid)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(app.removeAllDNSEntries).toHaveBeenCalledOnce();
    expect(app.alive.has(app.children[0].pid)).toBe(false);
    expect(app.settings.dnsToolEnabled.antigravity).toBe(true);
  });

  it("force-stops a child that ignores graceful termination before DNS cleanup", async () => {
    vi.useFakeTimers();
    const app = harness({ healthFails: true, gracefulExitDelay: null, forceExitDelay: 50 });
    const starting = app.manager.startServer("key");
    const rejected = expect(starting).rejects.toThrow("MITM server failed to start");
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.children[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(app.removeAllDNSEntries).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(app.removeAllDNSEntries).toHaveBeenCalledOnce();
  });

  it("cleans up after bounded force-stop even without an exit event, without retrying on a late exit", async () => {
    vi.useFakeTimers();
    const app = harness({ healthFails: true, gracefulExitDelay: null, forceExitDelay: null });
    const starting = app.manager.startServer("key");
    const rejected = expect(starting).rejects.toThrow("MITM server failed to start");
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(app.removeAllDNSEntries).toHaveBeenCalledOnce();
    app.children[0].crash(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(app.spawn).toHaveBeenCalledOnce();
  });

  it("does not reuse an unreaped failed child as a healthy server", async () => {
    vi.useFakeTimers();
    const app = harness({ healthFails: true, gracefulExitDelay: null, forceExitDelay: null,
      retainAliveOnTaskkill: true });
    const starting = app.manager.startServer("key");
    const rejected = expect(starting).rejects.toThrow("MITM server failed to start");
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(app.removeAllDNSEntries).toHaveBeenCalledOnce();
    await expect(app.manager.startServer("key")).rejects.toThrow("Previous MITM child has not exited");
    expect(app.spawn).toHaveBeenCalledOnce();
    app.children[0].crash(1);
    app.setFailHealth(false);
    await app.manager.startServer("key");
    expect(app.spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps the attempt count across short successful restarts and cleans DNS after the fifth crash", async () => {
    vi.useFakeTimers();
    const app = harness();
    await app.manager.startServer("key");
    const delays = [5000, 10000, 20000, 30000, 60000];
    for (const delay of delays) {
      app.children.at(-1).crash(1);
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(app.spawn).toHaveBeenCalledTimes(6);
    expect(app.addDNSEntry).toHaveBeenCalledTimes(6);
    app.children.at(-1).crash(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(app.removeAllDNSEntries).toHaveBeenCalledOnce();
    expect(app.settings.dnsToolEnabled.antigravity).toBe(true);
    await vi.advanceTimersByTimeAsync(120000);
    expect(app.spawn).toHaveBeenCalledTimes(6);
  });

  it("resets the retry budget after a sustained healthy run", async () => {
    vi.useFakeTimers();
    const app = harness();
    await app.manager.startServer("key");
    app.children.at(-1).crash(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(60001);
    app.children.at(-1).crash(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(app.spawn).toHaveBeenCalledTimes(3);
    expect(app.removeAllDNSEntries).not.toHaveBeenCalled();
  });

  it("cleans up after repeated failed starts without resetting the count against an old start time", async () => {
    vi.useFakeTimers();
    const app = harness();
    await app.manager.startServer("key");
    app.setFailHealth(true);
    app.children.at(-1).crash(1);
    await vi.advanceTimersByTimeAsync(130000);
    expect(app.spawn).toHaveBeenCalledTimes(6);
    // Every failed health check clears redirects, as does exhausted recovery.
    expect(app.removeAllDNSEntries).toHaveBeenCalledTimes(6);
    expect(app.settings.dnsToolEnabled.antigravity).toBe(true);
  });

  it("cleans redirects if recovery is disabled or credentials are unavailable", async () => {
    vi.useFakeTimers();
    const disabled = harness();
    await disabled.manager.startServer("key");
    disabled.settings.mitmEnabled = false;
    disabled.children.at(-1).crash(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(disabled.removeAllDNSEntries).toHaveBeenCalledOnce();
    expect(disabled.settings.dnsToolEnabled.antigravity).toBe(true);

    const missingPassword = harness({ platform: "linux" });
    const starting = missingPassword.manager.startServer("key", "password");
    await vi.advanceTimersByTimeAsync(500);
    await starting;
    missingPassword.manager.setCachedPassword(null);
    missingPassword.settings.mitmSudoEncrypted = null;
    missingPassword.children.at(-1).crash(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(missingPassword.removeAllDNSEntries).toHaveBeenCalledOnce();
  });

  it("cancels a delayed restart on stop and restores the preference on the next manual start", async () => {
    vi.useFakeTimers();
    const app = harness();
    await app.manager.startServer("key");
    app.children.at(-1).crash(1);
    const stopping = app.manager.stopServer();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);
    expect(app.spawn).toHaveBeenCalledOnce();
    expect(app.settings.dnsToolEnabled.antigravity).toBe(true);
    await app.manager.startServer("key");
    expect(app.addDNSEntry).toHaveBeenCalledTimes(2);
  });

  it("queues disable and exported restore behind startup DNS reconciliation", async () => {
    const app = harness();
    let finishRestore;
    app.addDNSEntry.mockImplementationOnce(() => new Promise(resolve => { finishRestore = resolve; }));
    const starting = app.manager.startServer("key");
    await vi.waitFor(() => expect(app.addDNSEntry).toHaveBeenCalledOnce());
    const disabling = app.manager.disableToolDNS("antigravity");
    const restoring = app.manager.restoreToolDNS();
    expect(app.removeDNSEntry).not.toHaveBeenCalled();
    finishRestore();
    await Promise.all([starting, disabling, restoring]);
    expect(app.removeDNSEntry).toHaveBeenCalledExactlyOnceWith("antigravity", null);
    expect(app.addDNSEntry).toHaveBeenCalledOnce();
    expect(app.settings.dnsToolEnabled.antigravity).toBe(false);
  });

  it("serializes enable and disable preference writes with an exported restore", async () => {
    const app = harness();
    await app.manager.startServer("key");
    let finishSave;
    let holdSave = true;
    app.manager.initDbHooks(async () => app.settings, async updates => {
      if (holdSave && updates.dnsToolEnabled?.cursor) {
        holdSave = false;
        await new Promise(resolve => { finishSave = resolve; });
      }
      Object.assign(app.settings, updates);
    });
    const enabling = app.manager.enableToolDNS("cursor");
    await vi.waitFor(() => expect(finishSave).toBeTypeOf("function"));
    const disabling = app.manager.disableToolDNS("antigravity");
    const restoring = app.manager.restoreToolDNS();
    expect(app.removeDNSEntry).not.toHaveBeenCalled();
    finishSave();
    await Promise.all([enabling, disabling, restoring]);
    expect(app.settings.dnsToolEnabled).toEqual({ antigravity: false, cursor: true });
    expect(app.removeDNSEntry).toHaveBeenCalledExactlyOnceWith("antigravity", null);
    expect(app.addDNSEntry).toHaveBeenCalledWith("cursor", null);
  });

  it("skips queued exported DNS restore after stop", async () => {
    vi.useFakeTimers();
    const app = harness();
    await app.manager.startServer("key");
    const stopping = app.manager.stopServer();
    const restoring = app.manager.restoreToolDNS();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(await restoring).toEqual({ restored: [], failed: [] });
    expect(app.addDNSEntry).toHaveBeenCalledOnce();
  });

  it("ignores a delayed exit from an old child after stop and start", async () => {
    vi.useFakeTimers();
    const app = harness();
    await app.manager.startServer("key");
    const oldChild = app.children[0];
    const stopping = app.manager.stopServer();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    await app.manager.startServer("key");
    oldChild.crash(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(app.spawn).toHaveBeenCalledTimes(2);
    expect((await app.manager.getMitmStatus()).running).toBe(true);
    expect(app.removeAllDNSEntries).not.toHaveBeenCalled();
  });

  it("waits for old recovery cleanup before a new manual start can restore DNS", async () => {
    vi.useFakeTimers();
    const app = harness();
    await app.manager.startServer("key");
    let finishCleanup;
    app.removeAllDNSEntries.mockImplementationOnce(() => new Promise(resolve => { finishCleanup = resolve; }));
    app.settings.mitmEnabled = false;
    app.children.at(-1).crash(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(app.removeAllDNSEntries).toHaveBeenCalledOnce();
    app.settings.mitmEnabled = true;
    const starting = app.manager.startServer("key");
    expect(app.spawn).toHaveBeenCalledOnce();
    finishCleanup();
    await starting;
    expect(app.spawn).toHaveBeenCalledTimes(2);
    expect(app.addDNSEntry).toHaveBeenCalledTimes(2);
  });
});
