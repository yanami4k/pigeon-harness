// MODEL-001…MODEL-019、MODEL-026、MODEL-028：型号选择的规则（决策 540–544）。纯选择逻辑用假目录喂，
// 目录与线路的真实事实另按随包的 pi-ai 目录核对。
import assert from "node:assert/strict";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import {
  chooseModel,
  createCredentialSource,
  createPackagedStreamFn,
  hasCredential,
  installProxyFetch,
  loadProviderFacts,
  PROVIDER_KEY_ENV,
  providerFactsWith,
  ROUTE_APIS,
  ROUTE_NAMES,
} from "./model-access.ts";

type FakeProvider = { route: keyof typeof ROUTE_APIS; models: string[]; baseUrl?: string };

function factsOf(map: Record<string, FakeProvider>) {
  const offering = new Map<string, string[]>();
  for (const [provider, entry] of Object.entries(map)) {
    for (const model of entry.models) {
      offering.set(model, [...(offering.get(model) ?? []), provider]);
    }
  }
  return {
    names: () => Object.keys(map).sort(),
    routeOf: (provider: string) => map[provider]?.route,
    baseUrlOf: (provider: string) => map[provider]?.baseUrl,
    modelsOf: (provider: string) => [...(map[provider]?.models ?? [])].sort(),
    providersOffering: (model: string) => [...(offering.get(model) ?? [])].sort(),
  };
}

function reasonOf(choice: ReturnType<typeof chooseModel>): string | undefined {
  return "reason" in choice ? choice.reason : undefined;
}

const single = factsOf({ deepseek: { route: "openai-compatible", models: ["deepseek-chat"] } });
const many = factsOf({
  anthropic: { route: "anthropic", models: ["claude-sonnet"] },
  deepseek: { route: "openai-compatible", models: ["deepseek-chat"] },
});

test("MODEL-001 credentials are read from an environment variable, empty counts as absent", () => {
  assert.equal(hasCredential("deepseek", { DEEPSEEK_API_KEY: "sk-x" }), true);
  assert.equal(hasCredential("deepseek", { DEEPSEEK_API_KEY: "" }), false);
  assert.equal(hasCredential("deepseek", {}), false);
});

test("MODEL-002 no provider holds a credential: the run fails with the fixed text", () => {
  const choice = chooseModel({ env: {}, facts: single });
  assert.deepEqual(choice, {
    reason: "no-credentials",
    text: "no credentials: set an environment variable such as DEEPSEEK_API_KEY (routes: anthropic, openai, openai-compatible, google), or start the terminal UI and run /login there.",
  });
});

test("MODEL-003 exactly one provider holds a credential: the runtime talks to that provider", () => {
  const choice = chooseModel({
    env: { DEEPSEEK_API_KEY: "sk-x" },
    facts: single,
    lastUsed: { provider: "deepseek", model: "deepseek-chat" },
  });
  assert.deepEqual(choice, { provider: "deepseek", model: "deepseek-chat" });
});

test("MODEL-004 more than one provider holds a credential: the run names them and picks none", () => {
  const choice = chooseModel({
    env: { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" },
    facts: many,
  });
  assert.equal(reasonOf(choice), "many-providers");
  assert.equal(
    "text" in choice ? choice.text : "",
    "no model selected: more than one provider has credentials (anthropic, deepseek); pass --provider and --model, or run the terminal UI to choose one."
  );
});

test("MODEL-005 the terminal UI presents the same candidates and does not pick one", () => {
  const choice = chooseModel({
    env: { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" },
    facts: many,
  });
  assert.equal(reasonOf(choice), "many-providers");
  assert.deepEqual("candidates" in choice ? choice.candidates : [], ["anthropic", "deepseek"]);
});

test("MODEL-006 a provider given on the command line is used whatever the others hold", () => {
  const choice = chooseModel({
    env: { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" },
    facts: many,
    provider: "deepseek",
    model: "deepseek-chat",
  });
  assert.deepEqual(choice, { provider: "deepseek", model: "deepseek-chat" });
});

test("MODEL-007 a provider whose route is not shipped is refused with the fixed text", () => {
  const choice = chooseModel({
    env: { DEEPSEEK_API_KEY: "d" },
    facts: single,
    provider: "bedrock",
  });
  assert.deepEqual(choice, {
    reason: "unknown-provider",
    text: 'unknown provider "bedrock"; packaged routes: anthropic, openai, openai-compatible, google.',
  });
});

test("MODEL-008 a given provider without a credential is refused naming its environment variable", () => {
  const choice = chooseModel({ env: {}, facts: single, provider: "deepseek" });
  assert.deepEqual(choice, {
    reason: "no-credential",
    text: 'no credential for provider "deepseek"; set DEEPSEEK_API_KEY, or start the terminal UI and run /login there.',
  });
});

test("MODEL-009 only a model given: the provider is inferred when it is the only one offering it", () => {
  const choice = chooseModel({
    env: { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" },
    facts: many,
    model: "claude-sonnet",
  });
  assert.deepEqual(choice, { provider: "anthropic", model: "claude-sonnet" });
});

test("MODEL-010 a model offered by more than one provider is refused", () => {
  const shared = factsOf({
    anthropic: { route: "anthropic", models: ["shared"] },
    openai: { route: "openai", models: ["shared"] },
  });
  const choice = chooseModel({ env: { ANTHROPIC_API_KEY: "a" }, facts: shared, model: "shared" });
  assert.deepEqual(choice, {
    reason: "many-offerings",
    text: 'model "shared" is offered by more than one provider (anthropic, openai); pass --provider.',
    candidates: ["anthropic", "openai"],
  });
});

test("MODEL-011 no default model is invented for a credentialed provider", () => {
  const choice = chooseModel({ env: { DEEPSEEK_API_KEY: "d" }, facts: single });
  assert.equal(reasonOf(choice), "no-model");
});

test("MODEL-012 a new session without a model uses the last used model", () => {
  const choice = chooseModel({
    env: { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" },
    facts: many,
    lastUsed: { provider: "deepseek", model: "deepseek-chat" },
  });
  assert.deepEqual(choice, { provider: "deepseek", model: "deepseek-chat" });
});

test("MODEL-015 one credentialed provider and no model: the run asks for --model", () => {
  const choice = chooseModel({ env: { DEEPSEEK_API_KEY: "d" }, facts: single });
  assert.deepEqual(choice, {
    reason: "no-model",
    text: 'no model selected for provider "deepseek"; pass --model.',
    provider: "deepseek",
    models: ["deepseek-chat"],
  });
});

test("MODEL-016 the last used model is ignored while its provider holds no credential", () => {
  const choice = chooseModel({
    env: { ANTHROPIC_API_KEY: "a" },
    facts: many,
    lastUsed: { provider: "deepseek", model: "deepseek-chat" },
  });
  assert.equal(reasonOf(choice), "no-model");
  assert.equal("provider" in choice ? choice.provider : "", "anthropic");
});

test("MODEL-017 the given model is sent as the model id, with the provider key", () => {
  const seen: Array<{ id: string; apiKey: string | undefined }> = [];
  const stream: StreamFn = (model, _context, options) => {
    seen.push({ id: model.id, apiKey: options?.apiKey });
    throw new Error("stop");
  };
  const packaged = createPackagedStreamFn(
    { DEEPSEEK_API_KEY: "sk-x" },
    {
      "anthropic-messages": stream,
      "openai-responses": stream,
      "openai-completions": stream,
      "google-generative-ai": stream,
    }
  );
  assert.throws(() =>
    packaged(
      { api: "openai-completions", provider: "deepseek", id: "deepseek-chat" } as never,
      {} as never,
      {}
    )
  );
  assert.deepEqual(seen, [{ id: "deepseek-chat", apiKey: "sk-x" }]);
});

test("决策 556 an unknown model gets a positive output limit; an explicit one wins but stays capped", () => {
  const seen: Array<{ modelMaxTokens: number; requested: number | undefined }> = [];
  const stream: StreamFn = (model, _context, options) => {
    seen.push({ modelMaxTokens: model.maxTokens, requested: options?.maxTokens });
    throw new Error("stop");
  };
  const packaged = createPackagedStreamFn(
    { DEEPSEEK_API_KEY: "sk-x" },
    {
      "anthropic-messages": stream,
      "openai-responses": stream,
      "openai-completions": stream,
      "google-generative-ai": stream,
    }
  );
  const unknown = {
    api: "openai-completions",
    provider: "deepseek",
    id: "x",
    maxTokens: 0,
  } as never;
  assert.throws(() => packaged(unknown, {} as never, {}));
  assert.throws(() => packaged(unknown, {} as never, { maxTokens: 64 }));
  assert.throws(() => packaged(unknown, {} as never, { maxTokens: 50_000 }));
  assert.throws(() =>
    packaged(
      { api: "openai-completions", provider: "deepseek", id: "y", maxTokens: 384_000 } as never,
      {} as never,
      {}
    )
  );
  assert.deepEqual(seen, [
    { modelMaxTokens: 8192, requested: 8192 },
    { modelMaxTokens: 8192, requested: 64 },
    { modelMaxTokens: 8192, requested: 8192 },
    { modelMaxTokens: 384_000, requested: 384_000 },
  ]);
});

test("MODEL-019 a model the catalog does not know goes on the chosen provider's packaged route", () => {
  const seen: string[] = [];
  const stream: StreamFn = (model) => {
    seen.push(model.api);
    throw new Error("stop");
  };
  const packaged = createPackagedStreamFn(
    { DEEPSEEK_API_KEY: "sk-x" },
    {
      "anthropic-messages": stream,
      "openai-responses": stream,
      "openai-completions": stream,
      "google-generative-ai": stream,
    }
  );
  // 装配层按 provider 的随包线路补 api（见 runtime.ts 的 adapterModel），目录外的型号同样走这一条
  assert.throws(() =>
    packaged(
      { api: "openai-completions", provider: "deepseek", id: "not-in-catalog" } as never,
      {} as never,
      {}
    )
  );
  assert.deepEqual(seen, ["openai-completions"]);
});

test("MODEL-026 the package maps exactly the four routes to pi-ai apis", () => {
  assert.deepEqual(ROUTE_NAMES, ["anthropic", "openai", "openai-compatible", "google"]);
  assert.deepEqual(
    ROUTE_NAMES.map((name) => ROUTE_APIS[name]),
    ["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"]
  );
});

test("MODEL-026 every provider in the credential table is in the packaged catalog with a shipped route", async () => {
  const facts = await loadProviderFacts(() => {});
  assert.ok(facts !== undefined);
  for (const provider of Object.keys(PROVIDER_KEY_ENV)) {
    assert.ok(facts.names().includes(provider), `${provider} missing from the catalog`);
    assert.ok(facts.routeOf(provider) !== undefined, `${provider} has no shipped route`);
  }
});

test("MODEL-028 the packaged providers keep their catalogued address", async () => {
  const facts = await loadProviderFacts(() => {});
  assert.ok(facts !== undefined);
  assert.equal(facts.baseUrlOf("deepseek"), "https://api.deepseek.com");
  assert.equal(facts.routeOf("deepseek"), "openai-compatible");
  assert.ok(facts.modelsOf("deepseek").length > 0);
});

test("MODEL-027 a fresh install with one credentialed provider still asks for a model", () => {
  const choice = chooseModel({ env: { DEEPSEEK_API_KEY: "d" }, facts: single });
  assert.equal(reasonOf(choice), "no-model");
  assert.equal("choice" in choice, false);
});

test("MODEL-029 the candidate list is text only: the failure carries the message and model ids", () => {
  const choice = chooseModel({ env: { DEEPSEEK_API_KEY: "d" }, facts: single });
  assert.equal(reasonOf(choice), "no-model");
  assert.equal(typeof ("text" in choice ? choice.text : undefined), "string");
  assert.deepEqual("models" in choice ? choice.models : [], ["deepseek-chat"]);
  // 没有任何可交互的选项字段（选择器不在本单元）
  assert.equal(Object.hasOwn(choice, "options"), false);
});

test("MODEL-032 the environment wins over the credentials file", () => {
  const source = createCredentialSource({
    env: { DEEPSEEK_API_KEY: "env-key" },
    stored: () => ({ deepseek: "file-key", mine: "file-mine" }),
  });
  assert.equal(source.keyOf("deepseek"), "env-key");
  assert.equal(source.sourceOf("deepseek"), "env");
  assert.equal(source.keyOf("mine"), "file-mine");
  assert.equal(source.sourceOf("mine"), "file");
  // 只有文件里的 key 也算有凭据（MODEL-003）
  assert.deepEqual(
    chooseModel({
      credentials: source,
      facts: factsOf({ mine: { route: "openai-compatible", models: [] } }),
      provider: "mine",
      model: "x",
    }),
    { provider: "mine", model: "x" }
  );
});

test("MODEL-035 custom providers are declared in model.providers and cannot reuse a packaged id", () => {
  const custom = [
    {
      id: "mine",
      api: "openai-completions" as const,
      baseUrl: "https://llm.test",
      keyEnv: "MINE_KEY",
    },
  ];
  const facts = providerFactsWith(single, custom);
  assert.equal(facts.routeOf("mine"), "openai-compatible");
  assert.equal(facts.baseUrlOf("mine"), "https://llm.test");
  assert.deepEqual(facts.modelsOf("mine"), []);
  assert.ok(facts.names().includes("mine"));
  assert.throws(
    () =>
      providerFactsWith(single, [
        { id: "deepseek", api: "openai-completions", baseUrl: "https://x.test", keyEnv: "X_KEY" },
      ]),
    /collides with a packaged provider/
  );
});

test("MODEL-036 a custom provider takes its key from keyEnv or from /login", () => {
  const facts = providerFactsWith(single, [
    { id: "mine", api: "anthropic-messages", baseUrl: "https://llm.test", keyEnv: "MINE_KEY" },
  ]);
  const fromEnv = createCredentialSource({
    env: { MINE_KEY: "sk-mine" },
    envNames: { mine: "MINE_KEY" },
  });
  assert.deepEqual(chooseModel({ credentials: fromEnv, facts, provider: "mine", model: "x" }), {
    provider: "mine",
    model: "x",
  });
  const fromFile = createCredentialSource({
    env: {},
    envNames: { mine: "MINE_KEY" },
    stored: () => ({ mine: "sk-login" }),
  });
  assert.deepEqual(chooseModel({ credentials: fromFile, facts, provider: "mine", model: "x" }), {
    provider: "mine",
    model: "x",
  });
  assert.equal(fromEnv.sourceOf("mine"), "env");
  assert.equal(fromFile.sourceOf("mine"), "file");
});

test("MODEL-037 proxy support is loaded only when a proxy variable is set, and failures are loud", async () => {
  const original = globalThis.fetch;
  try {
    assert.equal(
      await installProxyFetch({}, async () => {
        throw new Error("must not load");
      }),
      false
    );
    let seen: { dispatcher?: unknown } | undefined;
    const fake = {
      EnvHttpProxyAgent: class {},
      fetch: (_input: unknown, init: { dispatcher?: unknown }) => {
        seen = init;
        return "ok";
      },
    };
    assert.equal(
      await installProxyFetch({ HTTPS_PROXY: "http://127.0.0.1:9" }, async () => fake),
      true
    );
    await (globalThis.fetch as unknown as (input: string) => Promise<unknown>)(
      "https://example.com"
    );
    assert.ok(seen?.dispatcher !== undefined);
    await assert.rejects(
      installProxyFetch({ HTTPS_PROXY: "http://127.0.0.1:9" }, async () => ({})),
      /EnvHttpProxyAgent/
    );
  } finally {
    globalThis.fetch = original;
  }
});
