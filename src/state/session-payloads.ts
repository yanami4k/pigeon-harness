// 会话事实的载荷形状（决策 177 / 184）：分叉与授权各写入点交给新会话存储的输入，以及它们共用的子结构（工作树、分叉点、
// 快照引用）。纯类型、无 IO；写成哪种自定义条目或文件头见 session-entries.ts。
// 决策 322：验证记录已停写，AttemptVerifiedInput 随验证门删除；旧会话里的验证条目形状留在 session-entries.ts 供读取。
// 决策 457：worker 的派出与收尾不再写，旧会话里的这两种条目读到即跳过（决策 477），它们的形状一并删除
import { type Static, Type } from "typebox";
import { GrantIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";

// git 工作树（分支会话在它里面续跑）；可选的起点提交
export const GitWorktreeWorkspaceSchema = Type.Object({
  kind: Type.Literal("git-worktree"),
  baseCommit: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" })),
  path: Type.String({ minLength: 1 }),
  branch: Type.String({ minLength: 1 }),
});
export type GitWorktreeWorkspace = Static<typeof GitWorktreeWorkspaceSchema>;

// 分叉点：来源会话里某次 Run 的条目号（含该条，之后的消息不进分支）
export const ForkPointSchema = Type.Object({
  runId: RunIdSchema,
  runSeq: Type.Integer({ minimum: 1 }),
});
export type ForkPoint = Static<typeof ForkPointSchema>;

// 分叉点快照引用：分叉点之前最近的快照提交与其 ref
export const CheckpointRefSchema = Type.Object({
  ref: Type.String({ minLength: 1 }),
  commit: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }),
});
export type CheckpointRef = Static<typeof CheckpointRefSchema>;

export const ForkTriggerSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("retry-on-fail"),
]);
export type ForkTrigger = Static<typeof ForkTriggerSchema>;

// ---- 写入点交给会话存储的输入（runId 可缺省：人以命令派出或授权时没有活动 Run） ----

const OptionalRunId = { runId: Type.Optional(RunIdSchema) } as const;

// 授权建立（M4 S6，决策 3）：firstCall 记录触发创建的那次调用
export const GrantCreatedInputSchema = Type.Object({
  ...OptionalRunId,
  grantId: GrantIdSchema,
  tool: Type.String({ minLength: 1 }),
  // 决策 3a 目录限定：工作区相对目录；缺省 = 工具级（不限路径）
  pathPrefix: Type.Optional(Type.String({ minLength: 1 })),
  // 决策 048：exec 档精确命令串——只放行这条一模一样的命令
  command: Type.Optional(Type.String({ minLength: 1 })),
  shell: Type.Optional(Type.Boolean()),
  // 决策 290：按网站放权的主机名（web_fetch）
  host: Type.Optional(Type.String({ minLength: 1 })),
  createdAt: Type.Integer({ minimum: 0 }),
  firstCall: Type.Object({
    toolCallId: Type.String({ minLength: 1 }),
    args: Type.Unknown(),
  }),
});
export type GrantCreatedInput = Static<typeof GrantCreatedInputSchema>;

export const GrantRevokedInputSchema = Type.Object({
  ...OptionalRunId,
  grantId: GrantIdSchema,
  revokedAt: Type.Integer({ minimum: 0 }),
});
export type GrantRevokedInput = Static<typeof GrantRevokedInputSchema>;

// 分叉（M7，决策 077）：写进来源会话；新分支标识即分支会话号
export const SessionForkedInputSchema = Type.Object({
  ...OptionalRunId,
  forkPoint: ForkPointSchema,
  branchSessionId: SessionIdSchema,
  checkpoint: CheckpointRefSchema,
  trigger: ForkTriggerSchema,
  forkedAt: Type.Integer({ minimum: 0 }),
});
export type SessionForkedInput = Static<typeof SessionForkedInputSchema>;

// 分支会话的来历（写进分支会话文件头）；分支恒在独立工作树里续跑
export const BranchHeaderInputSchema = Type.Object({
  ...OptionalRunId,
  sourceSessionId: SessionIdSchema,
  forkPoint: ForkPointSchema,
  checkpoint: CheckpointRefSchema,
  workspace: GitWorktreeWorkspaceSchema,
  trigger: ForkTriggerSchema,
  startedAt: Type.Integer({ minimum: 0 }),
});
export type BranchHeaderInput = Static<typeof BranchHeaderInputSchema>;
