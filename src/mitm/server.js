const https = require("https");
const http2 = require("http2");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const net = require("net");
const { promisify } = require("util");
const { execSync } = require("child_process");
const { log, err, dumpRequest, createResponseDumper, clearDumpDir } = require("./logger");
const { IS_DEV, LSOF_BIN, TARGET_HOSTS, URL_PATTERNS, MODEL_SYNONYMS, MODEL_PATTERNS, MODEL_NO_MAP, getToolForHost, isChatRequest, extractModel } = require("./config");
const { DATA_DIR, MITM_DIR } = require("./paths");
const { generateCert, getCertForDomain } = require("./cert/generate");
const { getMitmAlias } = require("./dbReader");
const { applyAntigravityIdeVersionOverride } = require("./antigravityIdeVersion");
const LOCAL_PORT = 443;
const IS_WIN = process.platform === "win32";
const ENABLE_FILE_LOG = IS_DEV;

// Clear stale dump files on every MITM start (prevents unbounded disk usage)
clearDumpDir();
const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };

// Host rewrite for upstream forward: PROD cloudcode-pa is rate-limited (429),
// daily-cloudcode-pa (dev endpoint) accepts same body+token. Same trick as open-sse.
const HOST_REWRITE = {
  "cloudcode-pa.googleapis.com": "daily-cloudcode-pa.googleapis.com",
};

const handlers = {
  antigravity: require("./handlers/antigravity"),
  copilot: require("./handlers/copilot"),
  kiro: require("./handlers/kiro"),
  cursor: require("./handlers/cursor"),
};

// ── SSL / SNI ─────────────────────────────────────────────────

const certCache = new Map();
let rootCAPem;

function sniCallback(servername, cb) {
  try {
    if (certCache.has(servername)) return cb(null, certCache.get(servername));
    const certData = getCertForDomain(servername);
    if (!certData) return cb(new Error(`Failed to generate cert for ${servername}`));
    const ctx = require("tls").createSecureContext({
      key: certData.key,
      cert: `${certData.cert}\n${rootCAPem}`
    });
    certCache.set(servername, ctx);
    cb(null, ctx);
  } catch (e) {
    err(`SNI error for ${servername}: ${e.message}`);
    cb(e);
  }
}

let sslOptions;
try {
  if (!fs.existsSync(path.join(MITM_DIR, "rootCA.key")) || !fs.existsSync(path.join(MITM_DIR, "rootCA.crt"))) {
    log("Root CA missing, generating...");
    generateCert();
  }

  const rootKey = fs.readFileSync(path.join(MITM_DIR, "rootCA.key"));
  const rootCert = fs.readFileSync(path.join(MITM_DIR, "rootCA.crt"));
  rootCAPem = rootCert.toString("utf8");
  sslOptions = { key: rootKey, cert: rootCert, SNICallback: sniCallback };
} catch (e) {
  err(`Root CA not found: ${e.message}`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────

const cachedTargetIPs = Object.create(null);
const CACHE_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 5000;
// Match the gateway's generous stream-stall window so slow reasoning does not abort.
const RESPONSE_IDLE_TIMEOUT_MS = 360 * 1000;
const pendingDNS = new Map();

function isPublicIPv4(ip) {
  // Never connect back to the local MITM listener (or private/reserved DNS answers).
  if (net.isIP(ip) !== 4) return false;
  const [a, b, c, d] = ip.split(".").map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && c === 0 && d !== 9 && d !== 10) || (b === 88 && c === 99) || (b === 0 && c === 2))) &&
    !(a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113);
}

function rotateTargetIP(hostname, ip) {
  const cached = cachedTargetIPs[hostname];
  // Concurrent failures for the old IP must not skip the next candidate.
  if (!cached || cached.ips[cached.index] !== ip) return;
  cached.index = (cached.index + 1) % cached.ips.length;
  alpnCache.delete(hostname);
  log(`[mitm] Upstream ${hostname} ${ip} failed; next IP ${cached.ips[cached.index]}`);
}

async function resolveTargetIP(hostname) {
  const cached = cachedTargetIPs[hostname];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ips[cached.index];
  if (pendingDNS.has(hostname)) return pendingDNS.get(hostname);

  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8", "8.8.4.4"]);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  let timer;
  let expired = false;
  const lookup = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      resolver.cancel();
      reject(new Error(`DNS timeout for ${hostname}`));
    }, CONNECT_TIMEOUT_MS);
    resolve4(hostname).then(addresses => {
      if (expired) return;
      const ips = [...new Set(addresses.filter(isPublicIPv4))];
      if (!ips.length) return reject(new Error(`No public IPv4 address for ${hostname}`));
      cachedTargetIPs[hostname] = { ips, index: 0, ts: Date.now() };
      resolve(ips[0]);
    }, reject);
  }).finally(() => clearTimeout(timer));
  pendingDNS.set(hostname, lookup);
  try { return await lookup; }
  finally { pendingDNS.delete(hostname); }
}

function collectBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Client aborted request")));
  });
}

function getMappedModel(tool, model) {
  if (!model) return null;
  try {
    const aliases = getMitmAlias(tool);
    if (!aliases) return null;
    // Normalize via synonym map (e.g., public AG names -> backend model ids)
    const normalizedModel = String(model).replace(/^models\//, "");
    const lookup = MODEL_SYNONYMS?.[tool]?.[normalizedModel] || normalizedModel;
    if (aliases[lookup]) return aliases[lookup];
    // Prefix match fallback
    const prefixKey = Object.keys(aliases).find(k => k && aliases[k] && (lookup.startsWith(k) || k.startsWith(lookup)));
    if (prefixKey) return aliases[prefixKey];
    // Pattern fallback: catches AG renamed variants (e.g. deprecated pro IDs → gemini-pro-agent)
    const patterns = MODEL_PATTERNS?.[tool] || [];
    for (const { match, alias } of patterns) {
      if (match.test(lookup) && aliases[alias]) return aliases[alias];
    }
    return null;
  } catch { return null; }
}

/**
 * Forward request to real upstream.
 * Optional onResponse(rawBuffer) callback — if provided, tees the response
 * so it's both forwarded to client AND passed to the callback for inspection.
 * Also tees full stream into a dump file when ENABLE_FILE_LOG is on.
 */
async function passthrough(req, res, bodyBuffer, onResponse) {
  const originalHost = (req.headers.host || TARGET_HOSTS[0]).split(":")[0];
  // Only rewrite host for chat endpoints — daily-cloudcode-pa rejects auth/login requests
  const isChatEndpoint = req.url.includes(":generateContent") || req.url.includes(":streamGenerateContent");
  const targetHost = isChatEndpoint ? (HOST_REWRITE[originalHost] || originalHost) : originalHost;
  const dumper = ENABLE_FILE_LOG ? createResponseDumper(req, "passthrough") : null;

  const tool = getToolForHost(req.headers.host);
  const versionOverride = tool === "antigravity"
    ? applyAntigravityIdeVersionOverride(bodyBuffer, req.headers, req.url)
    : { bodyBuffer, headers: req.headers };
  const bodyForForwarding = versionOverride.bodyBuffer;
  const headersForForwarding = { ...versionOverride.headers, host: targetHost };
  if (bodyForForwarding !== bodyBuffer) {
    headersForForwarding["content-length"] = String(bodyForForwarding.length);
  }

  // A failed ALPN handshake (including DNS/TLS failure) cannot safely fall back:
  // that would repeat DNS and possibly mask an invalid upstream certificate.
  let proto;
  try { proto = await negotiateAlpn(targetHost); }
  catch (e) {
    failUpstream(res, dumper, e);
    return;
  }
  try {
    if (proto === "h2") {
      return await passthroughHttp2(req, res, bodyForForwarding, headersForForwarding, targetHost, onResponse, dumper);
    }
    return await passthroughHttps(req, res, bodyForForwarding, headersForForwarding, targetHost, onResponse, dumper);
  } catch (e) {
    failUpstream(res, dumper, e);
  }
}

// ── ALPN negotiation cache ────────────────────────────────────
const alpnCache = new Map(); // host → negotiated protocol or in-flight promise
async function negotiateAlpn(host) {
  if (alpnCache.has(host)) return alpnCache.get(host);
  const pending = (async () => {
    const ip = await resolveTargetIP(host);
    try { return await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: ip, port: 443, servername: host,
        ALPNProtocols: ["h2", "http/1.1"], rejectUnauthorized: true,
      }, () => {
        const proto = socket.alpnProtocol || "http/1.1";
        log(`🔗 [mitm] ALPN ${host} → ${proto}`);
        socket.end();
        resolve(proto);
      });
      socket.on("error", reject);
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error("ALPN timeout")));
    }); }
    catch (e) { rotateTargetIP(host, ip); throw e; }
  })();
  alpnCache.set(host, pending);
  try {
    const proto = await pending;
    if (alpnCache.get(host) === pending) alpnCache.set(host, proto);
    return proto;
  } catch (e) {
    if (alpnCache.get(host) === pending) alpnCache.delete(host);
    throw e;
  }
}

function failUpstream(res, dumper, error) {
  err(`[mitm] Upstream error: ${error.message}`);
  if (dumper) { dumper.writeChunk(`\n[ERROR] ${error.message}\n`); dumper.end(); }
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) res.destroy();
  else { res.writeHead(502); res.end("Bad Gateway"); }
}

function forwardChunk(source, res, chunk, dumper, chunks) {
  if (res.destroyed || res.writableEnded) return;
  if (dumper) dumper.writeChunk(chunk);
  if (chunks) chunks.push(chunk);
  if (!res.write(chunk)) {
    source.pause();
    res.once("drain", () => source.resume());
  }
}

// HTTP/2 passthrough using node:http2 native
async function passthroughHttp2(req, res, bodyBuffer, headers, targetHost, onResponse, dumper) {
  const targetIP = await resolveTargetIP(targetHost);
  // HTTP/2 pseudo-headers required; strip HTTP/1.1-only headers
  const h2Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "keep-alive" ||
        lk === "transfer-encoding" || lk === "upgrade" || lk === "proxy-connection") continue;
    h2Headers[lk] = v;
  }
  h2Headers[":method"] = req.method;
  h2Headers[":path"] = req.url;
  h2Headers[":scheme"] = "https";
  h2Headers[":authority"] = targetHost;

  return new Promise((resolve) => {
    let done = false;
    let stream;
    const client = http2.connect(`https://${targetHost}`, {
      createConnection: () => {
        const socket = tls.connect({
          host: targetIP, port: 443, servername: targetHost,
          ALPNProtocols: ["h2"], rejectUnauthorized: true,
        });
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error("HTTP/2 connect timeout")));
        socket.once("secureConnect", () => socket.setTimeout(0));
        return socket;
      },
    });
    const finish = (error) => {
      if (done) return;
      done = true;
      res.off("close", onClose);
      if (error) {
        rotateTargetIP(targetHost, targetIP);
        failUpstream(res, dumper, error);
      } else if (dumper) dumper.end();
      if (stream && !stream.destroyed) stream.close();
      try { client.close(); } catch {}
      resolve();
    };
    const onClose = () => {
      if (!res.writableEnded) finish();
    };
    res.once("close", onClose);
    client.on("error", finish);
    client.once("close", () => { if (!done) finish(new Error("HTTP/2 session closed")); });

    try {
      stream = client.request(h2Headers, { endStream: bodyBuffer.length === 0 });
      stream.setTimeout(RESPONSE_IDLE_TIMEOUT_MS, () => stream.destroy(new Error("HTTP/2 response timeout")));
      stream.on("error", finish);
      stream.once("close", () => { if (!done) finish(new Error("HTTP/2 stream closed")); });
      stream.once("response", (responseHeaders) => {
        if (done) return;
        const status = responseHeaders[":status"];
        // Filter pseudo-headers + connection-specific
        const outHeaders = {};
        for (const [k, v] of Object.entries(responseHeaders)) {
          if (k.startsWith(":")) continue;
          if (k === "connection" || k === "keep-alive" || k === "transfer-encoding") continue;
          outHeaders[k] = v;
        }
        res.writeHead(status, outHeaders);
        if (dumper) dumper.writeHeader(status, outHeaders);

        const chunks = onResponse ? [] : null;
        stream.on("data", chunk => forwardChunk(stream, res, chunk, dumper, chunks));
        stream.once("end", () => {
          if (done) return;
          if (!res.writableEnded) res.end();
          if (onResponse) try { onResponse(Buffer.concat(chunks), outHeaders); } catch {}
          finish();
        });
      });
      if (bodyBuffer.length > 0) stream.end(bodyBuffer);
    } catch (e) { finish(e); }
  });
}

// Fallback: raw https.request HTTP/1.1 with custom DNS (bypasses /etc/hosts MITM loop)
async function passthroughHttps(req, res, bodyBuffer, headers, targetHost, onResponse, dumper) {
  const targetIP = await resolveTargetIP(targetHost);
  return new Promise((resolve) => {
    let done = false;
    const forwardReq = https.request({
      hostname: targetIP,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
      servername: targetHost,
      rejectUnauthorized: true
    }, (forwardRes) => {
      if (done) { forwardRes.destroy(); return; }
      res.writeHead(forwardRes.statusCode, forwardRes.headers);
      if (dumper) dumper.writeHeader(forwardRes.statusCode, forwardRes.headers);

      const chunks = onResponse ? [] : null;
      forwardRes.on("data", chunk => forwardChunk(forwardRes, res, chunk, dumper, chunks));
      forwardRes.once("end", () => {
        if (done) return;
        if (!res.writableEnded) res.end();
        if (onResponse) try { onResponse(Buffer.concat(chunks), forwardRes.headers); } catch { /* ignore */ }
        finish();
      });
      forwardRes.on("error", finish);
      forwardRes.once("close", () => { if (!done) finish(new Error("HTTPS response closed")); });
    });
    const finish = (error) => {
      if (done) return;
      done = true;
      res.off("close", onClose);
      if (error) {
        rotateTargetIP(targetHost, targetIP);
        failUpstream(res, dumper, error);
      } else if (dumper) dumper.end();
      if (error) forwardReq.destroy();
      resolve();
    };
    const onClose = () => {
      if (!res.writableEnded) { forwardReq.destroy(); finish(); }
    };
    res.once("close", onClose);
    forwardReq.on("error", finish);
    forwardReq.on("socket", socket => {
      const setIdleTimeout = () => forwardReq.setTimeout(RESPONSE_IDLE_TIMEOUT_MS,
        () => forwardReq.destroy(new Error("HTTPS response timeout")));
      if (socket.authorized && !socket.connecting) setIdleTimeout();
      else {
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => forwardReq.destroy(new Error("HTTPS connect timeout")));
        socket.once("secureConnect", setIdleTimeout);
      }
    });
    if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
    forwardReq.end();
  });
}

// ── Request handler ───────────────────────────────────────────

const server = https.createServer(sslOptions, async (req, res) => {
  try {
    if (req.url === "/_mitm_health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    const bodyBuffer = await collectBodyRaw(req);
    if (ENABLE_FILE_LOG) dumpRequest(req, bodyBuffer, "raw");

    // Anti-loop: skip requests from 9Router
    if (req.headers[INTERNAL_REQUEST_HEADER.name] === INTERNAL_REQUEST_HEADER.value) {
      return await passthrough(req, res, bodyBuffer);
    }

    const tool = getToolForHost(req.headers.host);
    if (!tool) return await passthrough(req, res, bodyBuffer);

    // Kiro IDE posts chat to `/` with x-amz-target (not path /generateAssistantResponse)
    if (!isChatRequest(tool, req)) return await passthrough(req, res, bodyBuffer);

    // Cursor uses binary proto — model extraction not possible at this layer.
    // Delegate directly to handler which decodes proto internally.
    if (tool === "cursor") {
      return await handlers[tool].intercept(req, res, bodyBuffer, null, passthrough);
    }

    const model = extractModel(req.url, bodyBuffer);

    // Intentional passthrough: some models must never be re-routed (e.g. Antigravity
    // tab-autocomplete) so latency-critical inline completion stays native. Silent — this
    // is by design, not a leak, and fires per keystroke. See MODEL_NO_MAP in config.js.
    if (model && (MODEL_NO_MAP[tool] || []).some((re) => re.test(model))) {
      return await passthrough(req, res, bodyBuffer);
    }

    const mappedModel = getMappedModel(tool, model);
    if (!mappedModel) {
      return await passthrough(req, res, bodyBuffer);
    }

    return await handlers[tool].intercept(req, res, bodyBuffer, mappedModel, passthrough);
  } catch (e) {
    err(`Unhandled error: ${e.message}`);
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message, type: "mitm_error" } }));
    }
  }
});

// Kill only processes LISTENING on LOCAL_PORT (not outbound connections)
function killPort(port) {
  try {
    let pidList = [];
    if (IS_WIN) {
      const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command ` +
        `"Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`;
      const out = execSync(psCmd, { encoding: "utf-8", windowsHide: true }).trim();
      if (!out) return;
      pidList = out.split(/\r?\n/).map(s => s.trim()).filter(p => p && Number(p) !== process.pid && Number(p) > 4);
    } else {
      const out = execSync(`${LSOF_BIN} -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: "utf-8", windowsHide: true }).trim();
      if (!out) return;
      pidList = out.split("\n").filter(p => p && Number(p) !== process.pid);
    }
    if (pidList.length === 0) return;
    pidList.forEach(pid => {
      try {
        if (IS_WIN) execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
        else process.kill(Number(pid), "SIGKILL");
      } catch (e) {
        err(`Failed to kill PID ${pid}: ${e.message}`);
      }
    });
    log(`Killed ${pidList.length} process(es) on port ${port}`);
  } catch (e) {
    if (e.status !== 1) throw e;
  }
}

try {
  killPort(LOCAL_PORT);
} catch (e) {
  err(`Cannot kill process on port ${LOCAL_PORT}: ${e.message}`);
  process.exit(1);
}

server.listen(LOCAL_PORT, () => log(`🚀 Server ready on :${LOCAL_PORT}`));

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") err(`Port ${LOCAL_PORT} already in use`);
  else if (e.code === "EACCES") err(`Permission denied for port ${LOCAL_PORT}`);
  else err(e.message);
  process.exit(1);
});

const { removeAllDNSEntriesSync } = require("./dns/dnsConfig");
let isShuttingDown = false;
const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  // Strip tool hosts from /etc/hosts so other apps aren't broken after exit
  removeAllDNSEntriesSync();
  const forceExit = setTimeout(() => process.exit(0), 1500);
  server.close(() => { clearTimeout(forceExit); process.exit(0); });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (process.platform === "win32") process.on("SIGBREAK", shutdown);
