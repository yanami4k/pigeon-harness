// 缓存规则表（决策 362）：各家服务方的提示缓存怎么开、留多久、写入与读取按输入价的几倍、最小可缓存前缀，以及出处。
// 按实际服务方定键，不按接口格式：经 Anthropic 兼容端点访问 DeepSeek，查的是 DeepSeek 的规则；同一服务方下可再按模型名前缀
// 细分（精确型号优先，其次最长的匹配前缀；既无型号也无前缀的行是该服务方的兜底，没有兜底行的服务方下匹配不到的型号为未知）。
// 查不到的服务方给全未知的规则，由用到它的功能各自保守处理。实际服务方另可按接口地址的主机名判定（SERVED_BY_HOSTS）。
// 两档：short 是较短或缺省的一档，long 是较长或须另开的一档；只有一档的服务方只填 short。
// 依据类别：fixed 文档给的确定时长；minimum 至少这么久（可能更久）；typical 通常这么久（不保证）；best-effort 尽力而为、
// 可随时清除（秒数取原文说法的保守下限）；unstated 文档没写。
// 写缓存倍率 1 表示不另收写入费（写入的 token 按未命中价计）。出处的引句由 scripts/check-cache-rule-sources.ts 手动复核。
// 纯数据与查找，无 IO、不依赖任何包（复核脚本直接运行它）。

export type CacheMode = "auto" | "explicit" | "both" | "none" | "unknown";
export type RetentionBasis = "fixed" | "minimum" | "typical" | "best-effort" | "unstated";
export type Unknown = "unknown";

export interface RetentionTier {
  seconds: number | Unknown;
  basis: RetentionBasis;
  // 命中是否续期（从命中时刻重新计时）
  refreshOnHit: boolean | Unknown;
  // 写缓存按输入价的倍数（1 = 不另收写入费）
  writeMultiplier: number | Unknown;
  // 命中按输入价的倍数
  readMultiplier: number | Unknown;
  // 如何开启
  enable: string;
}

export interface CacheRuleSource {
  url: string;
  // 取用日期（YYYY-MM-DD）
  retrieved: string;
  // 原文短引，须是页面去标签后的连续文字
  quote: string;
}

export interface CacheRule {
  mode: CacheMode;
  short?: RetentionTier;
  long?: RetentionTier;
  // 最小可缓存前缀（token）：按模型不同时给区间
  minPrefixTokens: { min: number; max: number } | Unknown;
  sources: readonly CacheRuleSource[];
  // 原文的保留说法、例外型号等补充
  note?: string;
}

export interface CacheRuleRow {
  // 行标识（写进会话记录）
  id: string;
  // 实际服务方：pi-ai 的 provider 名与常见别名
  servedBy: readonly string[];
  // 精确型号与模型名前缀；两者都缺省 = 该服务方的兜底行
  models?: readonly string[];
  modelPrefixes?: readonly string[];
  rule: CacheRule;
}

const RETRIEVED = "2026-10-03";
// 出处引句是页面原文（中文页面即中文），复核脚本逐字比对，不翻译
const src = (url: string, quote: string): CacheRuleSource => ({ url, retrieved: RETRIEVED, quote });

const ANTHROPIC_URL = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching";
const OPENAI_URL = "https://developers.openai.com/api/docs/guides/prompt-caching";
const GEMINI_URL = "https://ai.google.dev/gemini-api/docs/caching?hl=en";
const GEMINI_EXPLICIT_URL = "https://ai.google.dev/gemini-api/docs/generate-content/caching?hl=en";
const VERTEX_GEMINI_URL =
  "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview?hl=en";
const VERTEX_GEMINI_CREATE_URL =
  "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-create?hl=en";
const VERTEX_CLAUDE_URL =
  "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/prompt-caching?hl=en";
const BEDROCK_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html";
const DEEPSEEK_URL = "https://api-docs.deepseek.com/zh-cn/guides/kv_cache/";
const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const KIMI_URL = "https://platform.kimi.com/docs/guide/context-caching";
const KIMI_PRICING_URL = "https://platform.kimi.com/docs/pricing/chat";
const BAILIAN_URL = "https://help.aliyun.com/zh/model-studio/context-cache";
const ZHIPU_URL = "https://docs.bigmodel.cn/cn/guide/capabilities/cache";
const ZHIPU_PRICING_URL = "https://docs.bigmodel.cn/cn/guide/start/pricing";
const XAI_URL = "https://docs.x.ai/developers/advanced-api-usage/prompt-caching";
const MISTRAL_URL = "https://docs.mistral.ai/studio/conversations/advanced/prompt-caching";

// Anthropic 直连的共同部分（按模型细分的行只改读取倍率与最小前缀）
const anthropicTiers = (read: number): Pick<CacheRule, "short" | "long"> => ({
  short: {
    seconds: 300,
    basis: "fixed",
    refreshOnHit: true,
    writeMultiplier: 1.25,
    readMultiplier: read,
    enable: "automatic caching or cache_control breakpoints (5 minutes by default)",
  },
  long: {
    seconds: 3600,
    basis: "fixed",
    refreshOnHit: true,
    writeMultiplier: 2,
    readMultiplier: read,
    enable: 'cache_control ttl set to "1h"',
  },
});
const ANTHROPIC_SOURCES: readonly CacheRuleSource[] = [
  src(
    ANTHROPIC_URL,
    "By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used."
  ),
  src(
    ANTHROPIC_URL,
    "using automatic caching or explicit breakpoints with 5-minute or 1-hour TTLs."
  ),
  src(ANTHROPIC_URL, "5-minute cache write tokens are 1.25 times the base input tokens price"),
  src(ANTHROPIC_URL, "1-hour cache write tokens are 2 times the base input tokens price"),
  src(ANTHROPIC_URL, "Cache read tokens are 0.1 times the base input tokens price"),
  src(ANTHROPIC_URL, "4,096 tokens for Claude Haiku 4.5"),
];
const ANTHROPIC_512 = src(
  ANTHROPIC_URL,
  "512 tokens for Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5"
);

// OpenAI GPT-5.6 及以后的共同部分
const openaiNewTier = (read: number): RetentionTier => ({
  seconds: 1800,
  basis: "minimum",
  refreshOnHit: true,
  writeMultiplier: 1.25,
  readMultiplier: read,
  enable:
    "on by default (implicit breakpoint at the end of the latest eligible message); prompt_cache_options can switch to explicit breakpoints only; ttl is 30m only",
});
const OPENAI_NEW_SOURCES: readonly CacheRuleSource[] = [
  src(
    OPENAI_URL,
    "A cached prefix remains eligible for reuse for 30 minutes after its most recent write or reuse"
  ),
  src(
    OPENAI_URL,
    "For GPT-5.6 and later, cache writes cost 1.25× the standard, uncached input-token rate."
  ),
  src(OPENAI_URL, "Subsequent reads cost 0.1× that rate"),
  src(
    OPENAI_URL,
    "The minimum cacheable prompt length is 1,024 tokens for GPT-5.6 and later and varies by request settings for earlier models."
  ),
];
const OPENAI_EXTENDED: RetentionTier = {
  seconds: 1800,
  basis: "typical",
  refreshOnHit: "unknown",
  writeMultiplier: 1,
  readMultiplier: "unknown",
  enable:
    'prompt_cache_retention set to "24h" (the default for non-ZDR organizations on supported models)',
};
const OPENAI_EXTENDED_SOURCE = src(
  OPENAI_URL,
  "Extended retention typically keeps entries available for around 30 minutes and can retain them for up to 24 hours."
);

// Kimi 的共同部分（K3 与 K2.6、K2.7 只差写入倍率）
const kimiTier = (seconds: number, write: number | Unknown, enable: string): RetentionTier => ({
  seconds,
  basis: "fixed",
  refreshOnHit: true,
  writeMultiplier: write,
  readMultiplier: 0.1,
  enable,
});
const KIMI_SOURCES: readonly CacheRuleSource[] = [
  src(KIMI_URL, "满足命中条件的前缀会自动写入并尝试复用"),
  src(KIMI_URL, "写入后 1 小时内有效，每次命中后有效期重新计算为 1 小时"),
  src(KIMI_URL, "缓存命中价格是缓存未命中价格的 1/10"),
];
const KIMI_SHORT_ENABLE =
  "on by default (Chat Completions and Responses APIs); the Anthropic API writes only with cache_control, otherwise reads only";
const KIMI_LONG_ENABLE = "TTL set to 1h";

// Vertex 上 Gemini 的两档（2.5 及以后与 2.0 只差命中倍率）
const vertexGeminiImplicit = (read: number | Unknown): RetentionTier => ({
  seconds: "unknown",
  basis: "unstated",
  refreshOnHit: "unknown",
  writeMultiplier: 1,
  readMultiplier: read,
  enable: "implicit caching: on by default, no storage cost",
});
const vertexGeminiExplicit = (read: number): RetentionTier => ({
  seconds: 3600,
  basis: "fixed",
  refreshOnHit: false,
  writeMultiplier: 1,
  readMultiplier: read,
  enable:
    "explicit caching: 60 minutes by default, at least 1 minute, no maximum, storage billed by duration",
});
const VERTEX_GEMINI_SOURCES: readonly CacheRuleSource[] = [
  src(VERTEX_GEMINI_URL, "There are no storage costs for implicit caching."),
  src(
    VERTEX_GEMINI_URL,
    "you're billed for the input tokens used to create the cache at the standard input token price."
  ),
  src(
    VERTEX_GEMINI_URL,
    "On Gemini 2.5 or later models, this discount is 90%; on Gemini 2.0 models, this discount is 75%."
  ),
  src(
    VERTEX_GEMINI_CREATE_URL,
    "The default expiration time of a context cache is 60 minutes after it's created."
  ),
];

const BEDROCK_CLAUDE_PREFIXES = ["", "us.", "eu.", "apac.", "au.", "jp.", "global.", "us-gov."].map(
  (region) => `${region}anthropic.claude`
);

export const CACHE_RULES: readonly CacheRuleRow[] = [
  {
    id: "anthropic",
    servedBy: ["anthropic"],
    rule: {
      mode: "both",
      ...anthropicTiers(0.1),
      minPrefixTokens: { min: 512, max: 4096 },
      sources: [...ANTHROPIC_SOURCES, ANTHROPIC_512],
      note: "minimum prefix is 512, 1024, 2048 or 4096 depending on the model; the lifetime counts from the start of the request that wrote or read the entry",
    },
  },
  {
    id: "anthropic/opus-5.5",
    servedBy: ["anthropic"],
    modelPrefixes: ["claude-opus-5-5"],
    rule: {
      mode: "both",
      ...anthropicTiers(0.05),
      minPrefixTokens: { min: 512, max: 512 },
      sources: [
        ...ANTHROPIC_SOURCES,
        ANTHROPIC_512,
        src(
          ANTHROPIC_URL,
          "Cache hits and refreshes on Claude Opus 5.5 are priced at 0.05x the base input price."
        ),
      ],
    },
  },
  {
    id: "anthropic/fable-mythos-5.1",
    servedBy: ["anthropic"],
    modelPrefixes: ["claude-fable-5-1", "claude-mythos-5-1"],
    rule: {
      mode: "both",
      ...anthropicTiers(0.025),
      minPrefixTokens: { min: 512, max: 512 },
      sources: [
        ...ANTHROPIC_SOURCES,
        ANTHROPIC_512,
        src(
          ANTHROPIC_URL,
          "Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x the base input price."
        ),
      ],
    },
  },
  {
    id: "openai/earlier",
    servedBy: ["openai"],
    models: ["gpt-5"],
    modelPrefixes: [
      "gpt-3.5",
      "gpt-4",
      "gpt-5-",
      "gpt-5.1",
      "gpt-5.2",
      "gpt-5.3",
      "gpt-5.4",
      "chatgpt-4o",
      "o1",
      "o3",
      "o4",
    ],
    rule: {
      mode: "auto",
      short: {
        seconds: 300,
        basis: "typical",
        refreshOnHit: true,
        writeMultiplier: 1,
        readMultiplier: "unknown",
        enable: "on by default (in_memory; the default for ZDR organizations)",
      },
      long: OPENAI_EXTENDED,
      minPrefixTokens: "unknown",
      sources: [
        src(
          OPENAI_URL,
          "Entries typically remain active for around 5 to 10 minutes of inactivity, up to one hour."
        ),
        OPENAI_EXTENDED_SOURCE,
        src(OPENAI_URL, "No additional cache-write charge"),
      ],
      note: "models before GPT-5.5 are listed one by one; in_memory lasts about 5-10 minutes of inactivity, at most 1 hour; the 24h tier typically about 30 minutes, at most 24 hours; minimum prefix varies with request settings; read multiplier varies by model. OpenAI has no fallback row, so unlisted models are unknown",
    },
  },
  {
    id: "openai/gpt-5.5",
    servedBy: ["openai"],
    modelPrefixes: ["gpt-5.5"],
    rule: {
      mode: "auto",
      short: { ...OPENAI_EXTENDED, enable: 'on by default, "24h" tier only' },
      minPrefixTokens: "unknown",
      sources: [OPENAI_EXTENDED_SOURCE, src(OPENAI_URL, "No additional cache-write charge")],
      note: "GPT-5.5 and 5.5 Pro support only the 24h tier: typically about 30 minutes, at most 24 hours",
    },
  },
  {
    id: "openai/gpt-5.6+",
    servedBy: ["openai"],
    modelPrefixes: ["gpt-5.6", "gpt-5.7", "gpt-5.8", "gpt-5.9", "gpt-6"],
    rule: {
      mode: "both",
      short: openaiNewTier(0.1),
      minPrefixTokens: { min: 1024, max: 1024 },
      sources: OPENAI_NEW_SOURCES,
      note: "30 minutes count from the most recent write or reuse and may last longer; the 1,024 counts visible input tokens only",
    },
  },
  {
    id: "openai/gpt-6.1-sol",
    servedBy: ["openai"],
    modelPrefixes: ["gpt-6.1-sol"],
    rule: {
      mode: "both",
      short: openaiNewTier(0.05),
      minPrefixTokens: { min: 1024, max: 1024 },
      sources: [
        ...OPENAI_NEW_SOURCES,
        src(
          OPENAI_URL,
          "Subsequent reads cost 0.1× that rate on most of these models and 0.05× on GPT-6.1 Sol"
        ),
      ],
    },
  },
  {
    id: "google",
    servedBy: ["google", "gemini"],
    rule: {
      mode: "both",
      short: {
        seconds: "unknown",
        basis: "unstated",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: "implicit caching: on by default for 2.5 and later, hits not guaranteed",
      },
      long: {
        seconds: 3600,
        basis: "fixed",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable:
          "explicit caching (cachedContents, beta, generateContent only): ttl configurable, 1 hour by default, storage billed by duration",
      },
      minPrefixTokens: { min: 2048, max: 4096 },
      sources: [
        src(
          GEMINI_URL,
          "Implicit caching is enabled by default for all Gemini 2.5 and newer models."
        ),
        src(
          GEMINI_EXPLICIT_URL,
          "automatically enabled on Gemini 2.5 and newer models, no cost saving guarantee"
        ),
        src(GEMINI_EXPLICIT_URL, "If not set, the TTL defaults to 1 hour."),
        src(GEMINI_EXPLICIT_URL, "billed based on the TTL duration of cached token count."),
      ],
      note: "the caching page only says hits are billed at a reduced rate (mostly about 10% of input on the pricing table); minimum prefix 2048 for 2.5, 4096 for 3.x, numbers only in the tables",
    },
  },
  {
    id: "google-vertex/gemini-2.5+",
    servedBy: ["google-vertex"],
    modelPrefixes: ["gemini-2.5", "gemini-3"],
    rule: {
      mode: "both",
      short: vertexGeminiImplicit(0.1),
      long: vertexGeminiExplicit(0.1),
      minPrefixTokens: { min: 2048, max: 4096 },
      sources: [
        ...VERTEX_GEMINI_SOURCES,
        src(
          VERTEX_GEMINI_URL,
          "Implicit caching provides a 90% discount on cached tokens compared to standard input tokens."
        ),
      ],
      note: "the 1-minute minimum and the minimum prefix (2048 for 2.5, 4096 for 3) are only in the tables",
    },
  },
  {
    id: "google-vertex/gemini-2.0",
    servedBy: ["google-vertex"],
    modelPrefixes: ["gemini-2.0"],
    rule: {
      mode: "both",
      short: vertexGeminiImplicit("unknown"),
      long: vertexGeminiExplicit(0.25),
      minPrefixTokens: { min: 2048, max: 2048 },
      sources: VERTEX_GEMINI_SOURCES,
      note: "explicit hit discount 75%; implicit hit discount not stated per model; the 1-minute minimum and the minimum prefix are only in the tables",
    },
  },
  {
    id: "google-vertex/claude",
    servedBy: ["google-vertex", "google-vertex-anthropic"],
    modelPrefixes: ["claude-"],
    rule: {
      mode: "explicit",
      short: {
        seconds: 300,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: 1.25,
        readMultiplier: 0.1,
        enable: "cache_control breakpoints (5 minutes by default)",
      },
      long: {
        seconds: 3600,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: 2,
        readMultiplier: 0.1,
        enable: "ttl set to one hour (not supported on 3.7 Sonnet, 3.5 Sonnet, 3 Opus)",
      },
      minPrefixTokens: "unknown",
      sources: [
        src(
          VERTEX_CLAUDE_URL,
          "By default, the cache has a five-minute lifetime or time to live (TTL)."
        ),
        src(
          VERTEX_CLAUDE_URL,
          "The cache lifetime is refreshed each time the cached content is accessed."
        ),
        src(
          VERTEX_CLAUDE_URL,
          "Cache write tokens with a five-minute lifetime are 25% more expensive than base input tokens."
        ),
        src(
          VERTEX_CLAUDE_URL,
          "Cache write tokens with a one-hour lifetime are 100% more expensive than base input tokens."
        ),
        src(VERTEX_CLAUDE_URL, "Cache read tokens are 90% cheaper than base input tokens."),
      ],
      note: "the page does not state the minimum prefix or automatic caching; other behavior refers to the Anthropic docs",
    },
  },
  {
    id: "amazon-bedrock/claude",
    servedBy: ["amazon-bedrock"],
    modelPrefixes: BEDROCK_CLAUDE_PREFIXES,
    rule: {
      mode: "both",
      short: {
        seconds: 300,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: "cachePoint or cache_control breakpoints (5 minutes by default)",
      },
      long: {
        seconds: 3600,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: 'ttl set to "1h" (not supported on 3.7 Sonnet, 3.5 Sonnet v2)',
      },
      minPrefixTokens: { min: 512, max: 4096 },
      sources: [
        src(
          BEDROCK_URL,
          "The cache has a Time To Live (TTL), which resets with each successful cache hit."
        ),
        src(
          BEDROCK_URL,
          "Specify the desired ttl value as below, when ttl value not specified the default behavior of 5 minutes caching applies."
        ),
        src(BEDROCK_URL, "Support for each type varies by model and API."),
        src(BEDROCK_URL, "Claude Opus 5 requires at least 512 tokens per cache checkpoint"),
        src(BEDROCK_URL, "Claude Haiku 4.5 requires at least 4,096 tokens per cache checkpoint."),
        src(
          BEDROCK_URL,
          "Depending on the model, tokens written to cache can be billed at a rate that is higher than the standard input token rate."
        ),
      ],
      note: "write and read multipliers are on the Bedrock pricing page, not this page; Opus 4.7 minimum prefix is 4096 here and 2048 in the Anthropic docs",
    },
  },
  {
    id: "deepseek",
    servedBy: ["deepseek"],
    rule: {
      mode: "auto",
      short: {
        seconds: 3600,
        basis: "best-effort",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: "on by default, no code changes needed",
      },
      minPrefixTokens: "unknown",
      sources: [
        src(DEEPSEEK_URL, "上下文硬盘缓存技术对所有用户默认开启，用户无需修改代码即可享用"),
        src(DEEPSEEK_URL, "缓存系统是“尽力而为”，不保证 100% 缓存命中"),
        src(DEEPSEEK_URL, "缓存不再使用后会自动被清空，时间一般为几个小时到几天"),
        src(DEEPSEEK_PRICING_URL, "我们将根据模型输入和输出的总 token 数进行计量计费。"),
      ],
      note: 'the page says entries are cleared after "a few hours to a few days", so seconds take the conservative 1 hour; the pricing page lists only input (cache hit), input (cache miss) and output, no write fee, so the write multiplier is unknown; a cache prefix unit must match in full to hit',
    },
  },
  {
    id: "kimi",
    servedBy: ["moonshotai", "moonshotai-cn", "kimi-coding", "moonshot", "kimi"],
    rule: {
      mode: "auto",
      short: kimiTier(300, "unknown", KIMI_SHORT_ENABLE),
      long: kimiTier(3600, "unknown", KIMI_LONG_ENABLE),
      minPrefixTokens: "unknown",
      sources: KIMI_SOURCES,
      note: "the cache is stored in blocks; a partial block is not written (block size not stated)",
    },
  },
  {
    id: "kimi/k3",
    servedBy: ["moonshotai", "moonshotai-cn", "kimi-coding", "moonshot", "kimi"],
    modelPrefixes: ["kimi-k3", "k3"],
    rule: {
      mode: "auto",
      short: kimiTier(300, 1, KIMI_SHORT_ENABLE),
      long: kimiTier(3600, 2, KIMI_LONG_ENABLE),
      minPrefixTokens: "unknown",
      sources: [
        ...KIMI_SOURCES,
        src(KIMI_URL, "唯一多付的成本是写入费贵 ¥20（¥40 vs ¥20）"),
        src(KIMI_PRICING_URL, "对于 K3 系列模型，缓存写入按 TTL（5min / 1h）单独计费"),
      ],
      note: "K3: input ¥20, 5-minute write ¥20, 1-hour write ¥40, hit ¥2",
    },
  },
  {
    id: "kimi/k2.6-k2.7",
    servedBy: ["moonshotai", "moonshotai-cn", "kimi-coding", "moonshot", "kimi"],
    models: ["kimi-k2.7", "kimi-k2.7-highspeed", "kimi-k2.6"],
    rule: {
      mode: "auto",
      short: kimiTier(300, 1, KIMI_SHORT_ENABLE),
      long: kimiTier(3600, 1, KIMI_LONG_ENABLE),
      minPrefixTokens: "unknown",
      sources: KIMI_SOURCES,
      note: "lists only kimi-k2.7, kimi-k2.7-highspeed and kimi-k2.6, which the docs name as not supporting Cache Write (no write fee)",
    },
  },
  {
    id: "alibaba-bailian",
    servedBy: [
      "alibaba-bailian",
      "bailian",
      "dashscope",
      "qwen-token-plan",
      "qwen-token-plan-cn",
      "qwen-token-plan-individual",
    ],
    rule: {
      mode: "both",
      short: {
        seconds: 300,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: 1.25,
        readMultiplier: 0.1,
        enable:
          "explicit caching: cache_control marked ephemeral (exclusive with implicit, at most 4 marks per request)",
      },
      long: {
        seconds: "unknown",
        basis: "best-effort",
        refreshOnHit: "unknown",
        writeMultiplier: 1,
        readMultiplier: 0.2,
        enable: "implicit caching: on by default",
      },
      minPrefixTokens: { min: 512, max: 1024 },
      sources: [
        src(BAILIAN_URL, "通常按输入 Token 标准单价的 125% 计费，后续命中通常仅需支付 10% 的费用"),
        src(BAILIAN_URL, "缓存块的内容最少为 1024 Token。"),
        src(BAILIAN_URL, "对命中缓存的部分，通常按输入 Token 标准单价的 20% 计费"),
        src(BAILIAN_URL, "之间的内容创建为新的缓存块，有效期为 5 分钟。"),
        src(BAILIAN_URL, "不确定，系统会定期清理长期未使用的缓存数据"),
      ],
      note: 'the page says the multipliers apply "usually", with exceptions for some models; minimum prefix is usually 1024, 512 for GLM deployed by Zhipu and MiniMax deployed by MiniMax',
    },
  },
  {
    id: "zhipu",
    servedBy: ["zhipu", "bigmodel", "zai", "zai-coding-cn"],
    rule: {
      mode: "auto",
      short: {
        seconds: "unknown",
        basis: "unstated",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: "implicit caching: on by default",
      },
      minPrefixTokens: "unknown",
      sources: [
        src(ZHIPU_URL, "隐式缓存，智能识别重复的上下文内容，无需手动配置"),
        src(ZHIPU_URL, "重复的前缀内容必须足够长（建议 500 Token 以上）"),
        src(ZHIPU_URL, "按优惠价格计费（通常为标准价格的 50%）"),
        src(ZHIPU_PRICING_URL, "缓存存储当前限时免费。本页暂不展示免费期结束后的标准价格"),
      ],
      note: "the caching page recommends repeated prefixes over 500 tokens, a recommendation rather than a minimum, so the minimum prefix is unknown; the caching page says hits usually cost 50% while the pricing table shows about 22%-25%, so the hit multiplier is unknown; cache storage is billed separately (free for a limited time)",
    },
  },
  {
    id: "xai",
    servedBy: ["xai"],
    rule: {
      mode: "auto",
      short: {
        seconds: "unknown",
        basis: "best-effort",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable:
          "on by default; x-grok-conv-id (prompt_cache_key on the Responses API) improves hits",
      },
      minPrefixTokens: "unknown",
      sources: [
        src(
          XAI_URL,
          "When consecutive requests share the same starting messages, the xAI API automatically caches them."
        ),
        src(
          `${XAI_URL}/best-practices`,
          "Cache entries can be evicted at any time due to server load or restarts."
        ),
        src(`${XAI_URL}/how-it-works`, "Prompt caching is not 100% guaranteed."),
      ],
      note: "hits are billed at a reduced rate, about 15%-25% of input by model on the pricing page",
    },
  },
  {
    id: "mistral",
    servedBy: ["mistral"],
    rule: {
      mode: "explicit",
      short: {
        seconds: "unknown",
        basis: "unstated",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: 0.1,
        enable: "prompt_cache_key on the request (the same key improves hits, not guaranteed)",
      },
      minPrefixTokens: { min: 64, max: 64 },
      sources: [
        src(
          MISTRAL_URL,
          "Cached prompt tokens are billed at 10% of the standard input token price"
        ),
        src(
          MISTRAL_URL,
          "Set the same prompt_cache_key on requests that are likely to share a prefix."
        ),
        src(MISTRAL_URL, "Cache blocks contain 64 tokens."),
        src(MISTRAL_URL, "Prompts with fewer than 64 prompt tokens do not have cache hits."),
      ],
      note: "cached tokens are a multiple of 64",
    },
  },
];

// 查不到时的规则：各项未知
export const UNKNOWN_CACHE_RULE: CacheRule = {
  mode: "unknown",
  minPrefixTokens: "unknown",
  sources: [],
};

// 一行与型号的匹配度：精确型号最高，其次前缀长度，兜底行为 0，不匹配为 -1
function matchScore(row: CacheRuleRow, modelId: string): number {
  if (row.models === undefined && row.modelPrefixes === undefined) return 0;
  if (row.models?.includes(modelId)) return Number.MAX_SAFE_INTEGER;
  const prefixes = (row.modelPrefixes ?? []).filter((prefix) => modelId.startsWith(prefix));
  return Math.max(-1, ...prefixes.map((prefix) => prefix.length));
}

// 按实际服务方与模型名查表：该服务方下取匹配度最高的行；查不到为 undefined
export function findCacheRule(
  servedBy: string,
  modelId: string,
  rows: readonly CacheRuleRow[] = CACHE_RULES
): CacheRuleRow | undefined {
  let best: { row: CacheRuleRow; score: number } | undefined;
  for (const row of rows) {
    if (!row.servedBy.includes(servedBy)) continue;
    const score = matchScore(row, modelId);
    if (score >= 0 && (best === undefined || score > best.score)) {
      best = { row, score };
    }
  }
  return best?.row;
}

// 已知服务方的接口主机：按接口地址的主机名（整段匹配）判定实际服务方，值为表里该服务方的一个名字
export const SERVED_BY_HOSTS: ReadonlyArray<{ host: RegExp; servedBy: string }> = [
  { host: /^api\.deepseek\.com$/, servedBy: "deepseek" },
  { host: /^api\.anthropic\.com$/, servedBy: "anthropic" },
  { host: /^api\.openai\.com$/, servedBy: "openai" },
  { host: /^generativelanguage\.googleapis\.com$/, servedBy: "google" },
  { host: /^([a-z0-9-]+-)?aiplatform\.googleapis\.com$/, servedBy: "google-vertex" },
  { host: /^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/, servedBy: "amazon-bedrock" },
  { host: /^api\.moonshot\.(cn|ai)$/, servedBy: "moonshot" },
  { host: /^api\.kimi\.com$/, servedBy: "kimi" },
  { host: /^dashscope(-intl|-us)?\.aliyuncs\.com$/, servedBy: "dashscope" },
  { host: /\.maas\.aliyuncs\.com$/, servedBy: "alibaba-bailian" },
  { host: /^(open\.bigmodel\.cn|api\.z\.ai)$/, servedBy: "zhipu" },
  { host: /^api\.x\.ai$/, servedBy: "xai" },
  { host: /^api\.mistral\.ai$/, servedBy: "mistral" },
];

export function servedByOfHost(host: string): string | undefined {
  return SERVED_BY_HOSTS.find((entry) => entry.host.test(host))?.servedBy;
}

// ---- 设置里的覆盖（modelInfo 一节各模型的 cache；schema 在 model-info.ts）----

export interface RetentionTierOverride {
  seconds?: number;
  basis?: RetentionBasis;
  refreshOnHit?: boolean;
  writeMultiplier?: number;
  readMultiplier?: number;
}

export interface CacheRuleOverride {
  // 按哪家服务方的规则查表（经代理或兼容端点访问时指明实际服务方）；缺省为模型的 provider
  servedBy?: string;
  mode?: Exclude<CacheMode, "unknown">;
  short?: RetentionTierOverride;
  long?: RetentionTierOverride;
  minPrefixTokens?: number;
}

const UNKNOWN_TIER: RetentionTier = {
  seconds: "unknown",
  basis: "unstated",
  refreshOnHit: "unknown",
  writeMultiplier: "unknown",
  readMultiplier: "unknown",
  enable: "",
};

// 设置里给了的项逐项盖在查到的规则上（表里没有的档以全未知为底）
export function applyCacheRuleOverride(rule: CacheRule, override: CacheRuleOverride): CacheRule {
  const tier = (
    base: RetentionTier | undefined,
    over: RetentionTierOverride | undefined
  ): RetentionTier | undefined =>
    over === undefined ? base : { ...(base ?? UNKNOWN_TIER), ...over };
  const short = tier(rule.short, override.short);
  const long = tier(rule.long, override.long);
  return {
    ...rule,
    ...(override.mode !== undefined ? { mode: override.mode } : {}),
    ...(short !== undefined ? { short } : {}),
    ...(long !== undefined ? { long } : {}),
    ...(override.minPrefixTokens !== undefined
      ? { minPrefixTokens: { min: override.minPrefixTokens, max: override.minPrefixTokens } }
      : {}),
  };
}
