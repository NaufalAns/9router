const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedRawId = null;
let cachedCliSecret = null;

function getDataDir() {
  if (process.env.DATA_DIR) {
    try {
      fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
      return process.env.DATA_DIR;
    } catch (e) {}
  }
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
    : path.join(os.homedir(), ".9router");
}

function readOrCreateFile(filePath, createValue) {
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (existing) return existing;
  } catch (e) {}

  const value = createValue();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, { mode: 0o600 });
  } catch (e) {}
  return value;
}

function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  const machineIdFile = path.join(getDataDir(), "machine-id");
  cachedRawId = readOrCreateFile(machineIdFile, () => {
    try {
      const { machineIdSync } = require("node-machine-id");
      return machineIdSync();
    } catch (e) {
      return crypto.randomUUID();
    }
  });
  return cachedRawId;
}

function loadCliSecret() {
  if (cachedCliSecret) return cachedCliSecret;
  const secretFile = path.join(getDataDir(), "auth", "cli-secret");
  cachedCliSecret = readOrCreateFile(secretFile, () => crypto.randomBytes(32).toString("hex"));
  return cachedCliSecret;
}

function getCliToken() {
  const raw = loadRawMachineId();
  const secret = loadCliSecret();
  return crypto.createHash("sha256").update(raw + CLI_TOKEN_SALT + secret).digest("hex").substring(0, 16);
}

async function requestMitm(port, method = "GET", body = null) {
  if (typeof fetch !== "function") {
    throw new Error("Node.js fetch API is unavailable");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cli-tools/antigravity-mitm`, {
      method,
      headers: {
        "Content-Type": "application/json",
        [CLI_TOKEN_HEADER]: getCliToken()
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getMitmTrayStatus(port) {
  return await requestMitm(port);
}

async function setAntigravityAutoStart(port, enabled) {
  return await requestMitm(port, "PATCH", {
    action: "set-antigravity-autostart",
    enabled: !!enabled
  });
}

module.exports = {
  getMitmTrayStatus,
  setAntigravityAutoStart
};
