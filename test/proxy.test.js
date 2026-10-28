import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, streamSimpleAnthropic, getModel } from "@earendil-works/pi-ai/compat";
import { claudeCompatProxy, createFallbackStream } from "../src/extension.js";
import { createOAuthRequestMiddleware } from "../src/request.js";
import {
  PROXY_API, PROXY_LAYOUT_TOKEN, PROXY_PROVIDER, normalizeProxyOrigin, requireProxyKey
} from "../src/strict.js";
import { sseResponse } from "../compat/scenarios.js";

const ORIGIN = "https://cliproxy.internal.test";
const KEY = "cpa_0123456789abcdef0123456789abcdef";
const PROFILE = { schema: 2, installId: "proxy-install", cacheMain: "long" };
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SESSION = "0190d5b4-3b7a-7c6e-8f00-000000000001";

async function withAgentDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-compat-proxy-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
}

test("proxy origin must be HTTPS, or HTTP on loopback, with no path or credentials", () => {
  assert.equal(normalizeProxyOrigin("https://cliproxy.internal.test/"), ORIGIN);
  assert.equal(normalizeProxyOrigin("http://127.0.0.1:8317"), "http://127.0.0.1:8317");
  for (const bad of [undefined, "", "http://10.19.1.221:8317", "https://a.test/v1", "https://u:p@a.test",
    "https://a.test?x=1", "ftp://a.test"]) {
    assert.throws(() => normalizeProxyOrigin(bad), /proxy/);
  }
});

test("proxy key must be a cpa_ key; Anthropic tokens, API keys and conflicting headers are blocked", () => {
  assert.equal(requireProxyKey({ apiKey: KEY }), KEY);
  assert.equal(requireProxyKey({ headers: { Authorization: `Bearer ${KEY}` } }), KEY);
  for (const options of [
    {}, { apiKey: "sk-ant-oat-real-token" }, { apiKey: "sk-ant-api03-paid" }, { apiKey: "cpa_short" },
    { apiKey: KEY, headers: { "x-api-key": "paid" } },
    { apiKey: KEY, headers: { Authorization: "Bearer sk-ant-oat-other" } }
  ]) {
    assert.throws(() => requireProxyKey(options), /cpa_ proxy key/);
  }
});

test("proxy middleware skips the Anthropic bootstrap and sends only the cpa_ key to the proxy", async () => {
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response("{}", { status: 200 });
  };
  const model = { provider: "anthropic", id: "claude-opus-4-8", baseUrl: ORIGIN };
  const wrap = createOAuthRequestMiddleware(PROFILE, { strict: true, proxyOrigin: ORIGIN });
  const options = wrap(model, { messages: [] }, {
    apiKey: KEY, sessionId: SESSION, requestPurpose: "main", fetch,
    headers: { Authorization: `Bearer ${KEY}` }
  });
  assert.equal(options.apiKey, PROXY_LAYOUT_TOKEN, "Pi gets an inert marker for the OAuth layout");
  assert.equal(options.headers.Authorization, undefined, "the key must not override the SDK auth header");
  const payload = await options.onPayload({
    model: model.id, stream: true, max_tokens: 100,
    system: [{ type: "text", text: IDENTITY }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello proxy" }] }]
  }, model);
  assert.equal(calls.length, 0, "no account bootstrap request");
  const metadata = JSON.parse(payload.metadata.user_id);
  assert.equal(metadata.account_uuid, undefined);
  assert.match(metadata.device_id, /^[0-9a-f]{64}$/);
  assert.equal(metadata.session_id, SESSION);
  const headers = { authorization: `Bearer ${PROXY_LAYOUT_TOKEN}`, "anthropic-beta": "oauth-2025-04-20" };
  const send = (url, customHeaders = headers) =>
    options.fetch(url, { method: "POST", body: JSON.stringify(payload), headers: customHeaders });
  await assert.rejects(send("https://api.anthropic.com/v1/messages"), /configured proxy endpoint/);
  await assert.rejects(send(`${ORIGIN}/v1/other`), /configured proxy endpoint/);
  await assert.rejects(send(`${ORIGIN}/v1/messages`, { ...headers, authorization: "Bearer sk-ant-oat-x" }),
    /unexpected wire authentication/);
  assert.equal(calls.length, 0);
  await send(`${ORIGIN}/v1/messages?beta=true`);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, ORIGIN);
  assert.equal(calls[0].init.headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(calls[0].init.headers.get("x-app"), "cli");
  assert.equal(calls[0].init.headers.get("x-claude-code-session-id"), SESSION);
  const sent = calls[0].init.body.toString();
  assert.equal(sent.includes(PROXY_LAYOUT_TOKEN), false);
  assert.equal(sent.includes("cch=00000"), false);
  assert.match(sent, /cch=[0-9a-f]{5};/);
});

test("proxy middleware rejects the official endpoint and other origins; official mode rejects the proxy", () => {
  const wrap = createOAuthRequestMiddleware(PROFILE, { strict: true, proxyOrigin: ORIGIN });
  for (const baseUrl of ["https://api.anthropic.com", "https://other.test", "http://cliproxy.internal.test"]) {
    assert.throws(() => wrap({ provider: "anthropic", id: "m", baseUrl }, { messages: [] }, { apiKey: KEY }),
      /configured proxy endpoint/);
  }
  assert.throws(() => wrap({ provider: "anthropic", id: "m", baseUrl: ORIGIN }, { messages: [] },
    { apiKey: "sk-ant-oat-real" }), /cpa_ proxy key/);
  const official = createOAuthRequestMiddleware(PROFILE, { strict: true });
  assert.throws(() => official({ provider: "anthropic", id: "m", baseUrl: ORIGIN }, { messages: [] }, { apiKey: KEY }),
    /official HTTPS/);
  assert.throws(() => createOAuthRequestMiddleware(PROFILE, { proxyOrigin: ORIGIN }), /strict route/);
});

test("proxy strict route blocks wrong keys, endpoints and providers before any dispatch", async (t) => {
  await withAgentDir(t);
  let calls = 0;
  const stream = createFallbackStream(() => { calls++; assert.fail("Unexpected dispatch"); },
    createAssistantMessageEventStream, { strict: true, proxyOrigin: ORIGIN });
  const model = { ...getModel("anthropic", "claude-opus-4-8"), provider: PROXY_PROVIDER, api: PROXY_API, baseUrl: ORIGIN };
  const cases = [
    [model, {}],
    [model, { apiKey: "sk-ant-oat-test" }],
    [model, { apiKey: "sk-ant-api-key" }],
    [model, { apiKey: KEY, headers: { "x-api-key": "paid-key" } }],
    [{ ...model, baseUrl: "https://api.anthropic.com" }, { apiKey: KEY }],
    [{ ...model, baseUrl: "https://other.test" }, { apiKey: KEY }],
    [{ ...model, provider: "claude-compat", api: "claude-compat-messages" }, { apiKey: KEY }]
  ];
  for (const [candidate, options] of cases) {
    const result = await stream(candidate, { messages: [] }, options).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /Claude Compat/);
  }
  assert.equal(calls, 0);
});

test("proxy strict route sends a validated Claude Code request through the real SDK", async (t) => {
  await withAgentDir(t);
  const states = [];
  const stream = createFallbackStream(streamSimpleAnthropic, createAssistantMessageEventStream, {
    strict: true, proxyOrigin: ORIGIN, onState: (state) => states.push(state)
  });
  const model = { ...getModel("anthropic", "claude-opus-4-8"), provider: PROXY_PROVIDER, api: PROXY_API, baseUrl: ORIGIN };
  const context = { messages: [
    { role: "system", content: [{ type: "text", text: "Test" }], toolsAdded: [
      { name: "Read", description: "Read", parameters: { type: "object", properties: {} } }
    ] },
    { role: "user", content: [{ type: "text", text: "Read a file" }], timestamp: 0 }
  ] };
  const requests = [];
  const result = await stream(model, context, {
    apiKey: KEY, sessionId: SESSION, maxRetries: 0,
    fetch: async (input, init) => {
      const headers = new Headers(init.headers);
      requests.push({ url: new URL(input), headers, body: JSON.parse(Buffer.from(init.body).toString()) });
      assert.equal(init.redirect, "error");
      assert.equal(states.at(-1), "validated");
      return new Response(sseResponse(model.id, "_Read"), { headers: { "content-type": "text/event-stream" } });
    }
  }).result();
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.equal(result.provider, PROXY_PROVIDER);
  assert.equal(result.api, PROXY_API);
  assert.equal(result.content[0].name, "Read");
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url.origin, ORIGIN);
  assert.equal(request.url.pathname, "/v1/messages");
  assert.equal(request.headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(request.headers.has("x-api-key"), false);
  assert.match(request.headers.get("user-agent"), /^claude-cli\/2\.1\.282 \(external, cli\)$/);
  assert.ok(request.headers.get("anthropic-beta").split(",").includes("oauth-2025-04-20"));
  assert.match(request.body.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.282\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
  assert.equal(request.body.system[1].text, IDENTITY);
  assert.ok(request.body.tools.every((tool) => tool.name.startsWith("_")));
  assert.equal(JSON.parse(request.body.metadata.user_id).account_uuid, undefined);
});

test("claudeCompatProxy registers a separate key-only provider and leaves Claude Compat alone", async (t) => {
  await withAgentDir(t);
  await assert.rejects(claudeCompatProxy({ registerProvider() {} }, { origin: "http://10.0.0.1:8317" }), /proxy origin/);
  let provider;
  const commands = {};
  const handlers = {};
  await claudeCompatProxy({
    registerProvider(value) { provider = value; },
    on(name, callback) { handlers[name] = callback; },
    registerCommand(name, config) { commands[name] = config; }
  }, { origin: ORIGIN });
  assert.equal(provider.id, PROXY_PROVIDER);
  assert.equal(provider.baseUrl, ORIGIN);
  assert.equal(provider.auth.oauth, undefined, "no Anthropic login on the proxy provider");
  assert.ok(provider.getModels().length > 0);
  assert.ok(provider.getModels().every((model) =>
    model.provider === PROXY_PROVIDER && model.api === PROXY_API && model.baseUrl === ORIGIN));
  assert.deepEqual(Object.keys(commands), ["claude-compat-proxy-status"]);
  const signal = new AbortController().signal;
  const stored = await provider.auth.apiKey.resolve({ credential: { type: "api_key", key: KEY }, signal });
  assert.equal(stored.auth.apiKey, KEY);
  const fromEnv = await provider.auth.apiKey.resolve({
    ctx: { env: async (name) => name === "PI_CLAUDE_COMPAT_PROXY_KEY" ? KEY : undefined }, signal
  });
  assert.equal(fromEnv.auth.apiKey, KEY);
  assert.equal(await provider.auth.apiKey.resolve({ ctx: { env: async () => undefined }, signal }), undefined);
  const statuses = [];
  const ctx = { model: provider.getModels()[0], ui: { setStatus: (key, text) => statuses.push([key, text]), notify() {} } };
  handlers.session_start({}, ctx);
  assert.deepEqual(statuses.at(-1)[0], PROXY_PROVIDER);
  assert.match(statuses.at(-1)[1], /Compat Proxy active/);
});
