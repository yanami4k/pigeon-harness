// 子 agent 的设置（决策 457、480；settings.json 的 agents 一节）：maxConcurrent 为一个会话（连同它下面各层）同时在跑的
// 子 agent 上限（缺省 20，超了即派不出、不排队），maxDepth 为最多到会话往下几层（缺省 3），runWaitMinutes 为 pigeon run
// 里主 agent 停下后干等子 agent 的上限（分钟，缺省 10，0 为不限）。纯 schema 与取值，无 IO。
import { type Static, Type } from "typebox";

export const AgentsSectionSchema = Type.Object(
  {
    maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
    maxDepth: Type.Optional(Type.Integer({ minimum: 1 })),
    runWaitMinutes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);
export type AgentsSection = Static<typeof AgentsSectionSchema>;

export const DEFAULT_MAX_CONCURRENT_AGENTS = 20;
export const DEFAULT_MAX_AGENT_DEPTH = 3;
export const DEFAULT_RUN_WAIT_MINUTES = 10;

export interface AgentLimits {
  maxConcurrent: number;
  maxDepth: number;
  // 0 为不限
  runWaitMinutes: number;
}

export function agentLimitsOf(section: AgentsSection | undefined): AgentLimits {
  return {
    maxConcurrent: section?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_AGENTS,
    maxDepth: section?.maxDepth ?? DEFAULT_MAX_AGENT_DEPTH,
    runWaitMinutes: section?.runWaitMinutes ?? DEFAULT_RUN_WAIT_MINUTES,
  };
}
