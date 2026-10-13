// grant 斜杠命令层（M4 S6 决策 3 + D6；M2 S3 决策 030 从 cli/ 归位 application/）：
// /grants 列表、/revoke <id> 撤销、/grants save <id> 升格（决策 325：写入项目个人设置 .pigeon/settings.local.json 的
// permissions 一节；三层的放权规则并集生效，/grants 按层列出，/revoke config#N 只移除项目个人一层的规则）。cli REPL 与 tui 消息区两个
// Actor 共用这同一份命令逻辑（025 的方向：共用逻辑住 Controller 层，Actor 互依别扭）；
// 输出经注入的 write 回调投影到各自界面（终端界面的消息区），命令层不关心落点。
// /grants 是 grant 的唯一展示入口（决策 3b：崩溃恢复不加特殊展示行，生效 grant 统一
// 由本命令呈现）；升格与配置的正规写入方都是人的显式命令（约束 3：agent / 模型 /
// 后台流程无写放权配置的代码路径）。
// 升格与移除只操作放权配置文件（决策 128：原先的固化升格与固化移除两种留痕已退役）；
// 固化规则的稳定身份是 promotedFrom.grantId，审批决定的配置规则命中按它回指。
// M5.5 S5（决策 048）：exec 档的精确命令放权同一套流程——升格与移除都携带 command。
// 决策 290：网络档的按网站放权同一套流程——升格与移除都携带 host。
// IO 全依赖注入：write 是内联结构类型（一行文本回调），命令层不 import 任何 Actor。

import { GrantNotFoundError, type SessionGrantStore } from "../approvals/grant-store.ts";
import {
  appendGrantConfigRule,
  findPromotedRuleIndex,
  GrantAlreadyPromotedError,
  loadGrantConfig,
  removeGrantConfigRule,
} from "../persistence/grants-config.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { asGrantId, type GrantId, type SessionId } from "../state/ids.ts";
import { LOCAL_SETTINGS_FILE, pigeonRel } from "../state/paths.ts";
import type { LayeredGrantRule } from "../state/settings.ts";
import { plural, shortId, summarizeArgs } from "./format.ts";

export interface GrantsCommandContext {
  // 治理根（项目个人设置所在；目录限定解析根）
  root: string;
  // 会话 grant 运行态（含命中计数）
  store: SessionGrantStore;
  // 随设置快照装载的固化规则（会话开始与 /reload 重建时；其间求值面不变）
  configRules: readonly ConfigGrantRule[];
  // 决策 325：同一批规则连同所在层与层内序号（设置快照给出）；缺省按全部在项目个人一层列出
  layeredRules?: readonly LayeredGrantRule[];
  // 本会话 sessionId（升格出处 promotedFrom.sessionId）
  sessionId: SessionId;
  write: (text: string) => void;
}

// 时间渲染：UTC（ISO 切片），与 session list 同约定——测试文本比对与 grep 友好
function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

// 作用域措辞（唯一约定：/grants 与 trace 共用口径）
function scopeWording(
  pathPrefix: string | undefined,
  command?: string,
  shell?: boolean,
  host?: string
): string {
  if (host !== undefined) {
    return `site ${host}`;
  }
  if (command !== undefined) {
    return `command ${command}${shell === true ? " (via shell)" : ""}`;
  }
  return pathPrefix === undefined ? "all paths" : `path ${pathPrefix}`;
}

// 放权作用域字段的原样携带（升格写配置用）
function scopeFields(scope: {
  pathPrefix?: string;
  command?: string;
  shell?: boolean;
  host?: string;
}): {
  pathPrefix?: string;
  command?: string;
  shell?: boolean;
  host?: string;
} {
  return {
    ...(scope.pathPrefix !== undefined ? { pathPrefix: scope.pathPrefix } : {}),
    ...(scope.command !== undefined ? { command: scope.command } : {}),
    ...(scope.shell === true ? { shell: true } : {}),
    ...(scope.host !== undefined ? { host: scope.host } : {}),
  };
}

// 解析并执行一条斜杠命令（tokens = 去掉 "/" 后的空白分词）。
// 返回 false = 非 grant 命令（Actor 交其他分发）；语法/语义错误响亮抛错由 Actor 呈现
export function runGrantCommand(tokens: string[], ctx: GrantsCommandContext): boolean {
  const [head, ...rest] = tokens;
  if (head === "grants") {
    if (rest.length === 0) {
      listGrants(ctx);
      return true;
    }
    if (rest[0] === "save" && rest.length === 2 && rest[1] !== undefined) {
      promoteGrant(ctx, rest[1]);
      return true;
    }
    throw new Error("usage: /grants | /grants save <grantId>");
  }
  if (head === "revoke") {
    if (rest.length !== 1 || rest[0] === undefined) {
      throw new Error("usage: /revoke <grantId|config#N>");
    }
    revokeGrant(ctx, rest[0]);
    return true;
  }
  return false;
}

// /grants：会话 grant（createdAt / 命中次数 / 作用域 / 首调摘要）+ 固化规则
//（promotedAt / 出处会话与首调）。无任何生效项时如实说明。
// config#N 是展示与 /revoke 输入用的位置序号；账本回指用的身份是出处 grant（决策 ①）
function listGrants(ctx: GrantsCommandContext): void {
  const lines: string[] = [];
  const sessionGrants = ctx.store.list();
  lines.push(`session grants (${sessionGrants.length}):`);
  for (const grant of sessionGrants) {
    lines.push(
      `  ${grant.grantId} | ${grant.tool} | ${scopeWording(grant.pathPrefix, grant.command, grant.shell, grant.host)} | ` +
        `created ${formatTime(grant.createdAt)} | ${plural(grant.hitCount, "hit")} | ` +
        `first call ${grant.firstCall.toolCallId} (${summarizeArgs(grant.firstCall.args)})`
    );
  }
  const layered =
    ctx.layeredRules ??
    ctx.configRules.map((rule, index) => ({ layer: "local" as const, index, rule }));
  lines.push(`saved rules (${layered.length}):`);
  for (const { layer, index, rule } of layered) {
    // 只有项目个人一层的规则可用 /revoke 移除；其余层写明出处，由人手工编辑
    const label = layer === "local" ? `config#${index}` : `${layer}#${index}`;
    lines.push(
      `  ${label} | ${rule.tool} | ${scopeWording(rule.pathPrefix, rule.command, rule.shell, rule.host)} | ` +
        `saved ${formatTime(rule.promotedFrom.promotedAt)} | ` +
        `from session ${shortId(rule.promotedFrom.sessionId)} / grant ${shortId(rule.promotedFrom.grantId)} | ` +
        `first call ${rule.promotedFrom.firstCall.toolCallId}`
    );
  }
  if (sessionGrants.length === 0 && layered.length === 0) {
    lines.push("  (none)");
  }
  ctx.write(`${lines.join("\n")}\n`);
}

// /grants save <id>：升格——会话 grant → 项目配置（D6：promotedFrom 出处结构化留证）。
// 顺序：查重（同 grantId 已固化则响亮拒绝）→ 写配置。固化规则在下次会话启动或 /reload 之后
// 进求值面（在此之前本会话按原规则求值），输出如实标注
function promoteGrant(ctx: GrantsCommandContext, id: string): void {
  let grantId: GrantId;
  try {
    grantId = asGrantId(id);
  } catch {
    throw new Error(`not a session grant: ${id}`);
  }
  const grant = ctx.store.get(grantId);
  if (grant === undefined) {
    throw new GrantNotFoundError(`grant not found or revoked: ${id}`);
  }
  // 查重读磁盘现状而非会话冻结的 configRules：本会话内已升格的也算
  const existingIndex = findPromotedRuleIndex(loadGrantConfig(ctx.root), grantId);
  if (existingIndex !== -1) {
    throw new GrantAlreadyPromotedError(
      `grant ${grantId} already saved as config#${existingIndex}`
    );
  }
  const promotedAt = Date.now();
  appendGrantConfigRule(ctx.root, {
    tool: grant.tool,
    ...scopeFields(grant),
    promotedFrom: {
      grantId: grant.grantId,
      sessionId: ctx.sessionId,
      firstCall: grant.firstCall,
      promotedAt,
    },
  });
  ctx.write(`saved ${grant.grantId} → ${pigeonRel(LOCAL_SETTINGS_FILE)}\n`);
}

// /revoke <id>：会话 grant 立即停免审（grant.revoked 事件留证）；配置规则从
// 项目个人设置移除——下次会话启动或 /reload 之前本会话仍按原规则求值，如实标注
function revokeGrant(ctx: GrantsCommandContext, id: string): void {
  if (id.startsWith("grant_")) {
    ctx.store.revoke(asGrantId(id));
    ctx.write(`revoked ${id}\n`);
    return;
  }
  const match = /^config#(\d+)$/.exec(id);
  if (match !== null) {
    const index = Number(match[1]);
    const removed = removeGrantConfigRule(ctx.root, index);
    ctx.write(`removed config#${match[1]} (${removed.tool})\n`);
    return;
  }
  throw new Error(`can't revoke ${id}: not a grant_ id or config#N`);
}
