import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { promisify } from "node:util";

// Evaluate only the networking portion: the real entrypoint binds :443, kills
// listeners on that port and registers hosts-cleanup signal handlers.
const serverPath = fileURLToPath(new URL("../../src/mitm/server.js", import.meta.url));
const source = fs.readFileSync(serverPath, "utf8").split("// Kill only processes LISTENING")[0];

function harness({ dnsError, dnsAddresses = ["8.8.4.4"], dnsHang = false, protocol = "http/1.1", tlsError, tlsHang = false, httpsHang = false, onHttpsRequest, onH2Connect } = {}) {
  const calls = { dns: 0, tls: [], sockets: [], https: [], h2: [] };
  let handler;
  class Resolver {
    setServers() {}
    resolve4(host, cb) {
      calls.dns++;
      if (!dnsHang) queueMicrotask(() => cb(dnsError || null, dnsError ? undefined : dnsAddresses));
    }
    cancel() {}
  }
  const fakeTls = {
    connect(options, callback) {
      calls.tls.push(options);
      const socket = new EventEmitter();
      calls.sockets.push(socket);
      socket.alpnProtocol = protocol;
      socket.setTimeout = vi.fn((ms, fn) => { socket.timeout = fn; });
      socket.end = vi.fn();
      socket.destroy = vi.fn(error => { if (error) socket.emit("error", error); });
      if (!tlsHang) queueMicrotask(() => {
        const failure = typeof tlsError === "function" ? tlsError(options) : tlsError;
        if (failure) socket.emit("error", failure);
        else { socket.emit("secureConnect"); callback?.(); }
      });
      return socket;
    },
    createSecureContext: vi.fn(),
  };
  const fakeHttps = {
    createServer(_options, callback) { handler = callback; return {}; },
    request(options, callback) {
      calls.https.push(options);
      const request = new EventEmitter();
      request.write = vi.fn();
      request.end = vi.fn();
      request.destroy = vi.fn(error => { if (error) request.emit("error", error); });
      request.setTimeout = vi.fn((ms, fn) => { request.timeout = fn; });
      queueMicrotask(() => {
        const socket = new EventEmitter();
        socket.setTimeout = vi.fn((ms, fn) => { socket.timeout = fn; });
        request.emit("socket", socket);
        if (!httpsHang) socket.emit("secureConnect");
        onHttpsRequest?.({ request, callback, socket });
      });
      return request;
    },
  };
  const fakeH2 = {
    connect(url, options) {
      calls.h2.push({ url, options });
      const client = new EventEmitter();
      client.close = vi.fn();
      client.request = vi.fn(() => {
        const stream = new EventEmitter();
        stream.setTimeout = vi.fn((ms, fn) => { stream.timeout = fn; });
        stream.end = vi.fn();
        stream.close = vi.fn();
        stream.destroy = vi.fn(error => { if (error) stream.emit("error", error); });
        stream.pause = vi.fn();
        stream.resume = vi.fn();
        client.stream = stream;
        return stream;
      });
      onH2Connect?.(client, options);
      return client;
    },
  };
  const mockRequire = id => ({
    https: fakeHttps, http2: fakeH2, tls: fakeTls,
    fs: { existsSync: () => true, readFileSync: () => Buffer.from("cert") },
    path, net, dns: { Resolver }, util: { promisify },
    child_process: { execSync: vi.fn() },
    "./logger": { log: vi.fn(), err: vi.fn(), clearDumpDir: vi.fn() },
    "./config": { IS_DEV: false, TARGET_HOSTS: ["upstream.test"], MODEL_NO_MAP: {},
      getToolForHost: () => null, isChatRequest: () => false },
    "./paths": { MITM_DIR: "/unused", DATA_DIR: "/unused" },
    "./cert/generate": { generateCert: vi.fn(), getCertForDomain: vi.fn() },
    "./dbReader": { getMitmAlias: () => null },
    "./antigravityIdeVersion": { applyAntigravityIdeVersionOverride: vi.fn() },
    "./handlers/antigravity": {}, "./handlers/copilot": {},
    "./handlers/kiro": {}, "./handlers/cursor": {},
  })[id];
  const context = { require: mockRequire, module: { exports: {} }, Buffer, Date, Map,
    console, process: { platform: "win32", pid: 1 }, setTimeout, clearTimeout };
  vm.runInNewContext(source + "\nmodule.exports = { passthrough, negotiateAlpn };", context, { filename: serverPath });
  return { ...context.module.exports, calls, handler, fakeH2 };
}

function response() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.body = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.write = vi.fn(chunk => { res.body.push(chunk); return true; });
  res.end = vi.fn(chunk => {
    if (chunk) res.body.push(chunk);
    res.writableEnded = true;
    res.emit("close");
  });
  res.destroy = vi.fn(() => { res.destroyed = true; res.emit("close"); });
  return res;
}

const request = (method = "GET") => Object.assign(Readable.from([]), {
  headers: { host: "upstream.test" }, url: "/path", method,
});

function upstreamResponse(callback) {
  const upstream = new EventEmitter();
  upstream.statusCode = 200;
  upstream.headers = { "content-type": "text/plain" };
  upstream.pause = vi.fn();
  upstream.resume = vi.fn();
  callback(upstream);
  return upstream;
}

describe("MITM upstream networking (no port 443 or hosts changes)", () => {
  it("catches an ALPN DNS rejection in the request handler without a second lookup", async () => {
    const app = harness({ dnsError: new Error("DNS unavailable") });
    const res = response();
    await app.handler(request(), res);
    expect(res.status).toBe(502);
    expect(app.calls.dns).toBe(1);
    expect(app.calls.https).toHaveLength(0);
  });

  it("does not downgrade on TLS verification failure", async () => {
    const app = harness({ tlsError: new Error("self-signed certificate") });
    const res = response();
    await app.handler(request(), res);
    expect(res.status).toBe(502);
    expect(app.calls.dns).toBe(1);
    expect(app.calls.https).toHaveLength(0);
    expect(app.calls.tls[0].rejectUnauthorized).toBe(true);
  });

  it("rejects DNS answers containing only loopback, private and reserved addresses", async () => {
    const app = harness({ dnsAddresses: ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.1.2", "203.0.113.2", "not-an-ip"] });
    const res = response();
    await app.handler(request(), res);
    expect(res.status).toBe(502);
    expect(app.calls.tls).toHaveLength(0);
    expect(app.calls.https).toHaveLength(0);
  });

  it("rotates failed ALPN IPs, never selects loopback, and does not replay a POST", async () => {
    const app = harness({
      dnsAddresses: ["127.0.0.1", "8.8.4.4", "10.0.0.1", "1.1.1.1", "8.8.4.4"],
      tlsError: options => options.host === "8.8.4.4" ? new Error("connect refused") : null,
      onHttpsRequest: ({ callback }) => queueMicrotask(() => upstreamResponse(callback).emit("end")),
    });
    const first = response();
    await app.handler(request("POST"), first);
    expect(first.status).toBe(502);
    expect(app.calls.tls.map(call => call.host)).toEqual(["8.8.4.4"]);
    expect(app.calls.https).toHaveLength(0);

    const second = response();
    await app.handler(request("POST"), second);
    expect(second.status).toBe(200);
    expect(app.calls.tls.map(call => call.host)).toEqual(["8.8.4.4", "1.1.1.1"]);
    expect(app.calls.https.map(call => call.hostname)).toEqual(["1.1.1.1"]);
    expect(app.calls.dns).toBe(1);
  });

  it("bounds DNS stalls without making a second lookup", async () => {
    vi.useFakeTimers();
    try {
      const app = harness({ dnsHang: true });
      const res = response();
      const pending = app.handler(request(), res);
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
      expect(res.status).toBe(502);
      expect(app.calls.dns).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it("bounds a stalled ALPN handshake", async () => {
    const app = harness({ tlsHang: true });
    const res = response();
    const pending = app.handler(request(), res);
    await vi.waitFor(() => expect(app.calls.tls).toHaveLength(1));
    expect(app.calls.tls[0].rejectUnauthorized).toBe(true);
    app.calls.sockets[0].timeout();
    await pending;
    expect(res.status).toBe(502);
  });

  it("streams HTTPS with backpressure, validated TLS and response inspection", async () => {
    let upstream;
    const app = harness({ onHttpsRequest: ({ callback }) => {
      upstream = upstreamResponse(callback);
      queueMicrotask(() => upstream.emit("data", Buffer.from("one")));
    } });
    const res = response();
    res.write.mockImplementationOnce(chunk => { res.body.push(chunk); return false; });
    const inspected = vi.fn();
    const pending = app.passthrough(request(), res, Buffer.alloc(0), inspected);
    await vi.waitFor(() => expect(upstream?.pause).toHaveBeenCalled());
    res.emit("drain");
    expect(upstream.resume).toHaveBeenCalled();
    upstream.emit("data", Buffer.from("two"));
    upstream.emit("end");
    await pending;
    expect(app.calls.https[0].rejectUnauthorized).toBe(true);
    expect(app.calls.https[0].servername).toBe("upstream.test");
    expect(res.body.map(String)).toEqual(["one", "two"]);
    expect(inspected.mock.calls[0][0].toString()).toBe("onetwo");
  });

  it("turns an HTTPS socket failure into a single 502", async () => {
    const app = harness({ onHttpsRequest: ({ request }) => request.emit("error", new Error("refused")) });
    const res = response();
    await app.handler(request(), res);
    expect(res.status).toBe(502);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached ALPN and rotates on HTTPS failures without replaying POST", async () => {
    let attempts = 0;
    const app = harness({ dnsAddresses: ["8.8.4.4", "1.1.1.1"], onHttpsRequest: ({ request: outgoing, callback }) => {
      attempts++;
      if (attempts === 1) outgoing.emit("error", new Error("connection reset"));
      else queueMicrotask(() => upstreamResponse(callback).emit("end"));
    } });
    const first = response();
    await app.handler(request("POST"), first);
    expect(first.status).toBe(502);
    expect(attempts).toBe(1);
    const second = response();
    await app.handler(request("POST"), second);
    expect(second.status).toBe(200);
    expect(app.calls.https.map(call => call.hostname)).toEqual(["8.8.4.4", "1.1.1.1"]);
    expect(app.calls.tls.map(call => call.host)).toEqual(["8.8.4.4", "1.1.1.1"]);
  });

  it("bounds an HTTPS connection stall", async () => {
    const app = harness({ httpsHang: true, onHttpsRequest: ({ socket }) => socket.timeout() });
    const res = response();
    await app.handler(request(), res);
    expect(res.status).toBe(502);
    expect(app.calls.https[0].rejectUnauthorized).toBe(true);
  });

  it("destroys a partial response rather than appending a gateway error", async () => {
    const app = harness({ onHttpsRequest: ({ callback }) => {
      const upstream = upstreamResponse(callback);
      queueMicrotask(() => {
        upstream.emit("data", Buffer.from("partial"));
        upstream.emit("error", new Error("truncated"));
      });
    } });
    const res = response();
    await app.handler(request(), res);
    expect(res.status).toBe(200);
    expect(res.destroy).toHaveBeenCalledOnce();
    expect(res.body.map(String)).toEqual(["partial"]);
  });

  it("shares a single ALPN handshake across concurrent requests", async () => {
    const app = harness();
    const results = await Promise.all(Array.from({ length: 10 }, () => app.negotiateAlpn("upstream.test")));
    expect(results).toEqual(Array(10).fill("http/1.1"));
    expect(app.calls.dns).toBe(1);
    expect(app.calls.tls).toHaveLength(1);
  });

  it("streams HTTP/2 responses and respects downstream backpressure", async () => {
    let client;
    const app = harness({ protocol: "h2", onH2Connect: session => { client = session; } });
    const res = response();
    res.write.mockImplementationOnce(chunk => { res.body.push(chunk); return false; });
    const inspected = vi.fn();
    const pending = app.passthrough(request(), res, Buffer.from("request"), inspected);
    await vi.waitFor(() => expect(client?.stream).toBeDefined());
    client.stream.emit("response", { ":status": 201, "content-type": "text/plain" });
    client.stream.emit("data", Buffer.from("h2 data"));
    expect(client.stream.pause).toHaveBeenCalledOnce();
    res.emit("drain");
    expect(client.stream.resume).toHaveBeenCalledOnce();
    client.stream.emit("end");
    await pending;
    expect(res.status).toBe(201);
    expect(res.body.map(String)).toEqual(["h2 data"]);
    expect(inspected.mock.calls[0][0].toString()).toBe("h2 data");
    expect(client.stream.end).toHaveBeenCalledWith(Buffer.from("request"));
  });

  it("rotates after HTTP/2 failure and re-negotiates ALPN on the next request", async () => {
    let attempts = 0;
    const app = harness({ dnsAddresses: ["8.8.4.4", "1.1.1.1"], protocol: "h2",
      onH2Connect: (session, options) => {
        attempts++;
        options.createConnection();
        if (attempts === 1) queueMicrotask(() => session.stream.emit("error", new Error("h2 connect failed")));
        else queueMicrotask(() => {
          session.stream.emit("response", { ":status": 200 });
          session.stream.emit("end");
        });
      },
    });
    const first = response();
    await app.handler(request("POST"), first);
    expect(first.status).toBe(502);
    expect(attempts).toBe(1);
    const second = response();
    await app.handler(request("POST"), second);
    expect(second.status).toBe(200);
    expect(app.calls.tls.map(call => call.host)).toEqual(["8.8.4.4", "8.8.4.4", "1.1.1.1", "1.1.1.1"]);
    expect(app.calls.tls.every(call => call.rejectUnauthorized)).toBe(true);
    expect(app.calls.dns).toBe(1);
  });

  it("rotates when an HTTP/2 response idles out, without retrying the POST", async () => {
    let attempts = 0;
    const app = harness({ dnsAddresses: ["8.8.4.4", "1.1.1.1"], protocol: "h2",
      onH2Connect: (session, options) => {
        options.createConnection();
        attempts++;
        queueMicrotask(() => {
          if (attempts === 1) session.stream.timeout();
          else {
            session.stream.emit("response", { ":status": 200 });
            session.stream.emit("end");
          }
        });
      },
    });
    const first = response();
    await app.handler(request("POST"), first);
    expect(first.status).toBe(502);
    expect(attempts).toBe(1);
    const second = response();
    await app.handler(request("POST"), second);
    expect(second.status).toBe(200);
    expect(app.calls.tls.at(-1).host).toBe("1.1.1.1");
  });

  it("does not skip a candidate when concurrent requests fail on the same IP", async () => {
    const sessions = [];
    const app = harness({ dnsAddresses: ["8.8.4.4", "1.1.1.1", "9.9.9.9"], protocol: "h2",
      onH2Connect: (session, options) => {
        options.createConnection();
        sessions.push(session);
        if (sessions.length === 3) queueMicrotask(() => {
          session.stream.emit("response", { ":status": 200 });
          session.stream.emit("end");
        });
      },
    });
    const first = app.handler(request(), response());
    const second = app.handler(request(), response());
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[0].stream.emit("error", new Error("refused"));
    sessions[1].stream.emit("error", new Error("refused"));
    await Promise.all([first, second]);
    const res = response();
    await app.handler(request(), res);
    expect(res.status).toBe(200);
    expect(app.calls.h2).toHaveLength(3);
    expect(app.calls.tls.at(-1).host).toBe("1.1.1.1");
  });

  it("bounds HTTP/2 failures and uses validated TLS", async () => {
    let client;
    const app = harness({ protocol: "h2", onH2Connect: (session, options) => {
      client = session;
      options.createConnection();
      queueMicrotask(() => session.stream.emit("error", new Error("h2 refused")));
    } });
    const res = response();
    await app.handler(request(), res);
    expect(res.status).toBe(502);
    expect(app.calls.tls[1].rejectUnauthorized).toBe(true);
    expect(client.stream.setTimeout).toHaveBeenCalledWith(360000, expect.any(Function));
  });
});
