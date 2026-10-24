// 斜杠命令分发（决策 067 拆分自 shell.ts，零行为变化）：grant 命令层在 application/grants.ts
//（决策 030）、恢复流程在
// application/resume.ts；语法/语义错误响亮呈现，
// 未知命令如实说明。resume 的具体动作由壳转交给对应视图模块。
// 决策 286：命令的用法与运行中能不能用在命令表（command-table.ts）；未知命令只报命令词。
import { compactFocusOf } from "../application/compaction-text.ts";
import { failureLine } from "../application/format.ts";
import { runGrantCommand } from "../application/grants.ts";
import { MEMORY_COMMAND_USAGE, MEMORY_SAVE_WAITING_TEXT } from "../application/memory-command.ts";
import {
  SANDBOX_CLEAR_UNSUPPORTED,
  SANDBOX_FORK_UNSUPPORTED,
  SANDBOX_NEW_UNSUPPORTED,
  SANDBOX_RESUME_UNSUPPORTED,
  SANDBOX_TAKE_UNSUPPORTED,
} from "../application/sandbox-session.ts";
import type { TuiWorktreesFace } from "../application/worktree-cleanup.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import type { LayeredGrantRule } from "../state/settings.ts";
import { unknownCommandText } from "./command-table.ts";
import { renderHooksView, type TuiHooksFace } from "./hooks-view.ts";

// 沙箱会话的命令面（与 shell.ts 的 TuiSandboxFace 同形）
interface CommandsSandboxFace {
  exportChanges(): Promise<string>;
}

// 决策 331：/memory 的命令面——查看两层记忆、按层编辑（编辑期间界面暂停，编辑器退出后恢复）
export interface TuiMemoryFace {
  view(): string;
  // 保存时排队：signal 取消；排队超过 1 秒仍没轮到时回调 onWaiting
  edit(
    layer: "project" | "user",
    hooks?: { signal?: AbortSignal; onWaiting?: () => void }
  ): Promise<string>;
}

// TUI 治理命令上下文（/grants /revoke /grants save；决策 030）
export interface TuiGrantsContext {
  root: string;
  store: SessionGrantStore;
  configRules: readonly ConfigGrantRule[];
  // 决策 325：放权规则连同所在层与层内序号（/grants 按层列出）
  layeredRules?: readonly LayeredGrantRule[];
}

// 决策 496：/clear（工作目录不变）与 /new [path]（path 为原样的剩余文本，可以有空格；不给即项目根）
export type NewSessionRequest = { kind: "clear" } | { kind: "new"; path?: string };

// 壳侧窄接口：命令分发需要的当前会话上下文与壳动作
export interface CommandsHost {
  addSystem(line: string): void;
  // 要醒目的一行（真正的报错），不弱化
  addAlert(line: string): void;
  render(): void;
  requestExit(): void;
  sessionId(): SessionId;
  grants(): TuiGrantsContext | undefined;
  resumeConfigured(): boolean;
  // 决策 237：沙箱会话在场；缺省 = 不在沙箱里
  sandbox?(): CommandsSandboxFace | undefined;
  // M7（决策 079）：/fork 手动分叉，交回给人看的一行（缺省 = 不可用）
  readonly forkCommand?: ((args: string) => Promise<string>) | undefined;
  resumeCommand(arg: string | undefined): void;
  // 决策 496：/clear 原地换新对话、/new [path] 在 path 开新会话（当前会话还在干活时退到面板接着跑）；缺省 = 不可用
  readonly newSessionCommand?: ((request: NewSessionRequest) => void) | undefined;
  compactCommand(focus: string | undefined): void;
  // 决策 340：/reload 重读设置（装配方给了重载入口才在场）
  readonly reloadCommand?: ((args: readonly string[]) => void) | undefined;
  // 决策 294 B1：任务清单（排好的文字）；undefined = 清单没开；缺省 = /tasks 不可用
  tasks?(): string | undefined;
  // 决策 323、324：本会话的钩子面（/hooks 的只读清单）；缺省 = /hooks 不可用
  hooksView?(): TuiHooksFace | undefined;
  // 决策 331：/memory 的命令面（缺省 = /memory 不可用）
  memory?(): TuiMemoryFace | undefined;
  // 接管 Esc（审批挂起时除外），直到返回的函数被调用；缺省 = 不能接管
  captureEscape?(onEscape: () => void): () => void;
  // 决策 492：/worktrees clean 列出清单后，界面在状态行问一次 y/N
  beginCleanConfirm?(): void;
  // 决策 448：/worktrees 的命令面（缺省 = /worktrees 不可用）
  worktrees?(): TuiWorktreesFace | undefined;
  // 决策 456：/rename 改当前会话的名字，返回落消息区的一行（改成了为 "renamed to <名字>"，不合规为报错）；缺省 = /rename 不可用
  readonly renameSession?: ((name: string) => string) | undefined;
  // 决策 442：/config（缺省 = 不可用）；参数为空即打开面板，"选项=值" 即直接改
  readonly configCommand?: ((args: string) => void) | undefined;
  // 决策 435：/rewind 打开消息树（缺省 = 不可用）
  readonly rewindCommand?: (() => void) | undefined;
  // 决策 443：/panel 打开会话面板（缺省 = 不可用）
  readonly panelCommand?: (() => void) | undefined;
  // 决策 443：/take <名字> 取回会话面板里那个会话工作树里的改动；没有这个会话即 undefined
  takePooled?(id: string): Promise<string> | undefined;
  // 决策 443：会话面板里有没有这个名字的会话（只查不取）
  hasPooled?(id: string): boolean;
  // 决策 490：/take 不带参数时列出"现在能取"的会话（会话名 + 全量会话号）
  takeableText?(): string;
  // 决策 491：/status 的一段文本（装配方现取；读会话记录等异步工作在里面做）
  statusCommand?(): Promise<string>;
  // 决策 490：/take 不带参数时把命令填进输入框，参数由输入框下方的补全列表给
  beginTakePick?(): void;
  // 决策 513：/effort [档位]——不带参数时列出档位供选；缺省 = 不可用
  effortCommand?(arg: string | undefined): void;
  // 决策 546：/login、/logout（缺省 = 不可用，沙箱里壳自己给出原因）
  beginLogin?(provider?: string): void;
  logoutCommand?(provider?: string): void;
  // 决策 550：/model [provider/model]（缺省 = 不可用，沙箱里壳自己给出原因）
  modelCommand?(arg?: string): void;
  // 决策 458：当前会话的名字（/take 用到它时说明不用取回）
  currentSessionName?(): string | undefined;
}

export function handleSlashCommand(host: CommandsHost, value: string): void {
  const tokens = value
    .slice(1)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const grants = host.grants();
  try {
    // 决策 546：/login、/logout（沙箱与未开放时由壳给出原因）
    if (tokens[0] === "login") {
      host.beginLogin?.(tokens[1]);
      return;
    }
    if (tokens[0] === "logout") {
      host.logoutCommand?.(tokens[1]);
      return;
    }
    // 决策 550：/model [provider/model]
    if (tokens[0] === "model") {
      host.modelCommand?.(tokens.length > 1 ? tokens.slice(1).join(" ") : undefined);
      return;
    }
    // S5+（裁决 033）：/quit 与双击 Ctrl+C 同一优雅退出路径（busy 语义不开旁路：
    // 运行中提交在 handleSubmit 即被拒绝，退出键仍可用）
    if (tokens[0] === "quit") {
      host.requestExit();
      return;
    }
    // 决策 237、245、526：沙箱会话——/deliver 手动交回；分叉、取回与 /resume 换绑不支持，说明原因（决策 496：/clear、/new 同 /resume）
    const sandbox = host.sandbox?.();
    if (sandbox !== undefined) {
      if (tokens[0] === "deliver") {
        void sandbox.exportChanges().then(
          (text) => {
            host.addSystem(text);
            host.render();
          },
          (error: unknown) => {
            host.addAlert(
              `delivery failed: ${error instanceof Error ? error.message : String(error)}`
            );
            host.render();
          }
        );
        return;
      }
      const reason =
        tokens[0] === "fork"
          ? SANDBOX_FORK_UNSUPPORTED
          : tokens[0] === "take"
            ? SANDBOX_TAKE_UNSUPPORTED
            : tokens[0] === "resume"
              ? SANDBOX_RESUME_UNSUPPORTED
              : tokens[0] === "new"
                ? SANDBOX_NEW_UNSUPPORTED
                : tokens[0] === "clear"
                  ? SANDBOX_CLEAR_UNSUPPORTED
                  : undefined;
      if (reason !== undefined) {
        host.addSystem(reason);
        return;
      }
    }
    // M7（决策 079）：/fork 手动分叉——分支在独立工作树里续跑，跑完回报
    const fork = host.forkCommand;
    if (fork !== undefined && tokens[0] === "fork") {
      void fork(value.trim().slice("/fork".length)).then(
        (text) => {
          host.addSystem(text);
          host.render();
        },
        (error: unknown) => {
          host.addAlert(failureLine("fork", error));
          host.render();
        }
      );
      return;
    }
    // 决策 443、490：/take <会话号> 把会话面板里那个会话工作树里的改动取回主工作目录；
    // 不带参数列出现在能取的（会话号是全量 ULID，不做前缀或后缀模糊）
    if (tokens[0] === "take") {
      const id = tokens[1];
      if (id === undefined) {
        if (host.beginTakePick !== undefined) {
          host.beginTakePick();
          return;
        }
        host.addSystem(host.takeableText?.() ?? "usage: /take [session ID]");
        return;
      }
      // 决策 458：当前会话也在会话面板里列着，但它的改动就在本工作区里，没有可取回的
      if (host.hasPooled?.(id) !== true && host.sessionId() === id) {
        host.addSystem(`${id} is the current session; nothing to take`);
        return;
      }
      const pooled = host.takePooled?.(id);
      if (pooled === undefined) {
        host.addSystem(`no session with ID ${id} in the session panel`);
        return;
      }
      void pooled.then((text) => {
        host.addSystem(text);
        host.render();
      });
      return;
    }
    // 决策 294 B1：/tasks 查看任务清单（完整的清单显示留给编排二段）
    if (tokens[0] === "tasks" && host.tasks !== undefined) {
      host.addSystem(host.tasks() ?? "task list is off");
      return;
    }
    // 决策 331：/memory 查看两层记忆；/memory edit project|user 用编辑器修改一层（存盘后校验，不合格保留原内容）
    const memory = host.memory?.();
    if (tokens[0] === "memory" && memory !== undefined) {
      if (tokens.length === 1) {
        host.addSystem(memory.view());
        return;
      }
      const layer = tokens[2];
      if (
        tokens[1] === "edit" &&
        tokens.length === 3 &&
        (layer === "project" || layer === "user")
      ) {
        // 保存时排队超过 1 秒才提示，提示出现起 Esc 取消；保存结束即交还 Esc
        const cancel = new AbortController();
        let releaseEscape: (() => void) | undefined;
        void memory
          .edit(layer, {
            signal: cancel.signal,
            onWaiting: () => {
              releaseEscape = host.captureEscape?.(() => cancel.abort());
              host.addSystem(MEMORY_SAVE_WAITING_TEXT);
              host.render();
            },
          })
          .then(
            (text) => {
              host.addSystem(text);
              host.render();
            },
            (error: unknown) => {
              host.addAlert(failureLine("command", error));
              host.render();
            }
          )
          .finally(() => releaseEscape?.());
        return;
      }
      host.addSystem(MEMORY_COMMAND_USAGE);
      return;
    }
    // 决策 448：/worktrees 列出、删除留下的 worker 工作树与分支（删除要再确认一次）
    const worktrees = host.worktrees?.();
    if (tokens[0] === "worktrees" && worktrees !== undefined) {
      host.addSystem(worktrees.run(tokens.slice(1)));
      // 决策 492：clean 列出了将删的清单即进入"问一次 y/N"；答别的、Esc、或下一条命令都作罢
      if (worktrees.hasPending()) host.beginCleanConfirm?.();
      return;
    }
    // 决策 443：/panel 打开会话面板
    if (tokens[0] === "panel" && host.panelCommand !== undefined) {
      host.panelCommand();
      return;
    }
    // 决策 435：/rewind 打开消息树
    if (tokens[0] === "rewind" && host.rewindCommand !== undefined) {
      host.rewindCommand();
      return;
    }
    // 决策 442：/config 打开设置面板；/config 选项=值 直接改
    if (tokens[0] === "config" && host.configCommand !== undefined) {
      host.configCommand(value.trim().slice("/config".length).trim());
      return;
    }
    // 决策 513：/effort [档位] 切换思考强度
    if (tokens[0] === "effort" && host.effortCommand !== undefined) {
      host.effortCommand(tokens[1]);
      return;
    }
    // 决策 456：/rename <名字> 改当前会话的名字：记进会话记录（续接后还在）
    if (tokens[0] === "rename" && host.renameSession !== undefined) {
      const name = value.trim().slice("/rename".length).trim();
      const reply = name === "" ? "usage: /rename <name>" : host.renameSession(name);
      if (reply !== "") host.addSystem(reply);
      return;
    }
    // 决策 189：/compact [重点] 手动压缩（重点作为摘要的附加说明）
    if (tokens[0] === "compact") {
      host.compactCommand(compactFocusOf(value));
      return;
    }
    // 决策 323、324：/hooks 只读列出生效的钩子与停用开关（清单随会话冻结，清单与开关取自钩子面）
    if (tokens[0] === "hooks") {
      const hooks = host.hooksView?.();
      if (hooks !== undefined) {
        host.addSystem(renderHooksView(hooks));
        return;
      }
    }
    // 决策 491：/status——只读，运行中也能看
    if (tokens[0] === "status" && host.statusCommand !== undefined) {
      void host.statusCommand().then(
        (text) => {
          host.addSystem(text);
          host.render();
        },
        (error: unknown) => {
          host.addAlert(error instanceof Error ? error.message : String(error));
          host.render();
        }
      );
      return;
    }
    // 决策 340：/reload 重读设置（结果与待确认条目写进消息区）
    if (tokens[0] === "reload" && host.reloadCommand !== undefined) {
      host.reloadCommand(tokens.slice(1));
      return;
    }
    // 决策 496：/clear 原地换新对话（不带参数）；/new [path] 在 path 开新会话（不给即项目根）
    if (tokens[0] === "clear" && host.newSessionCommand !== undefined) {
      if (tokens.length > 1) {
        host.addSystem("usage: /clear");
        return;
      }
      host.newSessionCommand({ kind: "clear" });
      return;
    }
    if (tokens[0] === "new" && host.newSessionCommand !== undefined) {
      const path = value.trim().slice("/new".length).trim();
      host.newSessionCommand(path === "" ? { kind: "new" } : { kind: "new", path });
      return;
    }
    // S4：/resume <sessionId> 冷恢复对账 + 换绑续跑（异步流程，见 resume-view.ts）
    if (tokens[0] === "resume" && host.resumeConfigured()) {
      host.resumeCommand(tokens[1]);
      return;
    }
    const handled =
      grants !== undefined &&
      runGrantCommand(tokens, {
        root: grants.root,
        store: grants.store,
        configRules: grants.configRules,
        ...(grants.layeredRules !== undefined ? { layeredRules: grants.layeredRules } : {}),
        sessionId: host.sessionId(),
        write: (text) => {
          host.addSystem(text.trimEnd());
        },
      });
    if (!handled) {
      host.addSystem(unknownCommandText(value));
    }
  } catch (error) {
    host.addAlert(failureLine("command", error));
  }
}
