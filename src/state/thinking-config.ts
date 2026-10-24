// 推理档位的取法（决策 390；settings.json 的 thinking 一节）：缺省开思考——模型信息表明支持推理的模型缺省 high，
// 不支持或不知道的缺省 off（不请求推理，上游也就不发思考参数，与之前一致）。
// 优先级：启动参数 --thinking（worker 的角色覆盖、跑批显式给的同属这一层）> 设置 thinking.level > 按模型信息的缺省。
// 各入口（终端界面、pigeon run、worker、跑批）都在装配运行面时经这里取一次，结果冻结进注入快照。
// 纯 schema 与取值，无 IO。
import { type Static, Type } from "typebox";
import { type ThinkingLevel, ThinkingLevelSchema } from "./runtime-events.ts";

export const ThinkingSectionSchema = Type.Object(
  {
    // 缺省不设（按模型信息定）；写 off 即关掉思考
    level: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false }
);
export type ThinkingSection = Static<typeof ThinkingSectionSchema>;

// 支持推理的模型的缺省档位
export const REASONING_DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

// 全部档位，按由弱到强（也是 pi-ai 的 ModelThinkingLevel 全集）
export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// 决策 558：用户级/上记录的档位在当前型号不支持时的回落——取不超过请求档位的最高可用档；
// 没有更低的就取最低可用档（xhigh + off/low/high/max → high；low + off/high → off）。回落要配一行说明，不静默夹取
export function fallbackThinkingLevel(
  level: ThinkingLevel,
  levels: readonly ThinkingLevel[]
): ThinkingLevel {
  const rank = (value: ThinkingLevel): number => ALL_THINKING_LEVELS.indexOf(value);
  const requested = rank(level);
  let best: ThinkingLevel | undefined;
  let lowest: ThinkingLevel | undefined;
  for (const candidate of levels) {
    if (lowest === undefined || rank(candidate) < rank(lowest)) lowest = candidate;
    if (requested >= 0 && rank(candidate) <= requested) {
      if (best === undefined || rank(candidate) > rank(best)) best = candidate;
    }
  }
  return best ?? lowest ?? "off";
}

// 一个模型可用的档位（决策 553）：目录给出了就用它；否则已知不支持推理只有 off，未知或支持时不限制。
// 不做静默夹取：调用方拿到列表后自己拒绝不支持的档位。
export function thinkingLevelsFor(input: {
  levels?: readonly ThinkingLevel[] | undefined;
  reasoning?: boolean | undefined;
}): readonly ThinkingLevel[] {
  if (input.levels !== undefined) return input.levels;
  if (input.reasoning === false) return ["off"];
  return ALL_THINKING_LEVELS;
}

// 没给档位时的缺省：high 可用用 high，否则取最高的非 off 档；只支持 off 时 off
export function defaultThinkingLevel(levels: readonly ThinkingLevel[]): ThinkingLevel {
  if (levels.includes(REASONING_DEFAULT_THINKING_LEVEL)) return REASONING_DEFAULT_THINKING_LEVEL;
  const usable = levels.filter((level) => level !== "off");
  return usable.at(-1) ?? "off";
}

export function resolveThinkingLevel(input: {
  // 启动参数或调用方显式给的
  requested?: ThinkingLevel | undefined;
  section?: ThinkingSection | undefined;
  // 模型信息里的"是否支持推理"；undefined 为不知道
  reasoning: boolean | undefined;
  // 可用档位（决策 553）；没给显式值时取支持的最高可用缺省
  levels?: readonly ThinkingLevel[] | undefined;
}): ThinkingLevel {
  const explicit = input.requested ?? input.section?.level;
  if (explicit !== undefined) return explicit;
  // 未知是否支持推理时仍缺省 off（决策 390、553：不知道就不请求推理；切换仍允许）
  if (input.reasoning !== true) return "off";
  return input.levels !== undefined
    ? defaultThinkingLevel(input.levels)
    : REASONING_DEFAULT_THINKING_LEVEL;
}
