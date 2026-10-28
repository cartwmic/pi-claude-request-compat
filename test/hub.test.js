import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, streamSimpleAnthropic, getModel } from "@earendil-works/pi-ai/compat";
import claudeCompat, { MODE_ENV, compatMode, createFallbackStream } from "../src/extension.js";
import { unreachableCode } from "../src/request.js";
import { COMPAT_API, COMPAT_PROVIDER } from "../src/strict.js";
import { sseResponse } from "../compat/scenarios.js";

const ORIGIN = "https://cliproxy.internal.test";
const KEY = "cpa_0123456789abcdef0123456789abcdef";
const OAUTH = "sk-ant-oat01-direct-fallback-token";
const SESSION = "0190d5b4-3b7a-7c6e-8f00-000000000002";
const OFFICIAL = "https://api.anthropic.com";

async function withAgentDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-compat-hub-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
}

// models.json keeps the official base URL; hub mode must still route to the hub.
const hubModel = (extra = {}) => ({
  ...getModel("anthropic", "claude-opus-4-8"), provider: COMPAT_PROVIDER, api: COMPAT_API, baseUrl: OFFICIAL, ...extra
});
const context = () => ({ messages: [{ role: "user", content: [{ type: "text", text: "hi hub" }], timestamp: 0 }] });

function unreachable(code) {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

// Records every request with its full wire text so key leaks can be checked.
function recorder(handler) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    const body = init.body === undefined ? "" : Buffer.from(init.body).toString();
    const wire = url.href + "\n" + [...headers].map(([k, v]) => `${k}: ${v}`).join("\n") + "\n" + body;
    requests.push({ url, headers, body, wire });
    if (url.pathname.startsWith("/api/claude_cli/bootstrap")) {
      return Response.json({ oauth_account: { account_uuid: "acct-direct" } });
    }
    return handler(url, requests.length);
  };
  return { requests, fetch };
}

const ok = (model) => new Response(sseResponse(model), { headers: { "content-type": "text/event-stream" } });

function hubStream(extra = {}) {
  const fallbacks = [];
  const failures = [];
  let directCalls = 0;
  const stream = createFallbackStream(streamSimpleAnthropic, createAssistantMessageEventStream, {
    strict: true, proxyOrigin: ORIGIN, providerId: COMPAT_PROVIDER, apiId: COMPAT_API,
    directAuth: async () => { directCalls++; return { apiKey: OAUTH }; },
    onFallback: (code) => fallbacks.push(code), onFailure: (reason) => failures.push(reason),
    ...extra
  });
  return { stream, fallbacks, failures, directCalls: () => directCalls };
}

test("mode is proxy when unset, direct or proxy when set, and fails closed on anything else", () => {
  assert.equal(MODE_ENV, "PI_CLAUDE_COMPAT_MODE");
  assert.equal(compatMode(undefined), "proxy");
  assert.equal(compatMode("proxy"), "proxy");
  assert.equal(compatMode("direct"), "direct");
  for (const bad of ["", "Proxy", "DIRECT", "hub", " proxy", "off"]) {
    assert.throws(() => compatMode(bad), (error) => error.message.includes(JSON.stringify(bad)) && /did not load/.test(error.message));
  }
});

test("proxy mode registers claude-compat itself, key-only, and needs a valid hub origin", async (t) => {
  await withAgentDir(t);
  const pi = (sink) => ({
    registerProvider(value) { sink.provider = value; },
    on(name, callback) { (sink.handlers ??= {})[name] = callback; },
    registerCommand(name, config) { (sink.commands ??= {})[name] = config; }
  });
  await assert.rejects(claudeCompat(pi({}), { mode: "proxy" }), /needs a hub origin/);
  await assert.rejects(claudeCompat(pi({}), { mode: "proxy", origin: "http://10.0.0.1:8317" }), /proxy origin/);
  await assert.rejects(claudeCompat(pi({}), { mode: "nope", origin: ORIGIN }), /did not load/);
  const sink = {};
  await claudeCompat(pi(sink), { mode: "proxy", origin: ORIGIN, directAuth: async () => ({ apiKey: OAUTH }) });
  const { provider } = sink;
  assert.equal(provider.id, COMPAT_PROVIDER);
  assert.equal(provider.baseUrl, ORIGIN);
  assert.equal(provider.auth.oauth, undefined, "no Anthropic login on the hub route");
  assert.ok(provider.getModels().every((model) =>
    model.provider === COMPAT_PROVIDER && model.api === COMPAT_API && model.baseUrl === ORIGIN));
  assert.deepEqual(Object.keys(sink.commands), ["claude-compat-status"]);
  const stored = await provider.auth.apiKey.resolve({ credential: { type: "api_key", key: KEY }, signal: new AbortController().signal });
  assert.equal(stored.auth.apiKey, KEY);
  const statuses = [];
  const notices = [];
  const ctx = { model: provider.getModels()[0], ui: {
    setStatus: (key, text) => statuses.push([key, text]), notify: (text, level) => notices.push([text, level])
  } };
  sink.handlers.session_start({}, ctx);
  assert.equal(statuses.at(-1)[0], COMPAT_PROVIDER);
  assert.match(statuses.at(-1)[1], /^Compat active · hub · /);
  await sink.commands["claude-compat-status"].handler("", ctx);
  assert.match(notices.at(-1)[0], /Mode: hub\. Auth policy: hub key only \(https:\/\/cliproxy\.internal\.test\); direct Anthropic OAuth only when the hub is unreachable/);
});

test("the mode default comes from PI_CLAUDE_COMPAT_MODE at load", async (t) => {
  await withAgentDir(t);
  const previous = process.env[MODE_ENV];
  t.after(() => { if (previous === undefined) delete process.env[MODE_ENV]; else process.env[MODE_ENV] = previous; });
  const load = async () => {
    let provider;
    await claudeCompat({ registerProvider(value) { provider = value; }, on() {}, registerCommand() {} }, { origin: ORIGIN });
    return provider;
  };
  delete process.env[MODE_ENV];
  assert.equal((await load()).baseUrl, ORIGIN);
  process.env[MODE_ENV] = "direct";
  const direct = await load();
  assert.equal(direct.baseUrl, OFFICIAL);
  assert.equal(direct.auth.oauth.isSubscription, true);
  process.env[MODE_ENV] = "bogus";
  await assert.rejects(load(), /"bogus"/);
});

test("hub route sends only the cpa_ key, only to the hub, and never asks for the direct login", async (t) => {
  await withAgentDir(t);
  const { stream, fallbacks, directCalls } = hubStream();
  const model = hubModel();
  const { requests, fetch } = recorder(() => ok(model.id));
  const result = await stream(model, context(), { apiKey: KEY, sessionId: SESSION, maxRetries: 0, fetch }).result();
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  assert.equal(result.provider, COMPAT_PROVIDER);
  assert.equal(result.api, COMPAT_API);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.origin, ORIGIN);
  assert.equal(requests[0].headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(requests[0].wire.includes("sk-ant-"), false, "no Anthropic token or marker on the hub wire");
  assert.equal(directCalls(), 0);
  assert.deepEqual(fallbacks, []);
});

test("hub route still blocks foreign base URLs and Anthropic tokens", async (t) => {
  await withAgentDir(t);
  const { stream, directCalls } = hubStream();
  const { requests, fetch } = recorder(() => assert.fail("must not dispatch"));
  const cases = [
    [hubModel({ baseUrl: "https://other.test" }), { apiKey: KEY }],
    [hubModel({ baseUrl: "http://api.anthropic.com" }), { apiKey: KEY }],
    [hubModel(), { apiKey: OAUTH }],
    [hubModel(), { apiKey: KEY, headers: { "x-api-key": "paid" } }]
  ];
  for (const [model, options] of cases) {
    const result = await stream(model, context(), { ...options, maxRetries: 0, fetch }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /Claude Compat/);
  }
  assert.equal(requests.length, 0);
  assert.equal(directCalls(), 0);
});

test("any HTTP response from the hub is final: no direct fallback on 401, 429, 500 or 503", async (t) => {
  await withAgentDir(t);
  for (const status of [400, 401, 403, 429, 500, 502, 503, 529]) {
    const { stream, fallbacks, directCalls } = hubStream();
    const model = hubModel();
    const { requests, fetch } = recorder(() => Response.json({ type: "error", error: { type: "x", message: `hub ${status}` } }, { status }));
    const result = await stream(model, context(), { apiKey: KEY, sessionId: SESSION, maxRetries: 0, fetch }).result();
    assert.equal(result.stopReason, "error", `status ${status}`);
    assert.ok(requests.every((request) => request.url.origin === ORIGIN), `status ${status}`);
    assert.equal(directCalls(), 0, `status ${status}`);
    assert.deepEqual(fallbacks, []);
  }
});

test("hub unreachable (DNS, connect, connect timeout) falls back to direct with the OAuth token only", async (t) => {
  await withAgentDir(t);
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
    const { stream, fallbacks, failures, directCalls } = hubStream();
    // The key also sits in model headers, as models.json can put it there.
    const model = hubModel({ headers: { Authorization: `Bearer ${KEY}`, "x-extra": "kept" } });
    const { requests, fetch } = recorder((url) => {
      if (url.origin === ORIGIN) throw unreachable(code);
      return ok(model.id);
    });
    const result = await stream(model, context(), {
      apiKey: KEY, headers: { authorization: `Bearer ${KEY}` }, sessionId: SESSION, maxRetries: 0, fetch
    }).result();
    assert.notEqual(result.stopReason, "error", `${code}: ${result.errorMessage}`);
    assert.equal(result.provider, COMPAT_PROVIDER);
    assert.deepEqual(fallbacks, [code]);
    assert.deepEqual(failures, []);
    assert.equal(directCalls(), 1);
    const hub = requests.filter((request) => request.url.origin === ORIGIN);
    const direct = requests.filter((request) => request.url.origin !== ORIGIN);
    assert.equal(hub.length, 1);
    assert.ok(hub.every((request) => !request.wire.includes("sk-ant-oat01")), "OAuth token never sent to the hub");
    assert.ok(direct.length >= 1);
    for (const request of direct) {
      assert.equal(request.url.origin, OFFICIAL);
      assert.equal(request.wire.includes("cpa_"), false, `${code}: cpa_ key leaked to Anthropic`);
      assert.equal(request.headers.get("authorization"), `Bearer ${OAUTH}`);
      assert.equal(request.headers.has("x-api-key"), false);
    }
    const message = direct.find((request) => request.url.pathname === "/v1/messages");
    assert.equal(message.headers.get("x-extra"), "kept");
    assert.equal(message.headers.get("x-claude-code-session-id"), SESSION);
    assert.equal(JSON.parse(JSON.parse(message.body).metadata.user_id).account_uuid, "acct-direct");
  }
});

test("the first unreachable attempt cuts the retry loop; without a fallback, retries run as before", async (t) => {
  await withAgentDir(t);
  const model = hubModel();
  const { stream, fallbacks } = hubStream();
  const a = recorder((url) => { if (url.origin === ORIGIN) throw unreachable("ECONNREFUSED"); return ok(model.id); });
  const started = Date.now();
  const result = await stream(model, context(), { apiKey: KEY, maxRetries: 3, fetch: a.fetch }).result();
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  assert.ok(Date.now() - started < 400, "no retry backoff before the direct request");
  assert.equal(a.requests.filter((request) => request.url.origin === ORIGIN).length, 1);
  assert.deepEqual(fallbacks, ["ECONNREFUSED"]);

  const plain = createFallbackStream(streamSimpleAnthropic, createAssistantMessageEventStream, {
    strict: true, proxyOrigin: ORIGIN, providerId: COMPAT_PROVIDER, apiId: COMPAT_API
  });
  const b = recorder(() => { throw unreachable("ECONNREFUSED"); });
  const failed = await plain(model, context(), { apiKey: KEY, maxRetries: 1, fetch: b.fetch }).result();
  assert.equal(failed.stopReason, "error");
  assert.equal(b.requests.length, 2, "one retry, both to the hub");
  assert.ok(b.requests.every((request) => request.url.origin === ORIGIN));
});

test("an unreachable retry after a hub HTTP response is a normal error, not an abort or a fallback", async (t) => {
  await withAgentDir(t);
  const { stream, fallbacks, failures, directCalls } = hubStream();
  const { requests, fetch } = recorder((url, n) => {
    assert.equal(url.origin, ORIGIN, "never direct after the hub answered");
    if (n === 1) return Response.json({ type: "error", error: { type: "overloaded_error", message: "hub 503" } }, { status: 503 });
    throw unreachable("ECONNREFUSED");
  });
  const result = await stream(hubModel(), context(), { apiKey: KEY, sessionId: SESSION, maxRetries: 2, fetch }).result();
  assert.equal(result.stopReason, "error", result.errorMessage);
  assert.ok(requests.length >= 2, "Pi's retry loop still ran");
  assert.equal(directCalls(), 0);
  assert.deepEqual(fallbacks, []);
  assert.ok(failures.length >= 1, "the failure is reported");
});

test("cancelling during the direct login ends as aborted, without a fallback notice or a direct send", async (t) => {
  await withAgentDir(t);
  const model = hubModel();
  for (const outcome of ["resolves", "rejects"]) {
    const controller = new AbortController();
    const { stream, fallbacks, failures } = hubStream({ directAuth: async () => {
      controller.abort();
      if (outcome === "rejects") throw new Error("login cancelled");
      return { apiKey: OAUTH };
    } });
    const { requests, fetch } = recorder((url) => { if (url.origin === ORIGIN) throw unreachable("ENOTFOUND"); return ok(model.id); });
    const result = await stream(model, context(), { apiKey: KEY, maxRetries: 0, signal: controller.signal, fetch }).result();
    assert.equal(result.stopReason, "aborted", outcome);
    assert.deepEqual(fallbacks, [], outcome);
    assert.deepEqual(failures, [], outcome);
    assert.ok(requests.every((request) => request.url.origin === ORIGIN), outcome);
  }
});

test("no fallback when the request is aborted, when no directAuth is set, or when directAuth fails", async (t) => {
  await withAgentDir(t);
  const model = hubModel();
  const hubOnly = () => recorder((url) => { if (url.origin === ORIGIN) throw unreachable("ECONNREFUSED"); return ok(model.id); });

  const aborted = hubStream();
  const controller = new AbortController();
  const a = hubOnly();
  const abortingFetch = async (input, init) => { controller.abort(); return a.fetch(input, init); };
  await aborted.stream(model, context(), { apiKey: KEY, maxRetries: 0, signal: controller.signal, fetch: abortingFetch }).result();
  assert.equal(aborted.directCalls(), 0);
  assert.ok(a.requests.every((request) => request.url.origin === ORIGIN));

  const plain = createFallbackStream(streamSimpleAnthropic, createAssistantMessageEventStream, {
    strict: true, proxyOrigin: ORIGIN, providerId: COMPAT_PROVIDER, apiId: COMPAT_API
  });
  const b = hubOnly();
  const noFallback = await plain(model, context(), { apiKey: KEY, maxRetries: 0, fetch: b.fetch }).result();
  assert.equal(noFallback.stopReason, "error");
  assert.ok(b.requests.every((request) => request.url.origin === ORIGIN));

  const broken = hubStream({ directAuth: async () => { throw new Error("Use /login anthropic"); } });
  const c = hubOnly();
  const failed = await broken.stream(model, context(), { apiKey: KEY, maxRetries: 0, fetch: c.fetch }).result();
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage, /hub unreachable \(ECONNREFUSED\); direct fallback unavailable: Use \/login anthropic/);
  assert.deepEqual(broken.fallbacks, [], "no 'used the direct login' notice when it was not used");
  assert.match(broken.failures.at(-1), /hub unreachable \(ECONNREFUSED\)/);
  assert.ok(c.requests.every((request) => request.url.origin === ORIGIN));

  const bad = hubStream({ directAuth: async () => ({ apiKey: KEY }) });
  const d = hubOnly();
  const refused = await bad.stream(model, context(), { apiKey: KEY, maxRetries: 0, fetch: d.fetch }).result();
  assert.equal(refused.stopReason, "error");
  assert.match(refused.errorMessage, /OAuth only/);
  assert.deepEqual(bad.fallbacks, []);
  assert.ok(d.requests.every((request) => request.url.origin === ORIGIN), "a cpa_ key is never sent to Anthropic");
});

test("errors after the hub was reached are never retried direct", async (t) => {
  await withAgentDir(t);
  for (const thrown of [Object.assign(new Error("reset"), { code: "ECONNRESET" }), new Error("socket hang up")]) {
    const { stream, directCalls } = hubStream();
    const { requests, fetch } = recorder(() => { throw thrown; });
    const result = await stream(hubModel(), context(), { apiKey: KEY, maxRetries: 0, fetch }).result();
    assert.equal(result.stopReason, "error");
    assert.equal(directCalls(), 0);
    assert.ok(requests.every((request) => request.url.origin === ORIGIN));
  }
});

test("directAuth is only accepted on the hub route of claude-compat", () => {
  const make = (options) => createFallbackStream(streamSimpleAnthropic, createAssistantMessageEventStream, options);
  assert.throws(() => make({ strict: true, directAuth: async () => ({}) }), /hub mode/);
  assert.throws(() => make({ strict: true, proxyOrigin: ORIGIN, directAuth: async () => ({}) }), /hub mode/);
  assert.throws(() => make({ strict: true, proxyOrigin: ORIGIN, providerId: COMPAT_PROVIDER, apiId: COMPAT_API, directAuth: "x" }), /hub mode/);
});

test("unreachableCode finds DNS and connect codes in causes and aggregates only", () => {
  assert.equal(unreachableCode(unreachable("ENOTFOUND")), "ENOTFOUND");
  assert.equal(unreachableCode(new TypeError("fetch failed", { cause: new AggregateError([
    Object.assign(new Error("v6"), { code: "ENETUNREACH" }), Object.assign(new Error("v4"), { code: "ECONNREFUSED" })
  ]) })), "ENETUNREACH");
  for (const error of [new Error("x"), unreachable("ECONNRESET"), unreachable("UND_ERR_SOCKET"),
    Object.assign(new Error("abort"), { name: "AbortError" }), undefined, null]) {
    assert.equal(unreachableCode(error), undefined);
  }
});
