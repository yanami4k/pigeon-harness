// 模型接入的模型信息（决策 362）：接入模块声明的 modelInfo 与 pi-ai 自带目录的查询，随它的 StreamFn 登记；装配运行面时按
// StreamFn 取出（worker、续接与 /reload 重建拿的是同一个函数，不必逐层传）。没登记的 StreamFn（测试夹具等）两样都没有。
// 目录用 pi-ai 0.84.4 公开的 providers/all 查询函数，不碰其内部；只在声明没给全时才动态加载（日常的 DeepSeek 接入声明齐全，
// 不加载）。加载失败退回没有目录（各项按未知处理）并告警，不挡接入模块启动。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as googleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { Value } from "typebox/value";
import {
  type CatalogLookup,
  DECLARATION_KEYS,
  DEFAULT_CURRENCY,
  type ModelInfoDeclaration,
  ModelInfoDeclarationSchema,
  type ModelInfoValues,
} from "../state/model-info.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { CustomProvider } from "../state/settings.ts";
import { withMaxTokens } from "./output-limit.ts";

export interface ModelAccessInfo {
  declared?: ModelInfoDeclaration;
  catalog?: CatalogLookup;
  // 随包的 provider 目录（线路、地址、型号清单）：随包线路的 StreamFn 登记它
  providers?: ProviderFacts;
}

const registry = new WeakMap<StreamFn, ModelAccessInfo>();

export function registerModelAccess(streamFn: StreamFn, info: ModelAccessInfo): StreamFn {
  registry.set(streamFn, info);
  return streamFn;
}

export function modelAccessOf(streamFn: StreamFn): ModelAccessInfo | undefined {
  return registry.get(streamFn);
}

// 接入模块导出的 modelInfo：不合规即报错，指出字段；合规时另交出既不是 pi-ai 模型字段、也不是 modelInfo 字段的顶层键
// （声明非严格，这些键不用，由加载方告警）
export function parseModelInfoDeclaration(
  value: unknown,
  where: string
): { declared: ModelInfoDeclaration; unknownKeys: string[] } {
  if (Value.Check(ModelInfoDeclarationSchema, value)) {
    return {
      declared: value,
      unknownKeys: Object.keys(value).filter((key) => !DECLARATION_KEYS.has(key)),
    };
  }
  const problems = [...Value.Errors(ModelInfoDeclarationSchema, value)].map((failure) => {
    const path = "instancePath" in failure ? String(failure.instancePath) : "";
    return `${path === "" ? "/" : path}: ${failure.message}`;
  });
  throw new Error(`modelInfo exported by ${where} is invalid: ${problems.join("; ")}`);
}

// 声明是否已给全价格、窗口、输出上限、是否支持推理与输入类型（给全了就不必加载目录）
export function declarationComplete(declared: ModelInfoDeclaration | undefined): boolean {
  return (
    declared?.cost !== undefined &&
    declared.contextWindow !== undefined &&
    declared.maxTokens !== undefined &&
    declared.reasoning !== undefined &&
    declared.input !== undefined
  );
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

// 目录模块的说明符经变量给出：它的类型声明引用 JSON 不带 import 属性，本仓库的 tsc 设置（skipLibCheck 关着）下会报错，
// 故不让 tsc 解析其类型，只取运行时的 getBuiltinModel
const CATALOG_MODULE = "@earendil-works/pi-ai/providers/all";

// pi-ai 自带目录的查询（价格为美元/百万 token；没有缓存保留时长；另取是否支持推理与输入类型）。目录里窗口或上限不是正整数的项当作没给。
// 导入失败或没有查询函数时告警一行并返回 undefined（importModule 供测试注入）
export async function loadCatalogLookup(
  warn: (line: string) => void,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier)
): Promise<CatalogLookup | undefined> {
  let lookup: (provider: string, id: string) => unknown;
  try {
    const catalog = (await importModule(CATALOG_MODULE)) as { getBuiltinModel?: unknown };
    if (typeof catalog?.getBuiltinModel !== "function") {
      throw new Error("no getBuiltinModel");
    }
    lookup = catalog.getBuiltinModel as (provider: string, id: string) => unknown;
  } catch (error) {
    warn(
      `loading the pi-ai model catalog failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
  return (provider, id) => {
    const model = lookup(provider, id) as Partial<Record<string, unknown>> | undefined;
    if (typeof model !== "object" || model === null) return undefined;
    const cost = model.cost as Partial<Record<string, unknown>> | undefined;
    const values: ModelInfoValues = {};
    if (
      typeof cost === "object" &&
      cost !== null &&
      [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(
        (n) => typeof n === "number" && n >= 0
      )
    ) {
      values.cost = {
        input: cost.input as number,
        output: cost.output as number,
        cacheRead: cost.cacheRead as number,
        cacheWrite: cost.cacheWrite as number,
        currency: DEFAULT_CURRENCY,
      };
    }
    if (positiveInteger(model.contextWindow)) values.contextWindow = model.contextWindow;
    if (positiveInteger(model.maxTokens)) values.maxTokens = model.maxTokens;
    if (typeof model.reasoning === "boolean") values.reasoning = model.reasoning;
    if (typeof model.reasoning === "boolean") {
      values.thinkingLevels = getSupportedThinkingLevels(
        model as unknown as Model<Api>
      ) as readonly ThinkingLevel[];
    }
    if (typeof model.api === "string" && model.api !== "") values.api = model.api;
    if (typeof model.baseUrl === "string" && model.baseUrl !== "") values.baseUrl = model.baseUrl;
    const input = model.input;
    if (Array.isArray(input) && input.every((kind) => kind === "text" || kind === "image")) {
      values.input = [...(input as Array<"text" | "image">)];
    }
    return values;
  };
}

// ---- 型号选择（MODEL-001…MODEL-031；决策 540–544）----

// 随包发出的四条线路：Pigeon 的名字与 pi-ai 的 api 标识（MODEL-007、MODEL-026）
export const ROUTE_APIS = {
  anthropic: "anthropic-messages",
  openai: "openai-responses",
  "openai-compatible": "openai-completions",
  google: "google-generative-ai",
} as const;
export type RouteName = keyof typeof ROUTE_APIS;
export type PackagedApi = (typeof ROUTE_APIS)[RouteName];
export const ROUTE_NAMES = Object.keys(ROUTE_APIS) as RouteName[];
// 文案里列举随包线路的写法（MODEL-002、MODEL-007）
export const PACKAGED_ROUTES = ROUTE_NAMES.join(", ");

export function routeOfApi(api: string): RouteName | undefined {
  return ROUTE_NAMES.find((name) => ROUTE_APIS[name] === api);
}

// provider → 环境变量。来源：pi-ai 0.84.4 的 env-api-keys 表（这张表没有从包的 exports 放出，故在此照录）；
// 只列线路属于随包四类的 provider（MODEL-001、MODEL-008）
export const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  "ant-ling": "ANT_LING_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  baseten: "BASETEN_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  huggingface: "HF_TOKEN",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openai: "OPENAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
  together: "TOGETHER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  xai: "XAI_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
};

export function keyEnvOf(provider: string): string | undefined {
  return PROVIDER_KEY_ENV[provider];
}

// 一个 provider 有没有凭据（MODEL-001）：它的环境变量给了非空值
export function hasCredential(provider: string, env: Record<string, string | undefined>): boolean {
  const name = PROVIDER_KEY_ENV[provider];
  if (name === undefined) return false;
  const value = env[name];
  return value !== undefined && value !== "";
}

// 凭据来源（MODEL-001、决策 545）：环境变量优先于 ~/.pigeon/credentials.json；自定义服务商的变量名由声明给出。
// 文件内容延迟读（每次取 key 时读一次），所以 /login 写完不需要重建来源对象
export interface CredentialSource {
  envNameOf(provider: string): string | undefined;
  keyOf(provider: string): string | undefined;
  has(provider: string): boolean;
  // key 从哪来（/login 的列表用）；没有为 undefined
  sourceOf(provider: string): "env" | "file" | undefined;
}

export interface CredentialSourceInput {
  env: Record<string, string | undefined>;
  // 自定义服务商的变量名（provider → 环境变量名）；随包的用 PROVIDER_KEY_ENV
  envNames?: Readonly<Record<string, string>>;
  // 凭据文件的内容（延迟读；读失败直接上抛，不静默当没有）
  stored?: () => Record<string, string>;
}

export function createCredentialSource(input: CredentialSourceInput): CredentialSource {
  const envNameOf = (provider: string): string | undefined =>
    input.envNames?.[provider] ?? PROVIDER_KEY_ENV[provider];
  const keyOf = (provider: string): string | undefined => {
    const name = envNameOf(provider);
    const fromEnv = name !== undefined ? input.env[name] : undefined;
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromFile = input.stored?.()[provider];
    return fromFile !== undefined && fromFile !== "" ? fromFile : undefined;
  };
  return {
    envNameOf,
    keyOf,
    has: (provider) => keyOf(provider) !== undefined,
    sourceOf: (provider) => {
      const name = envNameOf(provider);
      const fromEnv = name !== undefined ? input.env[name] : undefined;
      if (fromEnv !== undefined && fromEnv !== "") return "env";
      const fromFile = input.stored?.()[provider];
      return fromFile !== undefined && fromFile !== "" ? "file" : undefined;
    },
  };
}

function isCredentialSource(
  value: CredentialSource | Record<string, string | undefined>
): value is CredentialSource {
  return typeof (value as CredentialSource).keyOf === "function";
}

// 随包 provider 目录的事实：线路、地址、目录里的型号（MODEL-007、MODEL-009、MODEL-019）
export interface ProviderFacts {
  names(): string[];
  routeOf(provider: string): RouteName | undefined;
  baseUrlOf(provider: string): string | undefined;
  modelsOf(provider: string): string[];
  providersOffering(modelId: string): string[];
}

interface ProviderCatalogModule {
  getBuiltinProviders?: () => unknown;
  getBuiltinModels?: (provider: string) => unknown;
}

export async function loadProviderFacts(
  warn: (line: string) => void,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier)
): Promise<ProviderFacts | undefined> {
  let catalog: ProviderCatalogModule;
  try {
    catalog = (await importModule(CATALOG_MODULE)) as ProviderCatalogModule;
    if (
      typeof catalog?.getBuiltinProviders !== "function" ||
      typeof catalog?.getBuiltinModels !== "function"
    ) {
      throw new Error("no built-in provider query");
    }
  } catch (error) {
    warn(
      `loading the pi-ai provider catalog failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
  const routes = new Map<string, { route: RouteName; baseUrl?: string; models: string[] }>();
  const offering = new Map<string, string[]>();
  const providers = catalog.getBuiltinProviders() as unknown;
  if (!Array.isArray(providers)) return undefined;
  for (const id of providers) {
    if (typeof id !== "string") continue;
    let models: unknown;
    try {
      models = catalog.getBuiltinModels(id);
    } catch {
      continue;
    }
    if (!Array.isArray(models)) continue;
    const shipped: string[] = [];
    let route: RouteName | undefined;
    let baseUrl: string | undefined;
    for (const raw of models as Array<{ id?: unknown; api?: unknown; baseUrl?: unknown }>) {
      if (typeof raw?.id !== "string" || typeof raw.api !== "string") continue;
      const found = routeOfApi(raw.api);
      if (found === undefined) continue;
      route ??= found;
      shipped.push(raw.id);
      if (baseUrl === undefined && typeof raw.baseUrl === "string") baseUrl = raw.baseUrl;
      offering.set(raw.id, [...(offering.get(raw.id) ?? []), id]);
    }
    if (route === undefined) continue;
    routes.set(id, {
      route,
      models: shipped,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
  }
  return {
    names: () => [...routes.keys()].sort(),
    routeOf: (provider) => routes.get(provider)?.route,
    baseUrlOf: (provider) => routes.get(provider)?.baseUrl,
    modelsOf: (provider) => [...(routes.get(provider)?.models ?? [])].sort(),
    providersOffering: (modelId) => [...(offering.get(modelId) ?? [])].sort(),
  };
}

// 没有任何随包服务商的事实（目录加载失败时仍可用自定义服务商）
export function emptyProviderFacts(): ProviderFacts {
  return {
    names: () => [],
    routeOf: () => undefined,
    baseUrlOf: () => undefined,
    modelsOf: () => [],
    providersOffering: () => [],
  };
}

// 把用户层声明的自定义服务商（决策 547）并在随包目录上：线路与地址取自声明，型号清单为空（目录外型号）。
// id 与随包服务商重名即报错，不静默覆盖
export function providerFactsWith(
  base: ProviderFacts | undefined,
  custom: readonly CustomProvider[]
): ProviderFacts {
  const packaged = base ?? emptyProviderFacts();
  const packagedIds = new Set(packaged.names());
  const byId = new Map<string, CustomProvider>();
  for (const provider of custom) {
    if (packagedIds.has(provider.id)) {
      throw new Error(
        `custom provider "${provider.id}" in model.providers collides with a packaged provider`
      );
    }
    byId.set(provider.id, provider);
  }
  return {
    names: () => [...new Set([...packaged.names(), ...byId.keys()])].sort(),
    routeOf: (provider) => {
      const declared = byId.get(provider);
      return declared !== undefined ? routeOfApi(declared.api) : packaged.routeOf(provider);
    },
    baseUrlOf: (provider) => byId.get(provider)?.baseUrl ?? packaged.baseUrlOf(provider),
    modelsOf: (provider) => (byId.has(provider) ? [] : packaged.modelsOf(provider)),
    providersOffering: (modelId) => packaged.providersOffering(modelId),
  };
}

export interface LastUsedModel {
  provider: string;
  model: string;
}

export interface ModelChoice {
  provider: string;
  model: string;
}

// 选择失败：文案逐字对应规格（MODEL-002/004/007/008/010/015）；后两项另带界面要列出的候选
export type ModelChoiceFailure =
  | { reason: "no-credentials"; text: string }
  | { reason: "many-providers"; text: string; candidates: string[] }
  | { reason: "unknown-provider"; text: string }
  | { reason: "no-credential"; text: string }
  | { reason: "many-offerings"; text: string; candidates: string[] }
  | { reason: "no-model"; text: string; provider: string; models: string[] };

export interface ModelChoiceInputs {
  // 凭据来源（env > 文件；决策 545）
  credentials?: CredentialSource;
  // 旧写法：直接给环境变量（等价于只看 env 的来源；测试与只认环境变量的入口用）
  env?: Record<string, string | undefined>;
  facts: ProviderFacts;
  // 命令行给的（没给为 undefined）
  provider?: string;
  model?: string;
  // 用户层记住的上次选择（MODEL-012、MODEL-016、MODEL-024）
  lastUsed?: LastUsedModel;
}

function noModelText(provider: string): string {
  return `no model selected for provider "${provider}"; pass --model.`;
}

export function chooseModel(inputs: ModelChoiceInputs): ModelChoice | ModelChoiceFailure {
  const credentials = inputs.credentials ?? createCredentialSource({ env: inputs.env ?? {} });
  const { facts, model, lastUsed } = inputs;
  const credentialed = facts
    .names()
    .filter((name) => credentials.has(name))
    .sort();
  // MODEL-016：上次用的那家没凭据（或线路不再随包）时当作没有记过
  const remembered =
    lastUsed !== undefined &&
    facts.routeOf(lastUsed.provider) !== undefined &&
    credentials.has(lastUsed.provider)
      ? lastUsed
      : undefined;
  const provider = inputs.provider;
  // MODEL-006、MODEL-007、MODEL-008：命令行指定了 provider 就按它
  if (provider !== undefined) {
    if (facts.routeOf(provider) === undefined) {
      return {
        reason: "unknown-provider",
        text: `unknown provider "${provider}"; packaged routes: ${PACKAGED_ROUTES}.`,
      };
    }
    if (!credentials.has(provider)) {
      return {
        reason: "no-credential",
        text: noCredentialText(provider, credentials.envNameOf(provider)),
      };
    }
    const chosen = model ?? (remembered?.provider === provider ? remembered.model : undefined);
    if (chosen === undefined) {
      return {
        reason: "no-model",
        text: noModelText(provider),
        provider,
        models: facts.modelsOf(provider),
      };
    }
    return { provider, model: chosen };
  }
  // MODEL-009、MODEL-010：只给型号时，仅当目录里只有一家提供且它有凭据才反推
  if (model !== undefined) {
    const offering = facts.providersOffering(model);
    if (offering.length > 1) {
      return {
        reason: "many-offerings",
        text: `model "${model}" is offered by more than one provider (${offering.join(", ")}); pass --provider.`,
        candidates: offering,
      };
    }
    if (offering.length === 1 && credentials.has(offering[0] as string)) {
      return { provider: offering[0] as string, model };
    }
    // 目录认不出这个型号（MODEL-019）或那一家没凭据：provider 当作没给
    const fallback =
      remembered?.provider ?? (credentialed.length === 1 ? credentialed[0] : undefined);
    if (fallback !== undefined) return { provider: fallback, model };
    if (credentialed.length > 1) {
      return {
        reason: "many-providers",
        text: manyProvidersText(credentialed),
        candidates: credentialed,
      };
    }
    return { reason: "no-credentials", text: NO_CREDENTIALS_TEXT };
  }
  // MODEL-012、MODEL-016：全新会话没给型号时先用上次的选择
  if (remembered !== undefined) return { ...remembered };
  // MODEL-002：一家都没有
  if (credentialed.length === 0) {
    return { reason: "no-credentials", text: NO_CREDENTIALS_TEXT };
  }
  // MODEL-003、MODEL-015：只有一家时用它，但没有型号可发
  if (credentialed.length === 1) {
    const only = credentialed[0] as string;
    return {
      reason: "no-model",
      text: noModelText(only),
      provider: only,
      models: facts.modelsOf(only),
    };
  }
  // MODEL-004、MODEL-005：多家都有凭据，不自选
  return {
    reason: "many-providers",
    text: manyProvidersText(credentialed),
    candidates: credentialed,
  };
}

const NO_CREDENTIALS_TEXT = `no credentials: set an environment variable such as DEEPSEEK_API_KEY (routes: ${PACKAGED_ROUTES}), or start the terminal UI and run /login there.`;

// MODEL-008、决策 549：指定了服务商却没有凭据；末尾一并指向终端界面的 /login
function noCredentialText(provider: string, envName: string | undefined): string {
  return `no credential for provider "${provider}"; set ${envName ?? "an API key environment variable"}, or start the terminal UI and run /login there.`;
}

function manyProvidersText(candidates: readonly string[]): string {
  return `no model selected: more than one provider has credentials (${candidates.join(", ")}); pass --provider and --model, or run the terminal UI to choose one.`;
}

// ---- 随包线路的 StreamFn（MODEL-026；决策 544）----

// 四种 api 实现按 model.api 分发；模型对象（api、baseUrl、窗口等）由装配层按型号信息填好
const PACKAGED_STREAMS: Readonly<Record<PackagedApi, StreamFn>> = {
  "anthropic-messages": anthropicMessages as unknown as StreamFn,
  "openai-responses": openaiResponses as unknown as StreamFn,
  "openai-completions": openaiCompletions as unknown as StreamFn,
  "google-generative-ai": googleGenerativeAi as unknown as StreamFn,
};

// 模型对象没给正数输出上限时的安全缺省（决策 556）：不能把 0 当上限发给服务商
// （openai-completions 的线路会把 0 当成只出 1 个 token）。8192 低于各家常见的输出上限。
export const DEFAULT_MODEL_MAX_TOKENS = 8192;

// 没有 --stream-fn 时的接入：按凭据来源取 key（env > /login 文件），按模型对象上的 api 发（MODEL-003、MODEL-017、MODEL-019）
export function createPackagedStreamFn(
  credentials: CredentialSource | Record<string, string | undefined>,
  streams: Readonly<Record<PackagedApi, StreamFn>> = PACKAGED_STREAMS
): StreamFn {
  const source = isCredentialSource(credentials)
    ? credentials
    : createCredentialSource({ env: credentials });
  return (model, context, options) => {
    const stream = streams[model.api as PackagedApi];
    if (stream === undefined) {
      throw new Error(
        `model route "${model.api}" is not packaged; pass --stream-fn for a custom route (routes: ${PACKAGED_ROUTES})`
      );
    }
    const apiKey = source.keyOf(model.provider);
    if (apiKey === undefined) {
      throw new Error(noCredentialText(model.provider, source.envNameOf(model.provider)));
    }
    // 决策 556：输出上限必须为正——目录/声明给了真实上限就用它，没有就用安全缺省；
    // 显式上限（--max-output-tokens）仍优先，但不超出模型上限
    const capped = model.maxTokens > 0 ? model : { ...model, maxTokens: DEFAULT_MODEL_MAX_TOKENS };
    const requested =
      options?.maxTokens !== undefined && options.maxTokens > 0 ? options.maxTokens : undefined;
    // 没有显式（或显式值不为正）时也把模型上限明确发出去：不能留给客户端对 0/缺省的解释（决策 556）
    const maxTokens =
      requested !== undefined ? Math.min(requested, capped.maxTokens) : capped.maxTokens;
    return stream(capped, context, withMaxTokens({ ...options, apiKey }, maxTokens));
  };
}

// ---- 代理（决策 548）----

// 标准代理变量；任一非空即认为使用者要经代理
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

export function proxyConfigured(env: Record<string, string | undefined>): boolean {
  return PROXY_ENV_KEYS.some((key) => (env[key] ?? "") !== "");
}

interface UndiciModule {
  fetch?: (input: unknown, init?: unknown) => unknown;
  EnvHttpProxyAgent?: new () => unknown;
}

// 只在代理变量非空时动态加载 undici，并用 EnvHttpProxyAgent 包一层 globalThis.fetch：四条随包线路（含明确拒绝自定义
// fetch 的 google）与 MCP/联网工具都走同一代理；加载失败响亮报错，不静默直连
export async function installProxyFetch(
  env: Record<string, string | undefined>,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier)
): Promise<boolean> {
  if (!proxyConfigured(env)) return false;
  let module: UndiciModule;
  try {
    module = (await importModule("undici")) as UndiciModule;
  } catch (error) {
    throw new Error(
      `proxy environment is set but loading undici failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const fetchImpl = module.fetch;
  const Agent = module.EnvHttpProxyAgent;
  if (typeof fetchImpl !== "function" || typeof Agent !== "function") {
    throw new Error("proxy environment is set but undici has no EnvHttpProxyAgent/fetch");
  }
  const dispatcher = new Agent();
  (globalThis as { fetch: unknown }).fetch = (input: unknown, init?: unknown) =>
    fetchImpl(input, { ...(init as object | undefined), dispatcher });
  return true;
}
