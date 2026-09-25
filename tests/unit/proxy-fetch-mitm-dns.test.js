import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;
const proxyEnvNames = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
const originalProxyEnv = Object.fromEntries(proxyEnvNames.map((name) => [name, process.env[name]]));

let proxyAwareFetch;
let fetchMock;
let resolve4;
let systemLookup;
let agentOptions;
let resolverOptions;
let cancel;
let fetchBehavior;

function dispatcherLookup(dispatcher, hostname, options = { family: 4 }) {
  return new Promise((resolve, reject) => {
    dispatcher.connect.lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve(options.all ? address : { address, family });
    });
  });
}

describe("intercepted-host DNS bypass", () => {
  beforeEach(async () => {
    for (const name of proxyEnvNames) delete process.env[name];
    agentOptions = [];
    resolverOptions = [];
    resolve4 = vi.fn().mockResolvedValue(["142.250.1.1"]);
    cancel = vi.fn();
    systemLookup = vi.fn((hostname, _options, callback) => callback(null, "127.0.0.1", 4));
    fetchBehavior = async (url, options) => {
      if (options?.dispatcher?.connect) await dispatcherLookup(options.dispatcher, new URL(url instanceof Request ? url.url : url).hostname);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          controller.enqueue(new TextEncoder().encode(" second"));
          controller.close();
        },
      }), { status: 206, headers: { "x-stream": "yes" } });
    };
    fetchMock = vi.fn((url, options) => fetchBehavior(url, options));
    globalThis.fetch = fetchMock;
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      Resolver: class {
        constructor(options) { resolverOptions.push(options); }
        setServers(servers) { this.servers = servers; }
        resolve4(hostname) { return resolve4(hostname, this.servers); }
        cancel() { cancel(); }
      },
    }));
    vi.doMock("node:dns", () => ({ lookup: systemLookup }));
    vi.doMock("undici", () => ({
      Agent: class {
        constructor(options) { this.connect = options.connect; agentOptions.push(options); }
      },
      ProxyAgent: class {
        constructor(options) { this.uri = options.uri; }
      },
    }));
    ({ proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = nativeFetch;
    for (const name of proxyEnvNames) {
      if (originalProxyEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalProxyEnv[name];
    }
    vi.doUnmock("node:dns/promises");
    vi.doUnmock("node:dns");
    vi.doUnmock("undici");
    vi.resetModules();
  });

  it("keeps the HTTPS URL, headers, URLSearchParams body, signal and streaming Response intact", async () => {
    const url = "https://cloudcode-pa.googleapis.com:8443/v1/messages?next=1";
    const body = new URLSearchParams({ grant_type: "refresh_token", token: "secret" });
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", "x-custom": "value" });
    const signal = new AbortController().signal;
    const options = { method: "POST", body, headers, signal, redirect: "manual" };
    const response = await proxyAwareFetch(url, options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    expect(fetchMock.mock.calls[0][1]).toMatchObject(options);
    expect(fetchMock.mock.calls[0][1].body).toBe(body);
    expect(fetchMock.mock.calls[0][1].headers).toBe(headers);
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal);
    expect(Object.keys(agentOptions[0].connect).sort()).toEqual(["lookup", "timeout"]);
    expect(agentOptions[0].connect.timeout).toBeGreaterThan(0);
    expect(resolverOptions[0].timeout).toBeGreaterThan(0);
    expect(resolve4).toHaveBeenCalledWith("cloudcode-pa.googleapis.com", ["8.8.8.8", "8.8.4.4"]);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(206);
    expect(response.headers.get("x-stream")).toBe("yes");
    expect(await response.text()).toBe("first second");
  });

  it("supports Request inputs and binary bodies without changing the input", async () => {
    const body = new Uint8Array([0, 1, 255]);
    const request = new Request("https://api2.cursor.sh/upload", {
      method: "POST", body, headers: { "x-custom": "binary" },
    });
    await proxyAwareFetch(request);
    expect(fetchMock.mock.calls[0][0]).toBe(request);
    expect(fetchMock.mock.calls[0][1].dispatcher.connect).toBeDefined();
    expect(request.headers.get("x-custom")).toBe("binary");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(body);
  });

  it("uses the resolved public IP only for the socket lookup and caches it", async () => {
    const url = "https://api2.cursor.sh/path";
    await proxyAwareFetch(url, { method: "GET" });
    await proxyAwareFetch(url, { method: "GET" });
    expect(resolve4).toHaveBeenCalledTimes(1);
    expect(agentOptions).toHaveLength(1);
    expect(await dispatcherLookup(fetchMock.mock.calls[0][1].dispatcher, "api2.cursor.sh"))
      .toEqual({ address: "142.250.1.1", family: 4 });
    expect(systemLookup).not.toHaveBeenCalled();
  });

  it("returns an address array when Node requests all addresses for autoSelectFamily", async () => {
    await proxyAwareFetch("https://api2.cursor.sh/path");
    const dispatcher = fetchMock.mock.calls[0][1].dispatcher;
    expect(await dispatcherLookup(dispatcher, "api2.cursor.sh", { all: true, hints: 0 }))
      .toEqual([{ address: "142.250.1.1", family: 4 }]);
    expect(systemLookup).not.toHaveBeenCalled();
  });

  it("fails closed when DNS fails or returns only loopback/private addresses", async () => {
    resolve4.mockRejectedValueOnce(new Error("DNS unavailable"));
    await expect(proxyAwareFetch("https://api2.cursor.sh/")).rejects.toThrow("DNS unavailable");
    resolve4.mockResolvedValueOnce(["127.0.0.1", "10.0.0.1", "192.168.1.2"]);
    await expect(proxyAwareFetch("https://api2.cursor.sh/")).rejects.toThrow("No public IPv4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => options.dispatcher?.connect)).toBe(true);
    expect(systemLookup).not.toHaveBeenCalled();
  });

  it("bounds stalled DNS resolution and cancels the resolver without retrying through system DNS", async () => {
    vi.useFakeTimers();
    resolve4.mockImplementation(() => new Promise(() => {}));
    const request = proxyAwareFetch("https://api2.cursor.sh/");
    const assertion = expect(request).rejects.toThrow("DNS lookup timed out");
    await vi.advanceTimersByTimeAsync(3100);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(systemLookup).not.toHaveBeenCalled();
  });

  it("uses the proxy when configured and fails closed on strict proxy errors", async () => {
    const proxy = { enabled: true, url: "127.0.0.1:7890", strictProxy: true };
    await proxyAwareFetch("https://api2.cursor.sh/", {}, proxy);
    expect(fetchMock.mock.calls[0][1].dispatcher.uri).toBe("http://127.0.0.1:7890");
    expect(resolve4).not.toHaveBeenCalled();

    fetchBehavior = async () => { throw new Error("proxy unavailable"); };
    await expect(proxyAwareFetch("https://api2.cursor.sh/", {}, proxy)).rejects.toThrow("Proxy required but failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors NO_PROXY without reverting intercepted hosts to system DNS", async () => {
    process.env.HTTPS_PROXY = "http://proxy.test:8080";
    process.env.NO_PROXY = "api2.cursor.sh";
    await proxyAwareFetch("https://api2.cursor.sh/");
    expect(fetchMock.mock.calls[0][1].dispatcher.connect).toBeDefined();
    expect(resolve4).toHaveBeenCalledTimes(1);
    expect(systemLookup).not.toHaveBeenCalled();
  });

  it("non-strict proxy failure retries intercepted hosts only through protected DNS", async () => {
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:8080" };
    fetchBehavior = async (url, options) => {
      if (options.dispatcher.uri) throw new Error("proxy down");
      await dispatcherLookup(options.dispatcher, new URL(url).hostname);
      return new Response("safe");
    };
    const body = new URLSearchParams({ token: "secret" });
    expect(await (await proxyAwareFetch("https://api2.cursor.sh/", { method: "POST", body }, proxy)).text()).toBe("safe");
    expect(fetchMock.mock.calls[1][1].body).toBe(body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].dispatcher.connect).toBeDefined();
    expect(resolve4).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    resolve4.mockRejectedValueOnce(new Error("DNS unavailable"));
    // Expire the cached lookup by using another intercepted hostname.
    await expect(proxyAwareFetch("https://daily-cloudcode-pa.googleapis.com/", {}, proxy))
      .rejects.toThrow("DNS unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => options.dispatcher)).toBe(true);
  });

  it("does not replay one-shot bodies after a proxy failure", async () => {
    fetchBehavior = async () => { throw new Error("proxy down"); };
    const body = new ReadableStream({ start(controller) { controller.enqueue("data"); controller.close(); } });
    await expect(proxyAwareFetch("https://api2.cursor.sh/", {
      method: "POST", body, duplex: "half",
    }, { enabled: true, url: "http://proxy.test:8080" })).rejects.toThrow("proxy down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("keeps direct fallback for unrelated hosts after proxy failure", async () => {
    fetchBehavior = async (_url, options) => {
      if (options?.dispatcher) throw new Error("proxy down");
      return new Response("direct");
    };
    expect(await (await proxyAwareFetch("https://unrelated.test/", {}, {
      enabled: true, url: "http://proxy.test:8080",
    })).text()).toBe("direct");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].dispatcher.uri).toBe("http://proxy.test:8080");
    expect(fetchMock.mock.calls[1][1]).toEqual({});
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("does not classify attacker-controlled suffixes as intercepted hosts", async () => {
    const url = "https://cloudcode-pa.googleapis.com.attacker.test/";
    await proxyAwareFetch(url);
    expect(fetchMock.mock.calls[0][1]).toEqual({});
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("protects redirected intercepted hosts with the same lookup and leaves other hosts to system DNS", async () => {
    await proxyAwareFetch("https://api2.cursor.sh/");
    const dispatcher = fetchMock.mock.calls[0][1].dispatcher;
    expect(await dispatcherLookup(dispatcher, "cloudcode-pa.googleapis.com"))
      .toEqual({ address: "142.250.1.1", family: 4 });
    expect(await dispatcherLookup(dispatcher, "unrelated.test"))
      .toEqual({ address: "127.0.0.1", family: 4 });
    expect(systemLookup).toHaveBeenCalledTimes(1);
  });
});
