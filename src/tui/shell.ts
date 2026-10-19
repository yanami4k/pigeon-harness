// Application Shell（M2 S2，ROADMAP §M2 交付第 1 件）：pi-tui ProcessTerminal + TuiMainScreen
// 驱动的最小壳——消息区（每消息一个 Text）+ 底行输入区 + 纯 ASCII chrome（标题/状态栏）。
//
// 决策 067 拆分（零行为变化）：消息流在 message-flow.ts，审批面板与按键路由在 modal.ts，
// 斜杠命令分发在 commands.ts，resume / 历史 / 换绑在
// resume-view.ts；本文件保留布局、启停、提交与事件渲染，并重新导出原有公开符号（导入方不变）。
// 运行中、恢复中、待审批、退出布防等状态一律由本壳持有，子模块经窄接口读写，不各自存一份。
//
// 边界与纪律：
// - TUI 只通过 Application API 提交意图（ROADMAP §M2 完成证据）：输入提交唯一通道是
//   TuiRuntimeFace.run()，绝不直连上游 Agent；PiRuntimeAdapter 结构满足该面。
// - 消息区内容源（决策 024）：subscribeStream 的 text_delta 渲染当前 assistant 消息流式生长；
//   subscribe 的 turn.started/turn.completed/tool.proposed/tool.settled/run.ended 渲染轮次
//   标记与工具调用行（措辞复用 application/format.ts 的通俗措辞约定）；user 消息提交时回显。
// - spike 施工纪律（docs/notes/spike-pi-tui.zh-CN.md）：每消息一个 Text 组件，禁止单 Text
//   装全部历史（A5a 实测线性退化）；自有 chrome 只用 ASCII（歧义宽字符不进边框/状态栏账目，
//   内容区不限制）；不设计依赖 CPR/DSR 应答的探测；resize 交给 pi-tui 全量重绘，本壳不自持
//   宽度缓存副本。
// - ScrollView follow:"end" 包装消息流：TuiMainScreen（main-screen 模式）不走 layout.js
//   布局引擎，ScrollView 的裁剪/follow 不激活，follow-end 由终端 scrollback 天然实现
//   （内容超高流入回卷，差分渲染器重写尾部）；包装声明意图，alt-screen 布局引擎下自动生效。
// - 运行中输入（决策 286 第 4 项，取代决策 027 的 busy 拒绝）：运行中（含压缩、/resume 进行中）提交的输入进队列
//   （input-queue.ts），空闲后逐条自动发出；Esc 中断时排队内容退回输入框，Alt+Up（Windows 下另认 Alt+Q）随时退回。
//   斜杠命令不排队：只读类与 /quit 运行中照常执行，改主会话状态或工作目录的命令拒绝并说明原因、输入留在
//   输入框（放行表在 command-table.ts）。
// - 审批面板（S3，决策 029）、取消键（S5 裁决 032）与退出三层形态（S5+ 裁决 033）的交互语义见 modal.ts；
//   壳停止时挂起的审批 fail-closed 按拒绝处理（理由逐字）。
// - 决策 286 其余各项：输入框为 pi-tui Editor（input-editor.ts，多行、粘贴保留换行、历史跨启动保留）；输入框下方一行
//   状态栏（status-bar.ts：模型、上下文用量、本会话花费）；工具调用行下方显示结果（缺省收起，Ctrl+O
//   展开或收起全部）；/resume 不带会话号弹出会话选择器（session-picker.ts）；运行期告警经 addWarning 落消息区。
// - 斜杠命令（S3，决策 030）：/grants /revoke /grants save 走 application/grants.ts 的
//   命令层（application/grants.ts），输出经 write 回调投影到消息区——零新增治理语义。
// - 收尾行（决策 452，取代 S5 的终态摘要）：一次工作（从人发出消息到 agent 干完，含 Stop 钩子拦下后接着跑的各轮）结束时落
//   一行，如 "done · 1m 23s"，不写失败分类（措辞在 application/format.ts 的 workEndLine）；listenerErrors 非空时消息区
//   增量警告（D2 可见化的 TUI 投影，措辞与增量报数口径同 cli repl：启动即查 + 每次 run 收尾复查）。
// - dispose 对称：取消键的订阅与监听器一律进 disposers，在 start/stop 里成对出现。
// - 决策 457：worker 的编排面板、整屏树形视图与 worker 会话视图已删除；消息树是会话回退自己的整屏视图（rewind）。
import {
  type AutocompleteItem,
  type Component,
  type Editor,
  isKeyRelease,
  Loader,
  matchesKey,
  Spacer,
  type StackChild,
  type Terminal,
  Text,
  VStack,
} from "@earendil-works/pi-tui";
import { compactionNoticeText, manualCompactionText } from "../application/compaction-text.ts";
import { type ConfigItemView, parseConfigAssignment } from "../application/config-options.ts";
import { failureLine, plural, workEndLine } from "../application/format.ts";
import { loadSessionHistory } from "../application/history.ts";
import type { HookEventReport } from "../application/hooks.ts";
import type { PromptHistoryStore } from "../application/prompt-history.ts";
import { listRecentMainSessions } from "../application/recent-sessions.ts";
import type {
  CodeCheck,
  PreparedRewind,
  RewindNode,
  RewindOutcome,
} from "../application/rewind.ts";
import { createSessionFilter } from "../application/search.ts";
import {
  accumulatedSessionCost,
  addUsage,
  ChildSessionCosts,
  type CostTally,
  emptyCostTally,
  mergeCostTally,
} from "../application/session-cost.ts";
import type {
  PooledSessionCard,
  PooledSessionState,
  SessionPanelSource,
} from "../application/session-pool.ts";
import { renameStoredSession } from "../application/session-rename.ts";
import { SETTINGS_RELOADED_PREFIX, SETTINGS_UNCHANGED } from "../application/settings-reload.ts";
import type { SubagentRecord } from "../application/subagents.ts";
import { sessionsDirOf } from "../application/workspace.ts";
import type { TuiWorktreesFace } from "../application/worktree-cleanup.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { ensureStateDirOf } from "../persistence/settings.ts";
import type {
  CompactionNotice,
  ManualCompactionOutcome,
  RunResult,
  StreamTextDelta,
  ToolResultNotice,
} from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { DEFAULT_STOP_HOOK_BLOCK_CAP } from "../state/hooks.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { TurnCompletedPayload } from "../state/runtime-events.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import type { RewindMode, RunStopCause } from "../state/session-entries.ts";
import { toolResultModelUsage } from "../state/tool-usage.ts";
import { AgentPanel, agentActive, agentStateWord } from "./agent-panel.ts";
import { openExternalUrl, PigeonAltScreen, TrimmedTranscript } from "./alt-screen.ts";
import type { ApprovalBlockLine, ApprovalPanelResult, TuiApprovalFace } from "./approval.ts";
import { ApprovalArea } from "./approval-area.ts";
import { isGlobalCommand, rejectWhileRunning } from "./command-table.ts";
import {
  type CommandsHost,
  handleSlashCommand as dispatchSlashCommand,
  type NewSessionRequest,
  type TuiGrantsContext,
  type TuiMemoryFace,
} from "./commands.ts";
import { ConfigPanel } from "./config-panel.ts";
import type { TuiHooksFace } from "./hooks-view.ts";
import {
  createPromptEditor,
  openArgumentCompletions,
  type PromptAutocomplete,
  setPromptAutocompleteRoot,
} from "./input-editor.ts";
import { InputQueue } from "./input-queue.ts";
import { installKeybindings, isKey, type KeybindingRow } from "./keybindings.ts";
import { attachToolResultTo, MessageFlow, projectRuntimeEvent } from "./message-flow.ts";
import {
  MessageTree,
  type RewindAction,
  rewindMenuTitle,
  type VersionRow,
} from "./message-tree.ts";
import {
  askApprovalPanel,
  closePendingModals,
  disarmExitOnInput,
  EXIT_HINT,
  handleShellKey,
  type ModalHost,
  type PendingApproval,
} from "./modal.ts";
import {
  handleResumeCommand as dispatchResumeCommand,
  type ResumeOptions,
  type ResumeViewHost,
  renderHistory,
  type SessionBinding,
} from "./resume-view.ts";
import { SessionPanel } from "./session-panel.ts";
import { SessionPicker } from "./session-picker.ts";
import { StatusBar } from "./status-bar.ts";
import type { StatusReport } from "./status-report.ts";
import { statusReportText } from "./status-report.ts";
import { secondary } from "./style.ts";
import { WelcomeHeader, type WelcomeInfo } from "./welcome.ts";

export type { NewSessionRequest, TuiGrantsContext } from "./commands.ts";

// Application API 面：TUI 提交意图与订阅投影的唯一通道（决策 025 的实体）。
// 结构类型——PiRuntimeAdapter 直接满足；测试注入假实现断言「只经 application API」。
export interface TuiRuntimeFace {
  run(input: string): Promise<RunResult>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void;
  // S5 取消入口：中断当前 Run（Adapter 固定姿势 abort → waitForIdle，注释约束 5，
  // 任何路径不悬挂；终态由并发等待的 run() 返回承载）。打转叫停带上原因（307），收尾条目记结束方式为打转
  interrupt(cause?: RunStopCause): Promise<void>;
  // S5 D2 可见化投影：会话记录写入失败观察口（措辞与增量报数口径同 cli repl）
  listenerErrors(): unknown[];
  // 决策 189：压缩完成的提示（自动与手动）与手动压缩；缺省（替身运行面）即不提示、/compact 不可用
  subscribeCompaction?(listener: (notice: CompactionNotice) => void): () => void;
  compact?(customInstructions?: string): Promise<ManualCompactionOutcome>;
  // 决策 297、480：待递的通知（子 agent 的结果与消息、后台作业结束等）——待递的条数与空闲时只带通知跑一轮；缺省（替身运行面）即不支持
  pendingNotices?(): number;
  runNotices?(): Promise<RunResult>;
  // 决策 286：工具结果（展开显示与 diff）与上下文用量（状态栏）；缺省即不显示结果块、状态栏不显示上下文
  subscribeToolResults?(listener: (notice: ToolResultNotice) => void): () => void;
  contextUsage?(): { tokens: number; contextWindow: number } | undefined;
  // 决策 484：在跑的这一轮的号（换到一个正在跑的会话时接上它的增量）
  currentRunId?(): RunId | undefined;
}

// /resume 换绑产物（S4）：目标会话的新运行面与新治理上下文（形状定义在 resume-view.ts）
export interface TuiSessionBinding extends SessionBinding<TuiRuntimeFace, TuiGrantsContext> {
  // 决策 323/324：目标会话的钩子面——换绑后本会话的会话级事件用它（各会话的清单随各自的快照冻结）
  hooks?: TuiHooksFace;
  // 决策 484：目标会话的工作区（路径补全与 @ 引用的根跟着换）
  workspaceRoot?: string;
  // 决策 485：目标会话所属项目的治理根（会话记录、续接列表与花费从这里读）；缺省启动时的
  root?: string;
}

export interface TuiShellOptions {
  terminal: Terminal;
  runtime: TuiRuntimeFace;
  sessionId: SessionId;
  // pi-tui 崩溃/调试日志目录（行宽护栏 throw 时写 pi-crash.log）
  logDir?: string;
  // S3：grant 治理面投影——/grants /revoke /grants save 的命令上下文（命令层在
  // application/grants.ts）；缺省 = 斜杠命令不可用
  grants?: TuiGrantsContext;
  // 会话目录所在的根（续接时从会话记录累计已有花费、子会话的花费用）；终端界面不再有 /sessions（看会话、切会话用 /resume）
  sessions?: { root: string };
  // S4：/resume <sessionId> 恢复入口——对账流程在 application/resume.ts（写盘路径唯一）；
  // rebind 由装配方注入：对账收口后按目标 sessionId 重建运行面（restoredGrants 种子）
  // 并释放旧运行面；缺省 = /resume 不可用
  resume?: ResumeOptions<TuiSessionBinding>;
  // 决策 496：/clear 与 /new [path]——装配方建好新会话核，交出它的会话号与换绑产物（/clear 工作目录不变；/new 在 path，
  // 不给即项目根）；路径不对等开不成的抛错（写一行报错，留在原会话）。缺省 = 两者不可用
  newSession?: {
    create: (
      request: NewSessionRequest
    ) => Promise<{ sessionId: SessionId; binding: TuiSessionBinding }>;
  };
  // 决策 491：/status 的数据（装配方现取：治理根、工作区、记录与设置、审批模式、用量、git、沙箱、子 agent）；
  // 缺省 = /status 不可用
  status?: () => Promise<StatusReport>;
  // 决策 340：/reload 重读设置——返回给人看的行（装配方实现：重读、确认、换上新快照并重建运行面）
  reload?: (args: readonly string[]) => Promise<string[]>;
  // S5+（裁决 033）：优雅退出回调——双击 Ctrl+C / /quit 触发；壳先 stop() 再回调。
  // 注入使测试绝不真退进程；缺省 = 退出只停壳（装配方必须注入真实退出路径）
  onExit?: () => void;
  // 双击窗口（毫秒）：缺省 1000；测试注入小窗口断言过期语义
  exitWindowMs?: number;
  // 决策 457、482：子 agent 面板与进入子 agent；缺省没有（沙箱、--no-subagents）
  agents?: TuiAgentsFace;
  // M5 S2（决策 045）：/resume 历史渲染的安全上限（行）；缺省 500
  historyLimit?: number;
  // M7（决策 079）：/fork 手动分叉（交回给人看的一行）；缺省 = 命令不可用
  fork?: (args: string) => Promise<string>;
  // 决策 237、245：沙箱会话——/export 手动交回；分叉与 /resume 换绑在沙箱里不支持，命令给出原因
  sandbox?: TuiSandboxFace;
  // 决策 294 B1：/tasks 查看当前会话的任务清单（排好的文字）；返回 undefined = 清单没开；缺省 = 命令不可用
  tasks?: () => string | undefined;
  // 决策 451：对话流最上方的欢迎头（版本、模型、当前目录）；缺省不放
  welcome?: WelcomeInfo;
  // 决策 469：主会话的审批模式（每次现取：/reload 等重建运行面后换成新的）；缺省 = 状态栏不写模式、Shift+Tab 不做事
  approvalMode?: () => ApprovalModeControl | undefined;
  // 决策 470：输入框为空时按两下 ← 打开会话面板（设置 tui.leftArrowOpensPanel，每次现取）；缺省开着
  leftArrowOpensPanel?: () => boolean;
  // 决策 286：主 agent 的模型接入（DeepSeek 回复自带价格为 0 时按官方人民币价目计会话花费）；缺省不另计价
  provider?: string;
  // 决策 286：输入历史的跨启动存储（按项目）；缺省只在本次启动内保留
  promptHistory?: PromptHistoryStore;
  // 时钟（缺省 Date.now，测试注入）
  now?: () => number;
  // 决策 323、324：当前会话的钩子面（会话级事件与 /hooks）；缺省 = 本会话不接钩子
  hooks?: TuiHooksFace;
  // 决策 323：收尾钩子的连续拦截上限（取设置快照的 merged.stopHookBlockCap，/reload 后跟着变）；缺省 8
  stopHookCap?: () => number;
  // 决策 331：/memory 的命令面（记忆按项目与用户分层，不跟会话走）；缺省 = 命令不可用
  memory?: TuiMemoryFace;
  // 决策 448：/worktrees 的命令面（留下的工作树与分支）；缺省 = 命令不可用
  worktrees?: TuiWorktreesFace;
  // 决策 446：一轮真正收尾、空闲下来之前调用（会话移进工作树时在这里换运行面）；期间仍按在跑处理，输入排队
  // 没有要做的返回 undefined（照常同步空闲下来）
  afterTurn?: (info: { cancelled: boolean }) => Promise<void> | undefined;
  // 决策 456：/rename 改当前会话的名字（记进会话记录）；返回给人看的一行。缺省 = 命令不可用
  renameSession?: (name: string) => string;
  // 决策 456：会话的显示名（会话记录里记的，没改过名为缺省名）；会话面板上当前会话的卡片与 /take 的说明用。缺省 = 会话号
  sessionName?: (sessionId: string) => string;
  // 决策 439：点链接时打开网址（缺省用系统缺省方式，见 alt-screen.ts）；测试注入
  openUrl?: (url: string) => void;
  // 决策 441：读系统剪贴板（Windows 上右键粘贴用）；缺省 = 右键不粘贴
  readClipboard?: () => Promise<string>;
  // 决策 433–438：会话回退（读消息树、规划、给现状拍快照、执行）；缺省 = 不可用
  rewind?: TuiRewindFace;
  // 决策 443：会话面板；缺省 = 不可用
  pool?: TuiPoolFace;
  // 决策 442：/config 的取数与改动（生效值、用户级的值与覆盖情况；改动写用户级设置，返回写到的文件）；缺省 = 不可用
  config?: {
    view(): ConfigItemView[];
    // 写到的文件；值没变、没有写时为 undefined
    set(id: string, value: string): string | undefined;
    // 决策 465：设置视图的键位组（每个动作的生效键、缺省键与冲突）；改键位经 set（名字带 keybindings: 前缀）。缺省没有键位组
    keys?(): KeybindingRow[];
    // 现在不能改的原因（有子 agent 在跑等）；能改为 undefined
    busy?(): string | undefined;
  };
  // 决策 439：输入框补全（"/" 命令、Tab 路径、"@" 文件）；缺省不接
  autocomplete?: PromptAutocomplete;
  // 决策 439：设置里的键位（keybindings 一节）；缺省全用缺省键位
  keybindings?: Record<string, string | string[]> | undefined;
}

const identity = (text: string): string => text;

// 决策 441：布局里占满剩余高度的那一块（消息区、树形视图）
function fill(component: Component): StackChild {
  return { component, basis: 0, grow: 1, minSize: 1 };
}

// 要作答或要看全的块（会话选择器、设置面板、输入框）：窗口装不下时不跟着按比例压缩——VStack 缺省按高度加权压缩，
// 最高的一块被压得最多，选择器会只剩提示行、列表被裁掉；先压消息区、标题与状态行。审批框照常可压缩：它可能很高，
// 按 [r] 写理由时输入框必须留在屏幕上；两个列表的行数按当前窗口高度现取，不会自己撑出屏幕
function keep(component: Component): StackChild {
  return { component, shrink: 0 };
}

// 整屏的设置视图：窗口高度减去状态行（含上方空行）与状态栏
const CONFIG_CHROME_ROWS = 4;
// 决策 471：整屏的续接视图：再减去列表的标题行与滚动提示
const RESUME_CHROME_ROWS = 6;

// 界面所处的视图——当前会话、整屏的会话回退（决策 435）、会话面板（443）、进入的子 agent（482）、设置（442）与续接（471）
export type ShellView = "main" | "rewind" | "panel" | "agent" | "elsewhere" | "config" | "resume";

// 决策 469：一个会话的审批模式——取当前模式、切换（切换写一条会话记录，之后的工具调用按新模式判定）
export interface ApprovalModeControl {
  get(): "prompt" | "yolo";
  set(mode: "prompt" | "yolo"): void;
}

// 决策 443：会话面板（进程内版）：面板只经 source 取数与下指令；进入会话时直接订阅它的运行面（进程内版才有）
export interface TuiPoolFace {
  source: SessionPanelSource;
  // 决策 484：进入面板里的会话——它成为当前会话，原来的当前会话退到面板接着跑；不能进入时返回原因
  enter?(id: string): Promise<string | undefined>;
  // 决策 485：当前会话从主视图离开到面板（← ← 或 /panel），记进工作清单
  left?(): void;
  // 决策 489：当前会话的工作区（展示写法）；面板卡上与它相同的工作区不写
  currentWorkspace?(): string;
}

// 决策 484：当前会话换手时交出与接过的：还在跑的这一轮、排着的输入、待随下一条输入带上的上下文
export interface TuiHandOff {
  inflight?: Promise<unknown>;
  queued?: readonly string[];
  // 中断时退回来、还没放回输入框的排队内容（不自动发出，回到这个会话时放进输入框）
  held?: readonly string[];
  contexts?: readonly string[];
  // 停下这一轮（还在等 UserPromptSubmit 钩子时，钩子之后不再开跑）
  interrupt?: () => void;
}

// 决策 482：有子 agent 在跑时退出前的确认（需要当场决定）
export const EXIT_CONFIRM = "sub-agents are still running; exit anyway? (y/n)";
// 决策 492：/worktrees clean 列出清单之后状态行的问句
export const CLEAN_CONFIRM = "remove these worktrees? [y/N]";

// 决策 480：子 agent 状态有变后隔多久重算花费（期间的变化合并成一次）
const AGENT_COST_DELAY_MS = 500;
// 决策 443、483：会话面板里 Ctrl+X 第一下停下、这个间隔内再按一下从面板去掉
const PANEL_STOP_CONFIRM_MS = 2000;
// 设置面板里"被哪一层覆盖"的说法（与面板上那一项旁的标注同一口径）
const OVERRIDE_LAYER = { project: "project settings", local: "project local settings" } as const;

// 决策 457、482：子 agent 面板与进入子 agent 的会话（进程内的通讯录由 tui/main.ts 接上）
export interface TuiAgentsFace {
  // 某会话（连同各层）的全部子 agent
  list(sessionId: string): readonly SubagentRecord[];
  // 整个进程里还在跑的子 agent 个数（退出前确认用）
  running(): number;
  // 在等审批的子 agent（路径）
  waiting?(): ReadonlySet<string>;
  stop(record: SubagentRecord): Promise<void>;
  // 使用者在子 agent 里亲手打的字；不能发时返回原因
  send(record: SubagentRecord, text: string): string | undefined;
  // 进入它的会话时订阅的运行面（还没开或已释放为 undefined）
  live(
    record: SubagentRecord
  ):
    | (Pick<TuiRuntimeFace, "subscribe" | "subscribeStream"> &
        Partial<Pick<TuiRuntimeFace, "subscribeToolResults">>)
    | undefined;
  // 它的会话所在的会话根（渲染历史用）
  historyDir(record: SubagentRecord): string | undefined;
}

// 决策 433–438：终端界面的会话回退面（入口在 tui/main.ts，按当前运行面现取）
export interface TuiRewindFace {
  tree(): Promise<RewindNode[]>;
  prepare(to: string | null): Promise<PreparedRewind>;
  // 当前位置上可撤销的上一次退代码（没有为 undefined）
  prepareUndo(): Promise<PreparedRewind | undefined>;
  check(prepared: PreparedRewind): Promise<CodeCheck>;
  apply(
    prepared: PreparedRewind,
    options: { mode: RewindMode; code?: CodeCheck; revert?: ReadonlySet<string> }
  ): Promise<RewindOutcome>;
}

// 消息树动作菜单里各项的规划：退到选中那一条之前、整支切到正在看的版本、撤销上次退代码
interface RewindMenu {
  before?: { node: RewindNode; prepared: PreparedRewind };
  branch?: { node: RewindNode; prepared: PreparedRewind; mode: RewindMode };
  undo?: PreparedRewind;
}

// 选定之后要做的：退到这一条之前（退了对话的把它放回输入框）、整支切过去、撤销上次退代码
type RewindTarget =
  | { kind: "before"; node: RewindNode }
  | { kind: "switch"; node: RewindNode }
  | { kind: "undo" };

// 决策 467：审批区的高度上限 = 窗口高度减去输入框（含上下边框）、消息区至少几行、状态行与状态栏
const APPROVAL_CHROME_ROWS = 10;

// 决策 470：按 ← 打开面板的第一下在状态行的提示（ASCII：箭头字符在中文环境下宽度不定）
const PANEL_HINT = "press Left again to open the panel";

// 决策 435：双击 Esc 的间隔
const DOUBLE_ESCAPE_MS = 500;

// 沙箱会话的命令面：交回返回给人看的一行（分支名与查看命令，或失败原因）
export interface TuiSandboxFace {
  exportChanges(): Promise<string>;
}

export class PigeonTuiShell
  implements TuiApprovalFace, ModalHost, CommandsHost, ResumeViewHost<TuiSessionBinding>
{
  private readonly options: TuiShellOptions;
  private readonly tui: PigeonAltScreen;
  private readonly flow = new MessageFlow();
  // 决策 454：状态行是次要信息（弱化样式）。验收修改：不带上下空行，紧贴在输入框上沿；与上方内容之间隔一行空白
  //（statusGap，窗口装不下时先让出它），状态行本身不压缩
  private readonly statusLine = new Text("", 1, 0, secondary);
  private readonly statusGap = new Spacer(1);
  private view: ShellView = "main";
  // 决策 435：消息树（会话回退）与双击 Esc 的上一下
  private readonly messageTree: MessageTree;
  // 决策 443：会话面板与进入的会话
  private readonly sessionPanel: SessionPanel;
  // 决策 492：/worktrees clean 已列出清单，正在等 y/N
  private cleanConfirm = false;
  // 决策 490：输入框补全用的那一份（带 /take 的参数候选）；换会话时也用它重建
  private promptAutocomplete: PromptAutocomplete | undefined;
  // 决策 485：别的 Pigeon 开着的会话（只看历史）
  private elsewhereSession: { card: PooledSessionCard; flow: MessageFlow } | undefined;
  // 决策 482：输入框下方的子 agent 面板、进入的子 agent（回去时回到哪个视图）、退出前等确认、保留期满撤行的定时
  private readonly agentPanel: AgentPanel;
  private agentSession:
    | {
        record: SubagentRecord;
        flow: MessageFlow;
        unsubscribe: () => void;
        // 已接上实时订阅
        live: boolean;
      }
    | undefined;
  private exitConfirmOn = false;
  private exitConfirmed = false;
  private agentRetainTimer: ReturnType<typeof setTimeout> | undefined;
  // 决策 458：对当前会话的两次 Ctrl+X 须落在同一次工作上（work 为那次工作的开始时刻）
  private lastPanelStop: { id: string; at: number; work?: number | null | undefined } | undefined;

  // 决策 458：在面板里中断主会话时留着的排队内容（回到主视图时放进输入框）
  private heldQueue: string[] = [];
  // 偷看的内容（会话池的接口是异步的，取回来先存着再画）
  private readonly peekCache = new Map<string, string[]>();
  private lastIdleEscapeAt: number | undefined;
  // 决策 301、467：挂着的审批显示在底部的审批区（各视图都是；主视图里在输入框上方），不进消息流；高度上限按窗口取
  private readonly approvalBox = new ApprovalArea(() =>
    Math.max(4, this.options.terminal.rows - APPROVAL_CHROME_ROWS)
  );
  // 挂着的审批块的收起函数（答完收成一行）
  private approvalSettlers: Array<(line: string) => void> = [];
  private readonly input: Editor;
  private readonly queue = new InputQueue();
  private readonly picker = new SessionPicker();
  private readonly statusBar: StatusBar;
  // 本会话花费（286）：打开或续接时从会话记录累计的已有部分 + 本次运行中主 agent 的新增 + 之后收尾的子会话
  private costBase: CostTally = emptyCostTally();
  private costLive: CostTally = emptyCostTally();
  private childCosts: ChildSessionCosts | undefined;
  // 本轮开始的时刻（DeepSeek 计价看开始与结束是否落在高峰）
  private turnStartedAt: number | undefined;
  private readonly title: Text;
  // 当前会话上下文（S4）：/resume 换绑整体替换——运行面、治理上下文、sessionId 一体，
  // 绝不换一半（grants 命令与提交必须落在同一会话上）
  private current: {
    sessionId: SessionId;
    runtime: TuiRuntimeFace;
    root?: string;
    grants?: TuiGrantsContext;
    hooks?: TuiHooksFace;
  };
  // 决策 323、324：SessionStart 补的上下文（待下一条输入前缀）；换绑换会话时清掉
  private hookContexts: string[] = [];
  // 决策 446：要随人的下一条输入带给模型的说明（不叫醒 agent，例如没能移进工作树）
  private nextInputNotes: string[] = [];
  // 决策 323：本轮是否被外部取消（Esc / 打转叫停）——取消过的一轮不跑 Stop 钩子
  private runCancelled = false;
  // 决策 452：这次工作从何时开始（人发出消息、或程序通知叫醒 agent）与最近一次运行的结果；真正空闲时落收尾行后清掉。
  // stopCause：本次工作被打转检测等叫停的原因（收尾行写 stopped，不写 interrupted）
  private workStartedAt: number | null = null;
  // 决策 484：这一次工作的代号（换手时换新：交出去的那一轮落定时不再动壳）与在跑的这一轮（换手时交出去）
  private workGen = 0;
  private inflight: Promise<unknown> | undefined;
  // 这一轮已落定、正在收尾（Stop 钩子、移进工作树的重建）：不换手
  private closing = false;
  // 停下在跑的这一轮里还没开跑的部分（等 UserPromptSubmit 钩子时）
  private cancelWork: (() => void) | undefined;
  private lastRun: { result: RunResult | null; error?: unknown } | null = null;
  private stopCause: RunStopCause | undefined;
  // start/stop 的 dispose 对称面：壳级监听器在此成对登记（S5 的同位置留位）；
  // 运行面订阅单独登记——/resume 换绑时只退订运行面，壳级监听（模态键控）不动
  private readonly disposers: Array<() => void> = [];
  private runtimeDisposers: Array<() => void> = [];
  private runningState = false;
  private get running(): boolean {
    return this.runningState;
  }
  private set running(value: boolean) {
    if (value === this.runningState) return;
    this.runningState = value;
    this.setWaiting(value);
  }
  // 决策 439：等模型时的转圈（一轮开始到第一段输出之间；ASCII 帧）
  private loader: Loader | undefined;
  private setWaiting(on: boolean): void {
    if (on && this.loader === undefined && this.started) {
      this.loader = new Loader(this.tui, identity, identity, "", {
        frames: ["-", "\\", "|", "/"],
        intervalMs: 120,
      });
      this.layout();
    } else if (!on && this.loader !== undefined) {
      this.loader.stop();
      this.loader = undefined;
      this.layout();
    }
  }
  private activeRunId: RunId | null = null;
  private started = false;
  // S4：/resume 进行中——输入排队、改状态的命令被拒（决策 286，同运行中）
  private resuming = false;
  // 决策 433：回退进行中（规划、拍快照、写回、换上下文）：与运行同样占住输入与排队
  private rewinding = false;
  private rewindPrepared: PreparedRewind | undefined;
  private rewindCode: CodeCheck | undefined;
  private pendingRewindMode: RewindMode = "conversation";
  // 动作菜单开着时各项的规划；选定之后要做的那一项
  private rewindMenu: RewindMenu | undefined;
  private rewindTarget: RewindTarget | undefined;
  // S3 审批面板：挂起中的审批决议（resolve 四键或 cancel）；串行不变量（决策 002）下
  // 同时最多一个，非空即面板期间
  private pendingApprovalState: PendingApproval | null = null;
  // 决策 066：理由行输入模式——[r] 打开后按键归输入区，回车提交理由，Esc 回面板（不算拒绝）
  private reasonModeOn = false;
  // S5 取消键：中断飞行中标记——interrupt 未决议期间重复 Esc 不再触发
  //（不 double-abort、不悬挂）；running 清算在 handleRunEnd，两者生命周期独立
  private interrupting = false;
  // 接管了 Esc 的一方（见 captureEscape）
  private escapeCapture: (() => void) | undefined;
  // S5 D2 可见化（同 repl 增量报数口径）：已警告过的落盘失败累计数
  private reportedListenerErrors = 0;
  // S5+ 退出布防（裁决 033）：上一次 Ctrl+C 的墙钟时刻（窗口内再来一次即优雅退出）；
  // exitRequested 保证退出恰好一次（stop 后输入监听已退订，重入仅作幂等防御）
  private lastCtrlCAtValue: number | null = null;
  // 决策 470：← 打开面板的第一下（时刻）与状态行提示的到期计时
  private panelLeftAt: number | undefined;
  private panelHintTimer: ReturnType<typeof setTimeout> | undefined;
  // 退出布防的状态行提示（EXIT_HINT）开着与它的到期计时
  private exitHintOn = false;
  private exitHintTimer: ReturnType<typeof setTimeout> | undefined;
  private exitRequested = false;
  // 决策 294 B1：/tasks 的取数（装配方给了才有这条命令）
  tasks?: () => string | undefined;

  constructor(options: TuiShellOptions) {
    this.options = options;
    this.current = { sessionId: options.sessionId, runtime: options.runtime };
    if (options.grants !== undefined) this.current.grants = options.grants;
    if (options.hooks !== undefined) this.current.hooks = options.hooks;
    if (options.tasks !== undefined) this.tasks = options.tasks;
    // 决策 444：PI_DEBUG_REDRAW=1 时 pi-tui 第一帧就写调试日志进程序状态目录——先确保目录与全局忽略规则
    if (options.logDir !== undefined && process.env.PI_DEBUG_REDRAW === "1") {
      ensureStateDirOf(options.logDir);
    }
    // 决策 439：键位表（pi-tui 部件与 Pigeon 自己的动作共用）；设置里有问题的条目在消息区提示
    const keyNotices = installKeybindings(options.keybindings);
    // 决策 441：全屏（备用屏）——程序自管滚动、鼠标滚轮、拖选复制与搜索；Windows 上右键粘贴剪贴板
    this.tui = new PigeonAltScreen(options.terminal, false, options.logDir, {
      ...(process.platform === "win32" && options.readClipboard !== undefined
        ? { onRightClickPaste: () => void this.pasteClipboard() }
        : {}),
      // 决策 439：点链接用系统缺省方式打开（只开 http、https、file；点了才开）
      openUrl: (url) => {
        (this.options.openUrl ?? openExternalUrl)(url);
      },
    });
    // 决策 490：`/take ` 的参数候选由输入框的补全列表给（pi-tui 的 getArgumentCompletions），
    // 不再另开一个整屏列表
    this.promptAutocomplete =
      options.autocomplete === undefined
        ? undefined
        : {
            ...options.autocomplete,
            arguments: (command: string, prefix: string) =>
              command === "take" ? this.takeArgumentItems(prefix) : null,
          };
    this.input = createPromptEditor(
      this.tui,
      options.promptHistory?.load() ?? [],
      this.promptAutocomplete
    );
    this.statusBar = new StatusBar({ cost: emptyCostTally() });
    // chrome 除会话名外纯 ASCII（spike 纪律：歧义宽字符不进边框/标题/状态栏）；sessionId 全 ASCII ULID。决策 456：会话名
    // 按名字规则只含字母、数字与 _ . -（不含控制字符、零宽与可忽略字符），其他文字的宽度按 pi-tui 的算法
    // 只在特殊视图里有一行，不带上下空行
    this.title = new Text("", 1, 0);
    this.title.setText(this.titleText());
    this.sessionPanel = new SessionPanel({
      // 标题、审批框、输入框（上下边框）与状态栏
      height: () => Math.max(3, this.options.terminal.rows - 6),
      cards: () => this.options.pool?.source.list() ?? [],
      peek: (id) =>
        id === this.current.sessionId ? this.mainPeekLines() : (this.peekCache.get(id) ?? []),
      // 决策 458：当前窗口的主会话作为第一张卡
      main: () => this.mainCard(),
      currentWorkspace: () => this.options.pool?.currentWorkspace?.(),
      currentId: (id) => this.options.pool?.source.currentId?.(id) ?? id,
    });
    this.messageTree = new MessageTree({
      height: () => Math.max(3, this.options.terminal.rows - 2),
    });
    // 决策 482：输入框下方的子 agent 面板（列当前会话的）
    this.agentPanel = new AgentPanel({
      agents: () => this.options.agents?.list(this.agentTopSessionId()) ?? [],
      sessionName: () => this.agentTopName(),
      waiting: () => this.options.agents?.waiting?.() ?? new Set<string>(),
      now: () => Date.now(),
    });
    // 决策 451：欢迎头放在对话流最上方
    if (options.welcome !== undefined) this.flow.setHeader(new WelcomeHeader(options.welcome));
    this.layout();
    for (const line of keyNotices) this.flow.addSystem(line);
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.updateStatus();
  }

  // 按视图排布组件：排队内容与会话选择器在输入框上方，状态栏在输入框下方（决策 286）；会话回退整屏（消息列表、状态栏）
  private layout(): void {
    // 状态行紧贴在输入框上沿（没有输入框的视图里在状态栏之上），上方隔一行空白
    const status: StackChild[] = [this.statusGap, keep(this.statusLine)];
    // 决策 482：子 agent 面板在输入框下方（没有可列的行即不占地方）
    const agents: StackChild[] = this.options.agents !== undefined ? [keep(this.agentPanel)] : [];
    const children: StackChild[] =
      this.view === "rewind"
        ? [fill(this.messageTree), keep(this.approvalBox), this.statusBar]
        : this.view === "config"
          ? [fill(this.configPanel.view), keep(this.approvalBox), ...status, this.statusBar]
          : this.view === "resume"
            ? [fill(this.picker.view), keep(this.approvalBox), ...status, this.statusBar]
            : this.view === "panel"
              ? [
                  fill(this.sessionPanel),
                  keep(this.approvalBox),
                  ...status,
                  keep(this.input),
                  this.statusBar,
                ]
              : this.view === "agent" && this.agentSession !== undefined
                ? [
                    this.title,
                    fill(this.agentSession.flow.view),
                    keep(this.approvalBox),
                    ...status,
                    keep(this.input),
                    this.statusBar,
                  ]
                : this.view === "elsewhere" && this.elsewhereSession !== undefined
                  ? [
                      this.title,
                      fill(this.elsewhereSession.flow.view),
                      keep(this.approvalBox),
                      ...status,
                      keep(this.input),
                      this.statusBar,
                    ]
                  : [
                      fill(this.flow.view),
                      ...(this.loader !== undefined ? [this.loader] : []),
                      this.queue.view,
                      keep(this.approvalBox),
                      ...status,
                      keep(this.input),
                      ...agents,
                      this.statusBar,
                    ];
    // 决策 441：每个视图一个 VStack 作布局根——中间的滚动区占满剩余高度，其余各条按自身高度排在上下
    this.tui.setLayoutRoot(new VStack(children));
  }

  // 决策 441：Windows 上右键粘贴——取剪贴板文字，按粘贴（bracketed paste）交给输入框
  private async pasteClipboard(): Promise<void> {
    const read = this.options.readClipboard;
    if (read === undefined) return;
    let text: string;
    try {
      text = await read();
    } catch {
      return;
    }
    // 审批或消息面板挂着时不接受粘贴（吞键的约定不能被右键粘贴绕过）
    if (text === "" || !this.started || this.pendingApprovalState !== null) return;
    this.input.handleInput(`\x1b[200~${text}\x1b[201~`);
    this.tui.requestRender();
  }

  // 按键让给别人：全屏的搜索框开着（浮层），或输入框的补全列表开着（Esc、方向键、回车归它）；审批面板挂着时不让
  private keysToOthers(_data: string): boolean {
    // 决策 482：退出前的确认等着答时不让
    if (this.exitConfirmOn) return false;
    // 查找框开着时一律让给它——审批或消息面板挂着也让（键入查找框的字母不能被面板拿去作答）
    if (this.tui.hasOverlay()) return true;
    if (this.pendingApprovalState !== null) return false;
    return this.input.isShowingAutocomplete();
  }

  // 决策 439：/reload 之后按新快照重装键位表
  applyKeybindings(section: Record<string, string | string[]> | undefined): void {
    for (const line of installKeybindings(section)) this.flow.addSystem(line);
  }

  // 决策 441：Ctrl+C 在有拖选的选区时复制选区（不计退出布防）
  copySelection(): boolean {
    if (!this.tui.hasActiveSelection()) return false;
    const copied = this.tui.copyActiveSelectionToClipboard();
    // 复制之后清掉选区：下一次 Ctrl+C 照常清输入、两下退出
    void copied.finally(() => this.tui.clearSelection());
    return true;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // 决策 443：会话面板的会话有变化即重画（面板与进入的会话的状态行）
    const unsubscribePool = this.options.pool?.source.subscribe(() => {
      this.updateStatus();
      this.tui.requestRender();
    });
    if (unsubscribePool !== undefined) this.disposers.push(unsubscribePool);
    // 退出布防之后的别的输入撤销布防（最先看到每个按键，只看不吞）
    this.disposers.push(
      this.tui.addInputListener((data) => {
        if (!isKeyRelease(data)) disarmExitOnInput(this, data);
        return undefined;
      })
    );
    // 视图的按键（会话回退、会话面板与进入的子 agent 的 Esc）排在最前；审批挂起期间与 Ctrl+C 一律放给壳级键控
    // 决策 441：全屏的搜索框开着时（它是浮层）按键一律让给它，Ctrl+C 除外
    this.disposers.push(
      this.tui.addInputListener((data) =>
        isKeyRelease(data) || this.keysToOthers(data) ? undefined : this.handleScreenKey(data)
      )
    );
    // 壳级键控（S3 审批面板 + S4 恢复菜单 + S5 取消键）：模态挂起期间接管终端输入
    this.disposers.push(
      this.tui.addInputListener((data) =>
        isKeyRelease(data) || (this.keysToOthers(data) && !isKey(data, "pigeon.exit"))
          ? undefined
          : handleShellKey(this, data)
      )
    );
    // 决策 286：会话选择器、Ctrl+O 与退回排队内容的按键（模态与取消键之后、输入框之前）
    this.disposers.push(
      this.tui.addInputListener((data) =>
        isKeyRelease(data) || this.keysToOthers(data) ? undefined : this.handleViewKey(data)
      )
    );
    this.bindRuntime(this.current.runtime);
    this.resetCosts(this.current.sessionId, false);
    // D2 可见化（S5，同 repl 口径）：启动即查一次落盘失败
    this.warnEvidenceGaps();
    this.tui.setFocus(this.input);
    this.tui.start();
    this.tui.requestRender();
  }

  // 运行面订阅：换绑先退订旧面再订阅新面——旧面的迟到事件/增量换绑后不进消息区
  private bindRuntime(runtime: TuiRuntimeFace): void {
    for (const dispose of this.runtimeDisposers.splice(0)) dispose();
    this.runtimeDisposers.push(
      runtime.subscribe((event) => this.handleEvent(event)),
      runtime.subscribeStream((delta) => this.handleDelta(delta))
    );
    // 决策 189：每次压缩（自动或手动）在消息区提示一行压缩前后的 token 数
    const unsubscribeCompaction = runtime.subscribeCompaction?.((notice) => {
      // 自动压缩压成了不说（状态栏的上下文用量随之下降）；手动 /compact 的结果照写，没压成的照报
      if (notice.kind !== "compacted")
        this.flow.addAlert(`[compact] ${compactionNoticeText(notice)}`);
      else if (notice.trigger === "manual") {
        this.flow.addSystem(`[compact] ${compactionNoticeText(notice)}`);
      }
      // 压缩后上下文用量随之下降
      this.refreshContext();
      this.collectChildCosts();
      this.tui.requestRender();
    });
    if (unsubscribeCompaction !== undefined) {
      this.runtimeDisposers.push(unsubscribeCompaction);
    }
    const unsubscribeToolResults = runtime.subscribeToolResults?.((notice) =>
      this.handleToolResult(notice)
    );
    if (unsubscribeToolResults !== undefined) {
      this.runtimeDisposers.push(unsubscribeToolResults);
    }
    this.refreshContext();
  }

  stop(): void {
    // fail-closed（决策 029）：壳停止时挂起的审批按拒绝处理、恢复菜单按 EOF 语义回 null
    closePendingModals(this);
    if (this.exitHintTimer !== undefined) {
      clearTimeout(this.exitHintTimer);
      this.exitHintTimer = undefined;
    }
    if (this.agentCostTimer !== undefined) {
      clearTimeout(this.agentCostTimer);
      this.agentCostTimer = undefined;
    }
    if (this.agentRetainTimer !== undefined) {
      clearTimeout(this.agentRetainTimer);
      this.agentRetainTimer = undefined;
    }
    this.leaveAgentSession();
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const dispose of this.runtimeDisposers.splice(0)) dispose();
    this.loader?.stop();
    this.loader = undefined;
    if (this.started) {
      this.started = false;
      // 决策 441：离开全屏时把对话（标题与主会话的消息区）完整打印到普通屏幕
      this.tui.setLayoutRoot(new TrimmedTranscript(new VStack([this.flow.view])));
      this.tui.stop();
    }
  }

  updateStatus(): void {
    this.statusBar.update({ mode: this.modeControl()?.get() });
    // 决策 482：有子 agent 在跑时退出先问一句
    if (this.exitConfirmOn) {
      this.statusLine.setText(EXIT_CONFIRM);
      return;
    }
    // 单击 Ctrl+C 布防期间状态行只写退出提示
    if (this.exitHintOn) {
      this.statusLine.setText(EXIT_HINT);
      return;
    }
    // 决策 492：清理的 y/N 还在等——状态刷新不盖掉问句（审批挂着时先说审批，答完再回到问句）
    if (this.cleanConfirm && this.pendingApprovalState === null) {
      this.statusLine.setText(CLEAN_CONFIRM);
      return;
    }
    if (this.panelLeftAt !== undefined) {
      this.statusLine.setText(PANEL_HINT);
      return;
    }
    // 决策 443：面板上的状态行（审批挂着时照常说明审批）
    if (this.view === "panel" && this.pendingApprovalState === null) {
      // 决策 458：当前会话也算一个
      const cards = [this.mainCard(), ...(this.options.pool?.source.list() ?? [])];
      const waiting = cards.filter((card) => card.state === "waiting").length;
      this.statusLine.setText(
        `panel: ${plural(cards.length, "session")}${waiting > 0 ? `, ${waiting} waiting` : ""}`
      );
      return;
    }
    // 决策 482：进入的子 agent 里状态行写它的名字与状态
    if (
      this.view === "agent" &&
      this.agentSession !== undefined &&
      this.pendingApprovalState === null
    ) {
      const record = this.agentSession.record;
      this.statusLine.setText(`sub-agent: ${record.agentName} ${agentStateWord(record.state)}`);
      return;
    }
    // 状态行纯 ASCII，只写状态词（空闲与审批挂着时不写：审批框就在眼前）；审批期间输入归模态键控，运行中与 resume 期间
    // 输入排队（决策 286）
    const base =
      this.pendingApprovalState !== null
        ? this.reasonModeOn
          ? "reason for rejecting (enter to send, esc to go back)"
          : ""
        : this.resuming
          ? "resuming"
          : this.interrupting
            ? "cancelling"
            : this.running
              ? "running"
              : "";
    this.statusLine.setText(base);
  }

  private handleSubmit(value: string): void {
    // 空输入（纯空白）：静默忽略——不回显、不提交、不提示（理由行同口径：留在理由行继续编辑）
    if (value.trim() === "") return;
    // 理由行提交（决策 066）：本次回车是拒绝理由而非任务提交——理由逐字回模型，审批就此决议
    if (this.reasonModeOn) {
      const reason = value.trim();
      this.reasonModeOn = false;
      const approval = this.pendingApprovalState;
      this.pendingApprovalState = null;
      this.updateStatus();
      this.tui.requestRender();
      approval?.resolve({ key: "r", reason });
      return;
    }
    // 历史（286）：发出的与排队的都进历史；拒绝理由不进
    this.input.addToHistory(value);
    this.options.promptHistory?.add(value);
    // 决策 482：进入的子 agent 里的输入是使用者亲手打给它的话。决策 484：管整个程序的斜杠命令照样能用（回到主视图执行），
    // 作用于会话的不收
    if (this.view === "agent" && this.agentSession !== undefined && isGlobalCommand(value)) {
      this.backFromAgentSession();
    } else if (this.view === "agent" && this.agentSession !== undefined) {
      const session = this.agentSession;
      if (value.startsWith("/")) {
        session.flow.addSystem("not available in a sub-agent's session");
        this.input.setText(value);
      } else {
        const refusal = this.options.agents?.send(session.record, value);
        if (refusal !== undefined) {
          session.flow.addSystem(refusal);
          this.input.setText(value);
        } else {
          session.flow.addUserEcho(value);
        }
      }
      this.tui.requestRender();
      return;
    }
    // 决策 485：别的 Pigeon 开着的会话里发不了话；斜杠命令回到主视图执行
    if (
      this.view === "elsewhere" &&
      this.elsewhereSession !== undefined &&
      !value.startsWith("/")
    ) {
      this.elsewhereSession.flow.addSystem(
        `session ${this.elsewhereSession.card.name} is open elsewhere`
      );
      this.input.setText(value);
      this.tui.requestRender();
      return;
    }
    if (this.view === "elsewhere") this.showView("main");
    // 决策 443：会话面板里的输入归会话面板（与当前会话是否在跑无关）。决策 484：斜杠命令作用于当前会话（回到主视图执行）
    if (this.view === "panel" && value.startsWith("/")) {
      this.sessionPanel.closePeek();
      this.showView("main");
    } else if (this.view === "panel") {
      this.handlePoolSubmit(value);
      this.tui.requestRender();
      return;
    }
    if (this.isBusy()) {
      if (value.startsWith("/")) {
        // 运行中的斜杠命令不排队：放行的照常执行，改主会话状态或工作目录的拒绝并说明原因、输入留在输入框
        const rejection = rejectWhileRunning(value);
        if (rejection !== undefined) {
          this.input.setText(value);
          this.flow.addSystem(rejection);
        } else {
          this.flow.addUserEcho(value);
          dispatchSlashCommand(this, value);
        }
        this.tui.requestRender();
        return;
      }
      // 决策 286：运行中输入进队列，空闲后逐条发出
      this.queue.enqueue(value);
      this.tui.requestRender();
      return;
    }
    this.submitNow(value);
  }

  // 运行中（含压缩）或 /resume 进行中：输入排队、改状态的命令被拒
  private isBusy(): boolean {
    return this.running || this.resuming || this.rewinding;
  }

  // 立即提交一条输入（空闲时的回车，或空闲后从队列取出的一条）
  private submitNow(value: string): void {
    // 决策 452：人的下一条输入或命令出现之前，先落上一次工作的收尾行（排队的输入在收尾时依次发出）
    this.renderWorkEnd();
    // S3 斜杠命令：grant 治理面投影（/grants /revoke /grants save）——命令层与
    // 命令层在 application/grants.ts（决策 030），write 回调落消息区
    if (value.startsWith("/")) {
      this.flow.addUserEcho(value);
      dispatchSlashCommand(this, value);
      this.tui.requestRender();
      return;
    }
    this.flow.addUserEcho(value);
    this.running = true;
    this.runCancelled = false;
    this.beginWork();
    this.updateStatus();
    this.tui.requestRender();
    // 决策 323、324：UserPromptSubmit 挡在每条输入前——可拦下、可补上下文；随后才是唯一提交通道
    //（application API：当前会话运行面——/resume 换绑后是新面）。终态摘要在 run() 决议后落
    void this.runWithHooks(value);
  }

  // 决策 323、324：UserPromptSubmit——拦下则这一条不跑（理由落消息区），补的上下文与 SessionStart
  // 待用上下文一起前缀给本次输入。钩子出错如实提示，不挡提交
  //（决策 484：钩子与这一轮合起来算在跑的这一轮，换手时整段交出去；拦下时结果为 undefined）
  //（决策 484：开跑时就取定这个会话的运行面、钩子与待用上下文；等钩子期间换过手的，不再动壳上的东西）
  private runWithHooks(value: string): void {
    const runtime = this.current.runtime;
    const hooks = this.current.hooks;
    const gen = this.workGen;
    const contexts = this.hookContexts.splice(0);
    const notes = this.nextInputNotes.splice(0);
    const cancel = { cancelled: false };
    this.cancelWork = () => {
      cancel.cancelled = true;
    };
    const own = () => gen === this.workGen;
    const work = (async (): Promise<RunResult | undefined> => {
      let input = value;
      if (hooks !== undefined && !hooks.disabled) {
        try {
          const report = await hooks.runEvent("UserPromptSubmit", "", { prompt: value });
          if (own()) for (const line of report.systemMessages) this.flow.addSystem(line);
          const blocked =
            report.blocked?.reason ??
            (report.continueFalse !== undefined
              ? (report.continueFalse.stopReason ?? "hook stopped the session")
              : undefined);
          if (blocked !== undefined) {
            // 拦下：待用的上下文留给下一条
            if (own()) {
              this.hookContexts.unshift(...contexts);
              this.nextInputNotes.unshift(...notes);
            }
            return undefined;
          }
          contexts.push(...report.additionalContext);
        } catch (error) {
          if (own()) {
            this.flow.addAlert(
              `UserPromptSubmit hook failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
      // 等钩子期间被停下：这一轮不开跑
      if (cancel.cancelled) return undefined;
      if (contexts.length > 0) input = `${contexts.join("\n\n")}\n\n${value}`;
      if (notes.length > 0) input = `${notes.join("\n\n")}\n\n${input}`;
      return runtime.run(input);
    })();
    this.followWork(work);
  }

  // 决策 484：跟着在跑的这一轮，落定时收尾；换过手（代号变了）的不再动壳
  private followWork(work: Promise<RunResult | undefined>): void {
    const gen = this.workGen;
    this.inflight = work;
    work.then(
      (result) => {
        if (gen !== this.workGen) return;
        if (result === undefined) {
          this.closing = true;
          this.finishRun();
        } else this.handleRunEnd(result);
      },
      (error: unknown) => {
        if (gen === this.workGen) this.handleRunEnd(null, error);
      }
    );
  }

  // 决策 484：能不能换手（进入面板里的会话、/resume）：续接、回退、重读设置、压缩进行中，以及这一轮正在收尾（Stop 钩子、
  // 移进工作树的重建）时不换
  handOffBlocked(): string | undefined {
    if (this.resuming) return "can't switch sessions right now";
    return this.switchBlocked();
  }

  // 同上，但不看"正在换手"本身：/resume、/clear、/new 的装配方在等待之后据此再看一次（期间这一轮可能进了收尾）
  switchBlocked(): string | undefined {
    if (this.rewinding || this.closing || (this.running && this.inflight === undefined)) {
      return "can't switch sessions right now";
    }
    return undefined;
  }

  // 决策 484：当前会话换手（进入面板里的会话、/resume 换走还在干活的）：交出在跑的这一轮、排着的输入与还没带给模型的上下文，
  // 壳回到空闲（交出去的那一轮落定时不再动壳）
  handOff(): TuiHandOff {
    const inflight = this.running ? this.inflight : undefined;
    const interrupt = inflight !== undefined ? this.cancelWork : undefined;
    this.workGen += 1;
    this.inflight = undefined;
    this.cancelWork = undefined;
    this.closing = false;
    const queued = this.queue.clear();
    const held = this.heldQueue.splice(0);
    const contexts = [...this.hookContexts.splice(0), ...this.nextInputNotes.splice(0)];
    this.running = false;
    this.interrupting = false;
    this.runCancelled = false;
    this.activeRunId = null;
    this.workStartedAt = null;
    this.lastRun = null;
    this.stopCause = undefined;
    return {
      ...(inflight !== undefined ? { inflight } : {}),
      ...(interrupt !== undefined ? { interrupt } : {}),
      ...(queued.length > 0 ? { queued } : {}),
      ...(held.length > 0 ? { held } : {}),
      ...(contexts.length > 0 ? { contexts } : {}),
    };
  }

  // 决策 484：换到另一个开着的会话（进入面板里的会话）：消息区换成它的对话（历史取自它的会话记录），接过它在跑的这一轮、
  // 排着的输入与还没带给模型的上下文；会话一直开着，不跑 SessionStart
  switchSession(sessionId: SessionId, binding: TuiSessionBinding, handOff: TuiHandOff = {}): void {
    this.flow.clear();
    this.current = {
      sessionId,
      runtime: binding.runtime,
      ...(binding.root !== undefined ? { root: binding.root } : {}),
      ...(binding.grants !== undefined ? { grants: binding.grants } : {}),
      ...(binding.hooks !== undefined ? { hooks: binding.hooks } : {}),
    };
    this.hookContexts = [...(handOff.contexts ?? [])];
    this.heldQueue = [...(handOff.held ?? [])];
    this.followWorkspace(binding);
    this.reportedListenerErrors = 0;
    this.bindRuntime(binding.runtime);
    this.resetCosts(sessionId, true);
    this.renderHistoryInto(this.flow, sessionId);
    for (const text of handOff.queued ?? []) this.queue.enqueue(text);
    this.showView("main");
    const inflight = handOff.inflight;
    if (inflight !== undefined) {
      this.activeRunId = binding.runtime.currentRunId?.() ?? null;
      this.running = true;
      this.runCancelled = false;
      this.beginWork();
      this.followWork(inflight as Promise<RunResult | undefined>);
      this.cancelWork = handOff.interrupt;
    } else {
      this.activeRunId = null;
      this.drainQueue();
    }
    this.updateStatus();
    this.tui.requestRender();
  }

  // 决策 446：一段说明随人的下一条输入前缀给模型（不开新的一轮）
  addNextInputNote(text: string): void {
    this.nextInputNotes.push(text);
  }

  // 空闲后发出排队的输入（pi 惯例逐条：一条跑完再发下一条）；即时完成的命令不占住，接着发下一条。
  // 决策 297、480：待递的通知也从这里发出——有排队的输入时先发输入，这一轮由运行面在开头带上已到的通知（通知在前、输入在后）；
  // 没有排队的输入时，已到的通知单独跑一轮（只带通知）
  private drainQueue(): void {
    while (
      !this.isBusy() &&
      this.started &&
      !this.picker.isOpen() &&
      !this.configPanel.isOpen() &&
      !this.messageTreeOpen() &&
      this.queue.size() > 0
    ) {
      const next = this.queue.take();
      if (next === undefined) break;
      this.submitNow(next);
    }
    const runtime = this.current.runtime;
    if (
      !this.isBusy() &&
      this.started &&
      !this.picker.isOpen() &&
      !this.configPanel.isOpen() &&
      !this.messageTreeOpen() &&
      runtime.runNotices !== undefined &&
      (runtime.pendingNotices?.() ?? 0) > 0
    ) {
      this.running = true;
      this.runCancelled = false;
      // 决策 452：刚收尾就有通知叫醒（换工作树后自动续一轮、子 agent 的结果等）算同一次工作接着跑
      this.beginWork(true);
      this.updateStatus();
      this.followWork(runtime.runNotices());
    }
    this.tui.requestRender();
  }

  // 决策 480：子 agent 的状态有变（派出、干完、停下）：重画；花费要读子 agent 的会话文件，合并成半秒一次
  private agentCostTimer: ReturnType<typeof setTimeout> | undefined;
  agentsChanged(): void {
    this.scheduleAgentRetain();
    this.attachAgentLive();
    if (this.agentCostTimer === undefined) {
      this.agentCostTimer = setTimeout(() => {
        this.agentCostTimer = undefined;
        this.collectChildCosts();
        this.tui.requestRender();
      }, AGENT_COST_DELAY_MS);
      this.agentCostTimer.unref?.();
    }
    this.tui.requestRender();
  }

  // 决策 482：面板上有保留期内的已结束行时，每秒重画一次，到期即撤下
  private scheduleAgentRetain(): void {
    if (this.agentRetainTimer !== undefined || !this.agentPanel.hasRetained()) return;
    this.agentRetainTimer = setTimeout(() => {
      this.agentRetainTimer = undefined;
      this.tui.requestRender();
      this.scheduleAgentRetain();
    }, 1000);
    this.agentRetainTimer.unref?.();
  }

  // 子 agent 面板列的是当前会话的
  private agentTopSessionId(): string {
    return this.current.sessionId;
  }

  private agentTopName(): string {
    return this.currentSessionName() ?? "session";
  }

  // 决策 482：子 agent 面板的按键（输入框为空时 ↓ 进来）：↑↓ 选，→ 进下层，← 回上层（最上层即回输入框），Enter 进入它的
  // 会话，x 停下在跑的、清掉已结束的，Esc 回输入框；别的键回输入框照常打字
  private handleAgentPanelKey(data: string): { consume: true } | undefined {
    const panel = this.agentPanel;
    const face = this.options.agents;
    // 列着的行都撤下了：回输入框，这个键照常交给输入框
    if (!panel.hasRows()) {
      panel.blur();
      return undefined;
    }
    if (matchesKey(data, "escape")) {
      panel.blur();
    } else if (matchesKey(data, "up")) {
      panel.up();
    } else if (matchesKey(data, "down")) {
      panel.down();
    } else if (matchesKey(data, "right")) {
      panel.drillIn();
    } else if (matchesKey(data, "left")) {
      panel.drillOut();
    } else if (matchesKey(data, "enter")) {
      const record = panel.selected();
      panel.blur();
      if (record !== undefined) this.openAgentSession(record);
    } else if (data === "x" || data === "X") {
      const record = panel.selected();
      if (record !== undefined && face !== undefined) {
        if (agentActive(record)) void face.stop(record);
        else panel.clear(record);
      }
    } else {
      panel.blur();
      this.tui.requestRender();
      return undefined;
    }
    this.tui.requestRender();
    return { consume: true };
  }

  // 决策 482：进入子 agent 的会话：消息区换成它的对话（历史取自它的会话记录，之后实时），输入是使用者亲手打给它的话
  private openAgentSession(record: SubagentRecord): void {
    const face = this.options.agents;
    if (face === undefined) return;
    const flow = new MessageFlow();
    flow.setToolsExpanded(this.flow.toolsExpandedState());
    const dir = face.historyDir(record);
    const root = this.sessionsRoot();
    if (record.sessionId !== undefined && dir !== undefined && root !== undefined) {
      try {
        const limit = this.options.historyLimit;
        flow.addHistory(
          loadSessionHistory(root, record.sessionId, {
            sessionsDir: dir,
            ...(limit !== undefined ? { limit } : {}),
          })
        );
        flow.addSystem("--- live ---");
      } catch (error) {
        flow.addAlert(
          `rendering history failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    this.agentSession = {
      record,
      flow,
      unsubscribe: () => {},
      live: false,
    };
    this.attachAgentLive();
    this.showView("agent");
  }

  // 进入时还没有运行面的子 agent（续接认回的、还在开的）：开好之后接上实时
  private attachAgentLive(): void {
    const session = this.agentSession;
    if (session === undefined || session.live) return;
    const live = this.options.agents?.live(session.record);
    if (live === undefined) return;
    const flow = session.flow;
    const disposers = [
      live.subscribe((event) => {
        projectRuntimeEvent(flow, event, { turnErrors: true });
        this.updateStatus();
        this.tui.requestRender();
      }),
      live.subscribeStream((delta) => {
        if (delta.kind === "thinking") flow.appendThinkingDelta(delta.delta);
        else flow.appendDelta(delta.delta);
        this.tui.requestRender();
      }),
    ];
    const offResults = live.subscribeToolResults?.((notice) => {
      attachToolResultTo(flow, notice);
      this.tui.requestRender();
    });
    if (offResults !== undefined) disposers.push(offResults);
    const previous = session.unsubscribe;
    session.unsubscribe = () => {
      previous();
      for (const dispose of disposers) dispose();
    };
    session.live = true;
  }

  private leaveAgentSession(): void {
    this.agentSession?.unsubscribe();
    this.agentSession = undefined;
  }

  // 从子 agent 的会话回到主视图
  private backFromAgentSession(): void {
    this.leaveAgentSession();
    this.showView("main");
  }

  // 决策 297、480：通知（子 agent 的结果与消息等）到来时叫醒 agent——与排队输入同一个出口；在跑时不动，通知留在运行面上，下一轮或这一轮结束后再递
  runNotices(): void {
    this.drainQueue();
  }

  // 决策 331：/memory 的命令面（CommandsHost）
  memory(): TuiMemoryFace | undefined {
    return this.options.memory;
  }

  // 决策 448：/worktrees 的命令面（CommandsHost）
  worktrees(): TuiWorktreesFace | undefined {
    return this.options.worktrees;
  }

  // 决策 442：/config（CommandsHost）——不带参数打开面板，"选项=值" 直接改
  private readonly configPanel = new ConfigPanel();
  get configCommand(): ((args: string) => void) | undefined {
    const face = this.options.config;
    if (face === undefined) return undefined;
    return (args) => {
      if (args === "") {
        const items = this.configItems();
        if (items === undefined) return;
        // 整屏的设置视图；Esc 回主视图（斜杠命令只在主视图里用），把视图开着期间排下的输入与通知发出去
        this.configPanel.open(
          items,
          (id, value) => this.applyConfig(id, value),
          () => {
            this.showView("main");
            this.drainQueue();
          },
          () => Math.max(1, this.options.terminal.rows - CONFIG_CHROME_ROWS),
          face.keys !== undefined ? () => face.keys?.() ?? [] : undefined
        );
        this.showView("config");
        return;
      }
      const assignment = parseConfigAssignment(args);
      if (assignment === undefined) {
        this.flow.addSystem("usage: /config [key=value]");
        this.tui.requestRender();
        return;
      }
      this.applyConfig(assignment.id, assignment.value);
    };
  }

  // 读面板各项；三层设置有一层坏了（不是合法 JSON 等）即如实说明、不抛
  private configItems(): ConfigItemView[] | undefined {
    try {
      return this.options.config?.view();
    } catch (error) {
      this.flow.addAlert(
        `reading settings failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.tui.requestRender();
      return undefined;
    }
  }

  // 改设置之后刷新设置视图（读不了即关视图回主视图，说明已写在消息区）
  private refreshConfigPanel(id: string): void {
    if (!this.configPanel.isOpen()) return;
    const items = this.configItems();
    if (items === undefined) {
      this.showView("main");
      return;
    }
    this.configPanel.refresh(items, id);
  }

  // 写进用户级设置，再按 /reload 的重建当场生效（重建期间与 Run 同样占住输入）；面板开着时随后刷新。
  // 主运行中、上一次重建还没完、或有子 agent 在跑时不改（改了也重建不了），说明原因
  private applyConfig(id: string, value: string): void {
    const face = this.options.config;
    if (face === undefined) return;
    // 验收修改：在面板里改的，所有说明只写在面板的提示行（弱化样式），不往消息区写——面板上那一项的取值与生效值当场
    // 更新就是反馈；/config 选项=值 直接改（没开面板）的照旧写消息区
    const inPanel = this.configPanel.isOpen();
    // 这里说的都是改不成的原因（报错）
    const say = (line: string): void => {
      if (inPanel) this.configPanel.setNote(line, true);
      else this.flow.addAlert(line);
    };
    // 面板里上一次留下的报错：这次先清掉
    if (inPanel) this.configPanel.setNote("");
    if (this.isBusy()) {
      say("running; change settings later");
      this.tui.requestRender();
      return;
    }
    const busy = face.busy?.();
    if (busy !== undefined) {
      say(`not changed: ${busy}`);
      this.tui.requestRender();
      return;
    }
    let file: string | undefined;
    try {
      file = face.set(id, value);
    } catch (error) {
      say(`not changed: ${error instanceof Error ? error.message : String(error)}`);
      this.tui.requestRender();
      return;
    }
    // /config 选项=值 直接改的写一行结果（面板里改的，那一项当场更新就是反馈）；与现在相同、没写文件的也写一行，
    // 不然直接打的命令没有任何反应
    const overridden = (): string => {
      const view = this.configItems()?.find((item) => item.option.id === id);
      return view?.overriddenBy !== undefined
        ? `, but ${OVERRIDE_LAYER[view.overriddenBy]} override it`
        : "";
    };
    if (file === undefined) {
      if (!inPanel) this.flow.addSystem(`${id} is already ${value}${overridden()}`);
      this.tui.requestRender();
      return;
    }
    if (!inPanel) {
      this.flow.addSystem(`${id} = ${value} (written to user settings${overridden()})`);
    }
    const reload = this.options.reload;
    if (reload === undefined) {
      this.refreshConfigPanel(id);
      this.tui.requestRender();
      return;
    }
    this.running = true;
    if (inPanel) this.configPanel.setNote("");
    this.updateStatus();
    this.tui.requestRender();
    const finish = (lines: readonly string[], failed: boolean): void => {
      this.running = false;
      if (inPanel) {
        // 由面板触发的重读不单独报重读结果（SETTINGS_RELOADED_PREFIX）；别的提示（外部同时改了 MCP 等）并进这一句
        const extra = lines.filter(
          (line) => !line.startsWith(SETTINGS_RELOADED_PREFIX) && line !== SETTINGS_UNCHANGED
        );
        this.configPanel.setNote(
          failed ? (lines[0] ?? "reloading settings failed") : extra.join("; "),
          failed
        );
      } else if (failed) {
        for (const line of lines) this.flow.addAlert(line);
      } else {
        // 重读设置的"已重读""没有变化"两句不写（上面那一行就是结果），别的提示照写
        for (const line of lines) {
          if (!line.startsWith(SETTINGS_RELOADED_PREFIX) && line !== SETTINGS_UNCHANGED) {
            this.flow.addSystem(line);
          }
        }
      }
      this.refreshConfigPanel(id);
      this.updateStatus();
      this.tui.requestRender();
      this.drainQueue();
    };
    reload([]).then(
      (lines) => finish(lines, false),
      (error: unknown) =>
        finish(
          [`reloading settings failed: ${error instanceof Error ? error.message : String(error)}`],
          true
        )
    );
  }

  // 决策 443：/take <名字>——会话面板里有这个名字的会话即取回它工作树里的改动（没有这个名字为 undefined）
  takePooled(id: string): Promise<string> | undefined {
    const source = this.options.pool?.source;
    const card = source?.list().find((item) => item.id === id);
    if (source === undefined || card === undefined) return undefined;
    return (
      source.take?.(card.id) ?? Promise.resolve("this session has no worktree; nothing to take")
    );
  }

  // 决策 443：会话面板里有没有这个名字的会话（/take 先判歧义，不取）
  hasPooled(id: string): boolean {
    return (this.options.pool?.source.list() ?? []).some((item) => item.id === id);
  }

  // 决策 492：/worktrees clean 的清单已列出，状态行问一次 y/N
  beginCleanConfirm(): void {
    this.cleanConfirm = true;
    this.updateStatus();
    this.tui.requestRender();
  }

  // 决策 490：/take 不带参数——把 `/take ` 填进输入框，参数候选随即在输入框下方弹出（之后按 Tab 也能再弹），选中即补上全量会话号，
  // 回车才真取
  beginTakePick(): void {
    if (this.takeableCards().length === 0) {
      this.flow.addSystem("no session to take changes from");
      return;
    }
    this.input.setText("/take ");
    openArgumentCompletions(this.input);
    this.tui.requestRender();
  }

  // 决策 490：现在能取的会话——判断交给数据源（与 /take 拒绝的条件同一组：运行面开着、不在跑、有工作树、同一仓库、
  // 落点不是它的工作树）；数据源不判断时按在工作树里干活、已开着且闲着或停着的算。当前会话不列
  private takeableCards(): PooledSessionCard[] {
    const source = this.options.pool?.source;
    return (source?.list() ?? []).filter(
      (card) =>
        card.id !== this.current.sessionId &&
        (source?.canTake?.(card.id) ??
          (card.worktree !== undefined &&
            card.dormant !== true &&
            (card.state === "idle" || card.state === "stopped")))
    );
  }

  // `/take ` 的参数候选（按会话号前缀或名字筛）
  private takeArgumentItems(prefix: string): AutocompleteItem[] {
    return this.takeableCards()
      .filter((card) => prefix === "" || card.id.startsWith(prefix) || card.name.includes(prefix))
      .map((card) => ({ value: card.id, label: card.name, description: card.id }));
  }

  // 决策 491：/status 的文本（数据由装配方给；这里只管取与格式化）
  async statusCommand(): Promise<string> {
    const report = this.options.status;
    if (report === undefined) return "/status is not available in this session";
    return statusReportText(await report());
  }

  // 决策 490：/take 不带参数时列出"现在能取"的会话——面板里在工作树里干活的（共用目录的、没有工作树的不列）
  takeableText(): string {
    const cards = this.takeableCards();
    if (cards.length === 0) return "no session to take changes from";
    return [
      "take changes from (then run /take <id>):",
      ...cards.map((card) => `  ${card.name}  ${card.id}`),
    ].join("\n");
  }
  // 决策 443、483：会话面板里的会话号（/resume 与会话选择器排除它们；停下的运行面还开着，同样排除）
  pooledSessionIds(): ReadonlySet<string> {
    return new Set((this.options.pool?.source.list() ?? []).map((card) => card.id));
  }

  // 决策 458：会话面板里当前会话那张卡——名字、状态（主会话自己的审批挂着为等待回应，在跑、空闲）、首条输入与最近回复
  private mainCard(): PooledSessionCard {
    const id = this.current.sessionId;
    const digest = this.flow.digest();
    // 决策 483：它自己的审批挂着，或它派出的子 agent 在等审批（排着的也算）
    const waiting =
      this.pendingApprovalState?.mainWaiting ?? this.agentWaitingLine(this.current.sessionId);
    const state: PooledSessionState =
      waiting !== undefined ? "waiting" : this.isBusy() ? "running" : "idle";
    return {
      id,
      name: this.options.sessionName?.(id) ?? id,
      state,
      ...(this.interrupting && state !== "idle" ? { cancelling: true } : {}),
      task: digest.firstInput,
      summary: digest.lastReply,
      ...(waiting !== undefined ? { waiting } : {}),
      startedAt: 0,
      updatedAt: 0,
    };
  }

  // 某会话派出的子 agent 里在等审批的（第一个的路径）；没有为 undefined
  private agentWaitingLine(sessionId: string): string | undefined {
    const face = this.options.agents;
    const waiting = face?.waiting?.();
    if (face === undefined || waiting === undefined || waiting.size === 0) return undefined;
    const record = face.list(sessionId).find((agent) => waiting.has(agent.path));
    return record !== undefined ? `${record.path}: approval` : undefined;
  }

  // 决策 458：偷看当前会话——在等什么，加最近几条对话
  private mainPeekLines(): string[] {
    const waiting =
      this.pendingApprovalState?.mainWaiting ?? this.agentWaitingLine(this.current.sessionId);
    return [
      ...(waiting !== undefined ? [`waiting: ${waiting}`] : []),
      ...this.flow.digest().recent,
    ];
  }

  // 决策 484：当前会话的首条输入（退到面板时卡片上的那句话）
  currentTask(): string {
    return this.flow.digest().firstInput;
  }

  // 决策 458：/take 用到当前会话的名字时说明（CommandsHost）
  currentSessionName(): string | undefined {
    return this.options.sessionName?.(this.current.sessionId);
  }

  // 偷看开着时取一次选中会话的内容（当前会话的内容每次画时现取）
  private refreshPeek(): void {
    const source = this.options.pool?.source;
    const card = this.sessionPanel.selected();
    if (source === undefined || card === undefined || !this.sessionPanel.isPeeking()) return;
    if (this.sessionPanel.isMain(card)) return;
    void source.peek(card.id).then((lines) => {
      this.peekCache.set(card.id, lines);
      this.tui.requestRender();
    });
  }

  // 决策 443：/panel
  get panelCommand(): (() => void) | undefined {
    return this.options.pool === undefined ? undefined : () => this.openPanel();
  }

  // 决策 443：打开会话面板（整屏，底部输入框派新会话）；select：光标落在这个会话上（决策 470：按 ← 打开时是刚才所在的会话）
  openPanel(select?: string): void {
    const pool = this.options.pool;
    if (pool === undefined) return;
    // 决策 485：从主视图离开的当前会话记进工作清单；清单在打开面板时重读
    if (this.view === "main") pool.left?.();
    pool.source.refresh?.();
    // 决策 458：打开时从不偷看开始（输入框里的话派新会话，不会悄悄发给上次偷看的会话）
    this.sessionPanel.closePeek();
    if (select !== undefined) this.sessionPanel.selectId(select);
    this.showView("panel");
    this.tui.requestRender();
  }

  // 决策 470：主视图里输入框为空时按 ←：第一下在状态行提示，短时间内再按一下才打开面板并选中刚才所在的
  // 会话（照 Claude Code，防误触）。没有面板（沙箱等）或设置关掉时不做事、不吞键
  private leftOpensPanel(data: string): boolean {
    if (
      this.view !== "main" ||
      this.options.pool === undefined ||
      this.options.leftArrowOpensPanel?.() === false ||
      !isKey(data, "pigeon.openPanel") ||
      this.input.getText() !== "" ||
      this.picker.isOpen()
    ) {
      return false;
    }
    const now = Date.now();
    const first = this.panelLeftAt;
    this.clearPanelHint();
    if (first !== undefined && now - first <= this.exitWindowMs()) {
      this.openPanel(this.current.sessionId);
      return true;
    }
    this.panelLeftAt = now;
    this.panelHintTimer = setTimeout(() => {
      this.clearPanelHint();
      this.updateStatus();
      this.tui.requestRender();
    }, this.exitWindowMs());
    this.panelHintTimer.unref?.();
    this.updateStatus();
    this.tui.requestRender();
    return true;
  }

  private clearPanelHint(): void {
    if (this.panelHintTimer !== undefined) clearTimeout(this.panelHintTimer);
    this.panelHintTimer = undefined;
    this.panelLeftAt = undefined;
  }

  private handlePanelKey(data: string): { consume: true } | undefined {
    const panel = this.sessionPanel;
    const empty = this.input.getText() === "";
    if (matchesKey(data, "escape")) {
      if (panel.isPeeking()) {
        panel.closePeek();
      } else {
        this.showView("main");
        this.drainQueue();
      }
    } else if (matchesKey(data, "up")) {
      panel.move(-1);
      this.refreshPeek();
    } else if (matchesKey(data, "down")) {
      panel.move(1);
      this.refreshPeek();
    } else if (empty && matchesKey(data, "space")) {
      panel.togglePeek();
      this.refreshPeek();
    } else if (empty && (matchesKey(data, "enter") || matchesKey(data, "right"))) {
      // 决策 470：→ 与 Enter 一样进入选中的会话（输入框有字时 → 照旧移光标）
      const card = panel.selected();
      if (panel.isMain(card)) {
        // 决策 458：进入当前会话即关面板回到主视图（偷看一并关掉，再开面板时输入框里的话照常派新会话）
        panel.closePeek();
        this.showView("main");
        this.drainQueue();
      } else if (card?.elsewhere === true) {
        this.openElsewhere(card);
      } else if (card !== undefined) {
        this.enterPooled(card);
      }
    } else if (isKey(data, "pigeon.tree")) {
      this.stopFromPanel();
    } else {
      return undefined;
    }
    this.tui.requestRender();
    return { consume: true };
  }

  // 面板里的 Ctrl+X：别的会话第一下停下、两秒内再按去掉；当前会话那张卡连按两下中断这一轮
  private stopFromPanel(): void {
    const pool = this.options.pool;
    const card = this.sessionPanel.selected();
    if (pool === undefined || card === undefined) return;
    // 决策 458：当前会话的"停止"是中断它这一轮，不是退出程序
    const main = this.sessionPanel.isMain(card);
    if (main && !this.running) {
      this.sessionPanel.setNote(`${card.name} is not running`);
      return;
    }
    const now = Date.now();
    // 决策 483：别的会话——第一下停下（运行面留着，它派出的子 agent 接着跑），两秒内再按一下从面板去掉（子 agent 一并停下，
    // 会话记录保留）；已停下的第一下只等第二下
    if (!main) {
      const last = this.lastPanelStop;
      if (last !== undefined && last.id === card.id && now - last.at <= PANEL_STOP_CONFIRM_MS) {
        this.lastPanelStop = undefined;
        this.sessionPanel.setNote("");
        pool.source.remove(card.id).then(
          () => this.tui.requestRender(),
          (error: unknown) => {
            this.sessionPanel.setNote(
              `removing ${card.name} failed: ${error instanceof Error ? error.message : String(error)}`
            );
            this.tui.requestRender();
          }
        );
        return;
      }
      this.lastPanelStop = { id: card.id, at: now };
      if (card.state !== "stopped") {
        pool.source.stop(card.id).then(
          () => this.tui.requestRender(),
          (error: unknown) => {
            this.sessionPanel.setNote(
              `stopping ${card.name} failed: ${error instanceof Error ? error.message : String(error)}`
            );
            this.tui.requestRender();
          }
        );
      }
      return;
    }
    const last = this.lastPanelStop;
    const work = main ? this.workStartedAt : undefined;
    if (
      last !== undefined &&
      last.id === card.id &&
      now - last.at <= PANEL_STOP_CONFIRM_MS &&
      last.work === work
    ) {
      this.lastPanelStop = undefined;
      this.sessionPanel.setNote("");
      this.requestInterrupt();
      return;
    }
    this.lastPanelStop = { id: card.id, at: now, work };
    this.sessionPanel.setNote(`press Ctrl+X again to interrupt ${card.name}`);
  }

  // 会话面板里的输入：偷看时发给选中的会话（回复），否则派新会话；进入的会话里发给它
  private handlePoolSubmit(value: string): void {
    const pool = this.options.pool;
    if (pool === undefined) return;
    const selected = this.sessionPanel.selected();
    // 决策 458：偷看当前会话时输入框里的话就是发给主会话的消息（在跑时排队，与主视图里一样）
    if (
      this.sessionPanel.isPeeking() &&
      this.sessionPanel.isMain(selected) &&
      selected !== undefined
    ) {
      if (this.isBusy()) {
        this.queue.enqueue(value);
        this.sessionPanel.setNote("queued");
      } else {
        this.submitNow(value);
      }
      return;
    }
    if (this.sessionPanel.isPeeking() && selected !== undefined) {
      void pool.source.send(selected.id, value).then((refusal) => {
        this.sessionPanel.setNote(refusal ?? "");
        if (refusal !== undefined && this.input.getText() === "") this.input.setText(value);
        this.refreshPeek();
        this.tui.requestRender();
      });
      return;
    }
    pool.source.spawn(value).then(
      (card) => {
        this.sessionPanel.followSpawn(card.id);
        this.sessionPanel.setNote(
          card.state === "failed" ? `spawn failed: ${card.error ?? ""}` : ""
        );
        this.tui.requestRender();
      },
      (error: unknown) => {
        this.sessionPanel.setNote(
          `spawn failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.tui.requestRender();
      }
    );
  }

  // 决策 485：进入别的 Pigeon 开着的会话：整屏只看它的历史（取自它的会话记录），Esc 回面板
  private openElsewhere(card: PooledSessionCard): void {
    const flow = new MessageFlow();
    flow.setToolsExpanded(this.flow.toolsExpandedState());
    this.renderHistoryInto(flow, card.id, undefined, card.root);
    this.sessionPanel.closePeek();
    this.elsewhereSession = { card, flow };
    this.showView("elsewhere");
  }

  // 决策 484：进入会话面板里的一个会话——它成为当前会话（换手由装配方做），原来的当前会话退到面板接着跑
  private enterPooled(card: PooledSessionCard): void {
    const enter = this.options.pool?.enter;
    if (enter === undefined) return;
    if (card.id.startsWith("pending:")) {
      this.sessionPanel.setNote(`session ${card.name} is still starting`);
      return;
    }
    const busy = this.handOffBlocked();
    if (busy !== undefined) {
      this.sessionPanel.setNote(busy);
      return;
    }
    this.sessionPanel.closePeek();
    enter(card.id).then(
      (refusal) => {
        if (refusal !== undefined) this.sessionPanel.setNote(refusal);
        this.tui.requestRender();
      },
      (error: unknown) => {
        this.sessionPanel.setNote(
          `opening ${card.name} failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.tui.requestRender();
      }
    );
  }

  // M7（决策 079）：/fork（CommandsHost）
  get forkCommand(): ((args: string) => Promise<string>) | undefined {
    return this.options.fork;
  }

  // 决策 435：/rewind
  get rewindCommand(): (() => void) | undefined {
    return this.options.rewind === undefined ? undefined : () => this.openRewind();
  }

  private messageTreeOpen(): boolean {
    return this.view === "rewind";
  }

  // 决策 435：打开消息树（双击 Esc、/rewind）
  openRewind(): void {
    const rewind = this.options.rewind;
    if (rewind === undefined) return;
    if (this.isBusy()) {
      this.flow.addSystem("can't rewind while running");
      this.tui.requestRender();
      return;
    }
    this.messageTree.loading();
    this.showView("rewind");
    rewind.tree().then(
      (nodes) => {
        if (this.messageTreeOpen()) this.messageTree.load(nodes);
        this.tui.requestRender();
      },
      (error: unknown) => {
        this.messageTree.fail(
          `reading message tree failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.tui.requestRender();
      }
    );
  }

  private closeMessageTree(): void {
    this.rewindPrepared = undefined;
    this.rewindCode = undefined;
    this.rewindMenu = undefined;
    this.rewindTarget = undefined;
    this.showView("main");
    this.drainQueue();
  }

  private handleMessageTreeKey(data: string): void {
    const tree = this.messageTree;
    const stage = tree.stage();
    // 读取与执行进行中：只等它（读取中 Esc 可关）
    if (stage === "loading" || stage === "busy") {
      if (stage === "loading" && matchesKey(data, "escape")) this.closeMessageTree();
      return;
    }
    if (stage === "tree") {
      if (matchesKey(data, "escape")) {
        this.closeMessageTree();
      } else if (matchesKey(data, "up")) {
        tree.move(-1);
      } else if (matchesKey(data, "down")) {
        tree.move(1);
      } else if (matchesKey(data, "left")) {
        tree.shift(-1);
      } else if (matchesKey(data, "right")) {
        tree.shift(1);
      } else if (matchesKey(data, "enter")) {
        const row = tree.selected();
        if (row !== undefined) this.planMenu(row);
      }
      return;
    }
    if (stage === "choose") {
      if (matchesKey(data, "escape")) {
        this.rewindMenu = undefined;
        tree.back();
      } else if (matchesKey(data, "up")) {
        tree.move(-1);
      } else if (matchesKey(data, "down")) {
        tree.move(1);
      } else if (matchesKey(data, "enter")) {
        const action = tree.action();
        if (action !== undefined) this.chooseRewindAction(action);
      }
      return;
    }
    // 拿不准的文件逐个选
    if (matchesKey(data, "escape")) {
      tree.back();
    } else if (matchesKey(data, "up")) {
      tree.move(-1);
    } else if (matchesKey(data, "down")) {
      tree.move(1);
    } else if (matchesKey(data, "space")) {
      tree.toggle();
    } else if (matchesKey(data, "enter")) {
      this.applyRewind(this.pendingRewindMode, tree.reverts());
    }
  }

  private rewindFailed(error: unknown): void {
    this.rewinding = false;
    this.rewindMenu = undefined;
    this.messageTree.back(
      `rewind failed: ${error instanceof Error ? error.message : String(error)}`
    );
    this.updateStatus();
    this.tui.requestRender();
  }

  // 选了一行回车：先规划（不拍快照）——退到这一条之前、整支切到正在看的版本（不是当前版本时）、撤销上次退代码——
  // 据此只给做得成的几项：只能退对话的情形不给含 code 的两项，切不过去的不给 Switch，没有可撤销的不给 Undo
  private planMenu(row: VersionRow): void {
    const rewind = this.options.rewind;
    if (rewind === undefined) return;
    const node = row.node;
    const tip = this.messageTree.switchTarget();
    this.rewinding = true;
    this.messageTree.busy();
    void (async () => {
      const before = node === undefined ? undefined : await rewind.prepare(node.target);
      const branch = tip === undefined ? undefined : await rewind.prepare(tip.target);
      const undo = await rewind.prepareUndo();
      return { before, branch, undo };
    })().then(
      ({ before, branch, undo }) => {
        this.rewinding = false;
        const menu: RewindMenu = {};
        const actions: RewindAction[] = [];
        let note: string | undefined;
        if (node !== undefined && before !== undefined) {
          const plan = before.plan;
          if (plan.conversationBlocked !== undefined) {
            note = `can't rewind: ${plan.conversationBlocked}`;
          } else {
            menu.before = { node, prepared: before };
            const code = plan.codeBlocked === undefined && plan.files.length > 0;
            actions.push(
              ...(code ? (["both", "conversation", "code"] as const) : (["conversation"] as const))
            );
            note = code
              ? plan.untouchable.length > 0
                ? `too large to snapshot; left alone: ${plan.untouchable.join(", ")}`
                : undefined
              : plan.codeBlocked;
          }
        }
        if (
          tip !== undefined &&
          branch !== undefined &&
          branch.plan.conversationBlocked === undefined
        ) {
          const code = branch.plan.codeBlocked === undefined && branch.plan.files.length > 0;
          menu.branch = { node: tip, prepared: branch, mode: code ? "both" : "conversation" };
          actions.push("switch");
        }
        if (undo !== undefined && undo.plan.files.length > 0) {
          menu.undo = undo;
          actions.push("undo");
        }
        if (actions.length === 0) {
          this.messageTree.back(note ?? "already here");
        } else {
          this.rewindMenu = menu;
          this.messageTree.choose(rewindMenuTitle(row), [...actions, "cancel"], note);
        }
        this.tui.requestRender();
      },
      (error: unknown) => this.rewindFailed(error)
    );
  }

  // 菜单里选了一项：取对应的规划；退代码的先给现状拍快照（433），拿不准的文件让人逐个选
  private chooseRewindAction(action: RewindAction): void {
    const menu = this.rewindMenu;
    if (action === "cancel" || menu === undefined) {
      this.rewindMenu = undefined;
      this.messageTree.back();
      return;
    }
    let mode: RewindMode;
    if (action === "switch") {
      if (menu.branch === undefined) return;
      this.rewindPrepared = menu.branch.prepared;
      this.rewindTarget = { kind: "switch", node: menu.branch.node };
      mode = menu.branch.mode;
    } else if (action === "undo") {
      if (menu.undo === undefined) return;
      this.rewindPrepared = menu.undo;
      this.rewindTarget = { kind: "undo" };
      mode = "code";
    } else {
      if (menu.before === undefined) return;
      this.rewindPrepared = menu.before.prepared;
      this.rewindTarget = { kind: "before", node: menu.before.node };
      mode = action;
    }
    this.rewindMenu = undefined;
    this.rewindCode = undefined;
    this.chooseRewindMode(mode);
  }

  private chooseRewindMode(mode: RewindMode): void {
    const rewind = this.options.rewind;
    const prepared = this.rewindPrepared;
    if (rewind === undefined || prepared === undefined) return;
    this.pendingRewindMode = mode;
    if (mode === "conversation") {
      this.applyRewind(mode, new Set());
      return;
    }
    this.rewinding = true;
    this.messageTree.busy();
    rewind.check(prepared).then(
      (code) => {
        this.rewindCode = code;
        const conflicts = code.classified.conflicts;
        if (conflicts.length > 0) {
          this.rewinding = false;
          this.messageTree.conflicts(
            conflicts.map((action) => ({ path: action.path, reason: action.reason }))
          );
          this.tui.requestRender();
          return;
        }
        this.applyRewind(mode, new Set());
      },
      (error: unknown) => this.rewindFailed(error)
    );
  }

  private applyRewind(mode: RewindMode, revert: ReadonlySet<string>): void {
    const rewind = this.options.rewind;
    const prepared = this.rewindPrepared;
    const target = this.rewindTarget;
    if (rewind === undefined || prepared === undefined || target === undefined) return;
    this.rewinding = true;
    this.messageTree.busy();
    const code = this.rewindCode;
    rewind
      .apply(prepared, {
        mode,
        ...(code !== undefined && mode !== "conversation" ? { code } : {}),
        revert,
      })
      .then(
        (outcome) => this.rewindDone(target, outcome),
        (error: unknown) => this.rewindFailed(error)
      );
  }

  // 回退完成（或部分完成）：退了对话的按新的主分支重绘消息区，原消息放回输入框；写回结果与出错如实列出
  private rewindDone(target: RewindTarget, outcome: RewindOutcome): void {
    this.rewinding = false;
    this.rewindPrepared = undefined;
    this.rewindCode = undefined;
    this.rewindTarget = undefined;
    this.showView("main");
    const moved =
      outcome.mode !== "code" &&
      outcome.failed === undefined &&
      outcome.conversationSkipped === undefined;
    if (moved) {
      this.flow.clear();
      this.renderHistoryInto(this.flow, this.current.sessionId, "--- rewound ---");
    }
    const what =
      outcome.mode === "both"
        ? "code and conversation"
        : outcome.mode === "conversation"
          ? "conversation"
          : "code";
    if (outcome.undo === true) {
      this.flow.addSystem(
        outcome.failed === undefined
          ? "undid last code rewind"
          : "undo of last code rewind incomplete"
      );
    } else if (outcome.failed !== undefined) {
      this.flow.addAlert("restoring files failed partway; conversation not rewound");
    } else {
      this.flow.addSystem(
        target.kind === "switch"
          ? `switched ${what} to this version`
          : `rewound ${what} to before this message`
      );
    }
    const restore = outcome.restore;
    if (restore !== undefined) {
      const list = (paths: readonly string[]) =>
        paths.length > 6
          ? `${paths.slice(0, 6).join(", ")} +${paths.length - 6} more`
          : paths.join(", ");
      if (restore.written.length > 0) this.flow.addSystem(`restored: ${list(restore.written)}`);
      if (restore.removed.length > 0) this.flow.addSystem(`removed: ${list(restore.removed)}`);
      if (restore.removedDirs.length > 0) {
        this.flow.addSystem(`removed empty dirs: ${list(restore.removedDirs)}`);
      }
      for (const skipped of restore.skipped) {
        this.flow.addSystem(`skipped: ${skipped.path} (${skipped.reason})`);
      }
      if (
        restore.written.length + restore.removed.length + restore.skipped.length === 0 &&
        outcome.failed === undefined
      ) {
        this.flow.addSystem("no files to restore");
      }
    }
    if (outcome.failed !== undefined) {
      this.flow.addAlert(
        `failed: ${outcome.failed.path === "" ? "" : `${outcome.failed.path}: `}${outcome.failed.reason}`
      );
    }
    if (outcome.conversationSkipped !== undefined) this.flow.addSystem(outcome.conversationSkipped);
    for (const problem of outcome.problems) this.flow.addSystem(`problem: ${problem}`);
    for (const path of outcome.untouchable) {
      this.flow.addSystem(`skipped: ${path} (too large to snapshot)`);
    }
    if (moved && target.kind === "before" && target.node.prefill !== undefined) {
      this.input.setText(target.node.prefill);
    }
    this.updateStatus();
    this.tui.requestRender();
    this.drainQueue();
  }

  // 决策 456：/rename（CommandsHost）
  get renameSession(): ((name: string) => string) | undefined {
    return this.options.renameSession;
  }

  private titleText(): string {
    // 验收修改：主视图不显示标题行；子 agent 的会话里留一行很短的弱化说明——在哪、怎么回去
    if (this.view === "agent" && this.agentSession !== undefined) {
      return secondary(`sub-agent ${this.agentSession.record.path} · esc to go back`);
    }
    // 决策 485：别的 Pigeon 开着的会话只看历史
    if (this.view === "elsewhere" && this.elsewhereSession !== undefined) {
      return secondary(
        `session ${this.elsewhereSession.card.name} · open elsewhere · esc to go back`
      );
    }
    return "";
  }

  // 接管 Esc（CommandsHost）：/memory edit 排队保存期间按 Esc 取消；后接管的优先，交还时只撤自己那一份
  captureEscape(onEscape: () => void): () => void {
    const handler = () => onEscape();
    this.escapeCapture = handler;
    return () => {
      if (this.escapeCapture === handler) this.escapeCapture = undefined;
    };
  }

  // 决策 331：暂停界面执行一段要独占终端的动作（/memory edit 打开编辑器），结束后恢复界面并整屏重画
  suspendFor<T>(work: () => T): T {
    // 决策 441：暂时离开全屏，不往普通屏幕打印对话
    if (!this.started) return work();
    this.tui.stop({ preserveScreen: true });
    try {
      return work();
    } finally {
      this.tui.start();
      this.tui.requestRender(true);
    }
  }

  // ---- 决策 286：排队接口（编排一段在"下一轮发什么"处接入待递的通知）----

  enqueueInput(text: string): void {
    this.queue.enqueue(text);
    this.drainQueue();
  }

  queuedInputs(): readonly string[] {
    return this.queue.pending();
  }

  // 把排队内容退回输入框（排队在前、已有草稿在后）
  restoreQueueToEditor(): void {
    if (this.queue.size() === 0) return;
    this.input.setText(this.queue.restoreInto(this.input.getText()));
    this.tui.requestRender();
  }

  // ---- 决策 286：视图按键（选择器、Ctrl+O、退回排队）----

  // 决策 469：当前会话的审批模式
  private modeControl(): ApprovalModeControl | undefined {
    return this.options.approvalMode?.();
  }

  // Shift+Tab：在询问与放手之间切换，当场生效；挂着的审批不替人回答（挂着时按键归审批，到不了这里）
  private toggleApprovalMode(): void {
    const control = this.modeControl();
    if (control === undefined) return;
    control.set(control.get() === "yolo" ? "prompt" : "yolo");
    this.updateStatus();
    this.tui.requestRender();
  }

  private handleViewKey(data: string): { consume: true } | undefined {
    // 决策 465：设置视图里正在就地输入或等新键：按键全归它（Shift+Tab 等也要能绑）
    if (
      this.configPanel.isOpen() &&
      this.configPanel.busyWithInput() &&
      this.pendingApprovalState === null
    ) {
      this.configPanel.handleInput(data);
      this.tui.requestRender();
      return { consume: true };
    }
    if (isKey(data, "pigeon.toggleMode")) {
      this.toggleApprovalMode();
      return { consume: true };
    }
    // 决策 442：设置面板开着时按键归它（方向键、Enter/空格改值、Esc 关）；审批挂着（含写拒绝理由）时不归它
    if (this.configPanel.isOpen() && this.pendingApprovalState === null) {
      this.configPanel.handleInput(data);
      this.tui.requestRender();
      return { consume: true };
    }
    if (this.picker.isOpen()) {
      // 决策 439：按键交给选择列表（方向键、翻页、回车、Esc）；其余吞掉，输入框内容不动
      this.picker.handleInput(data);
      this.tui.requestRender();
      return { consume: true };
    }
    if (isKey(data, "pigeon.toggleToolOutput")) {
      const expanded = !this.flow.toolsExpandedState();
      this.flow.setToolsExpanded(expanded);
      this.tui.requestRender();
      return { consume: true };
    }
    // 决策 443：面板里不动当前会话排队的内容
    if (isKey(data, "pigeon.dequeue") && this.queue.size() > 0 && this.view !== "panel") {
      this.restoreQueueToEditor();
      return { consume: true };
    }
    return undefined;
  }

  // ---- 决策 286：工具结果、上下文用量与花费 ----

  private handleToolResult(notice: ToolResultNotice): void {
    // 同增量：只认当前 Run 的出处
    if (this.activeRunId === null || notice.runId !== this.activeRunId) return;
    attachToolResultTo(this.flow, notice);
    // 工具执行中另发的模型请求（web_fetch 的提炼等）计入本会话花费
    const extra = toolResultModelUsage(notice.details);
    if (extra !== undefined) {
      addUsage(this.costLive, extra, {
        ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
        endMs: Date.now(),
      });
      this.refreshCost();
    }
    this.tui.requestRender();
  }

  private refreshContext(): void {
    const usage = this.current.runtime.contextUsage?.();
    this.statusBar.update(usage !== undefined ? { context: usage } : { context: undefined });
  }

  private refreshCost(): void {
    const total = emptyCostTally();
    mergeCostTally(total, this.costBase);
    mergeCostTally(total, this.costLive);
    this.statusBar.update({ cost: total });
  }

  // 打开或续接会话时重置花费：续接从会话记录累计已有花费（会话自己、它的子 agent 与复盘）
  private resetCosts(sessionId: SessionId, resumed: boolean): void {
    const root = this.sessionsRoot();
    this.costLive = emptyCostTally();
    if (root === undefined) {
      this.costBase = emptyCostTally();
      this.childCosts = undefined;
    } else {
      const sessionsRoot = sessionsDirOf(root);
      try {
        this.costBase = resumed
          ? accumulatedSessionCost(sessionsRoot, sessionId)
          : emptyCostTally();
      } catch {
        this.costBase = emptyCostTally();
      }
      this.childCosts = new ChildSessionCosts(sessionsRoot, sessionId, Date.now());
    }
    this.refreshCost();
  }

  // 子 agent 与收尾了的复盘会话的花费（运行收尾、压缩、子 agent 状态有变时查）
  private collectChildCosts(): void {
    if (this.childCosts === undefined) return;
    try {
      mergeCostTally(this.costLive, this.childCosts.collect());
    } catch {
      // 读会话文件失败：这次不计，下次再看
    }
    this.refreshCost();
  }

  // 运行期告警（压缩、会话存储、工作区快照等）：终端界面运行期间落消息区，文案与去重由告警方负责
  addWarning(line: string): void {
    this.flow.addAlert(line);
    this.tui.requestRender();
  }

  // 启动时直接续接的会话（pigeon --continue / --resume <id>）：给出续跑报告与历史，并从会话记录累计已有花费
  announceResumed(root: string, report: readonly string[]): void {
    for (const line of report) this.flow.addSystem(line);
    this.resetCosts(this.current.sessionId, true);
    renderHistory(this, root, this.current.sessionId);
  }

  // 会话选择器（286）：/resume 与 pigeon --resume 不带会话号时弹出；当前会话与没有输入过的会话不列
  openSessionPicker(): void {
    const root = this.options.resume !== undefined ? this.sessionsRoot() : undefined;
    if (root === undefined) {
      this.flow.addSystem("/resume is not available in this session");
      this.tui.requestRender();
      return;
    }
    let sessions: ReturnType<typeof listRecentMainSessions>;
    try {
      // 决策 443：会话面板里还开着的会话不列（换过去会有两个运行面写同一个会话文件）
      const pooled = this.pooledSessionIds();
      sessions = listRecentMainSessions(root).filter(
        (session) =>
          session.sessionId !== this.current.sessionId &&
          session.turns > 0 &&
          !pooled.has(session.sessionId)
      );
    } catch (error) {
      this.flow.addAlert(
        `reading session list failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.tui.requestRender();
      return;
    }
    if (sessions.length === 0) {
      this.flow.addSystem("no sessions to resume");
      this.tui.requestRender();
      return;
    }
    const filter = createSessionFilter(root);
    const among = new Set<string>(sessions.map((session) => session.sessionId));
    // 决策 471：整屏的续接视图（同设置视图的做法）；选中或退出都先回主视图，再照旧续接
    this.picker.open(
      sessions,
      (picked) => {
        this.showView("main");
        if (picked === undefined) {
          // 按 Esc 取消：不说
        } else if (picked.sandbox) {
          this.flow.addSystem(sandboxResumeHint(picked.sessionId));
        } else if (this.handOffBlocked() !== undefined) {
          this.flow.addSystem(this.handOffBlocked() ?? "");
        } else {
          dispatchResumeCommand(this, picked.sessionId);
        }
        this.tui.requestRender();
        this.drainQueue();
      },
      () => Math.max(1, this.options.terminal.rows - RESUME_CHROME_ROWS),
      // 决策 466：打字即筛选——按会话内容筛列表里的这些会话
      {
        search: (query) => filter(query, among),
        updated: () => this.tui.requestRender(),
        // 决策 474：Ctrl+R 就地改名（会话文件被别处持有时不改）
        rename: (sessionId, name) => renameStoredSession(root, sessionId, name),
      }
    );
    this.showView("resume");
  }

  // ---- S3 审批面板（TuiApprovalFace 实现；交互语义在 modal.ts）----

  askApproval(request: ApprovalRequest, directoryGrant?: boolean): Promise<ApprovalPanelResult> {
    // 决策 301：就地弹出——在别的视图里时不切走，面板写明来源，答完仍留在原处
    this.clearApprovalBox();
    return askApprovalPanel(this, request, directoryGrant);
  }

  // 审批答完（handler 在决议后调用）：挂着的审批块收成这一行结论
  noteApproval(line: string): void {
    this.settleApproval(line);
  }

  // 挂着的审批块：显示在底部的审批区（决策 467，各视图都是），不进消息流；记下答完时写结论行的地方（主会话的消息流）
  addApprovalBlock(text: string, lines?: readonly ApprovalBlockLine[]): void {
    // 决策 472：分好类的各行由审批区上色画框；没给（替身等）即整块按细节显示
    this.approvalBox.setBlock(
      lines ?? text.split("\n").map((line) => ({ kind: "detail" as const, text: line }))
    );
    this.approvalSettlers = [(line: string) => this.flow.addConclusion(line)];
  }

  // 答完（或超时撤回）：审批区收起，消息流里只留一行暗色结论（多行命令只取首行）；没有挂着的审批块即不写
  settleApproval(line: string): void {
    const settlers = this.approvalSettlers.splice(0);
    const one = oneLineConclusion(line);
    for (const settle of settlers) settle(one);
    this.clearApprovalBox();
    this.tui.requestRender();
  }

  // 决策 301：审批面板的其他行——审批挂着时接在审批区里；已收起时（扣住的消息被撤回等）写一行到消息流
  addApprovalLine(line: string): void {
    if (this.pendingApprovalState !== null && !this.approvalBox.isEmpty()) {
      this.approvalBox.append(line);
      return;
    }
    this.flow.addSystem(line);
  }

  private clearApprovalBox(): void {
    this.approvalBox.clear();
  }

  outsideMainView(): boolean {
    return this.view !== "main";
  }

  // ---- 子模块窄接口（状态本体在本壳，子模块只读写不持有）----

  isStarted(): boolean {
    return this.started;
  }

  isRunning(): boolean {
    return this.running;
  }

  // 决策 435：空闲、主视图、输入框为空、没有补全与面板时，双击取消键打开消息树
  idleEscape(): boolean {
    if (
      this.options.rewind === undefined ||
      this.view !== "main" ||
      this.input.getText() !== "" ||
      this.input.isShowingAutocomplete() ||
      this.picker.isOpen() ||
      this.configPanel.isOpen()
    ) {
      this.lastIdleEscapeAt = undefined;
      return false;
    }
    const now = Date.now();
    const last = this.lastIdleEscapeAt;
    if (last !== undefined && now - last <= DOUBLE_ESCAPE_MS) {
      this.lastIdleEscapeAt = undefined;
      this.openRewind();
      return true;
    }
    this.lastIdleEscapeAt = now;
    return false;
  }

  pendingApproval(): PendingApproval | null {
    return this.pendingApprovalState;
  }

  setPendingApproval(pending: PendingApproval | null): void {
    this.pendingApprovalState = pending;
    if (pending === null) {
      this.clearApprovalBox();
      // 审批答完：状态行回到它之前在说的（例如还在等的 y/N 问句）
      this.updateStatus();
    }
  }

  lastCtrlCAt(): number | null {
    return this.lastCtrlCAtValue;
  }

  // 退出布防的状态行提示：开着时窗口一过即自己关
  setExitHint(on: boolean): void {
    if (this.exitHintTimer !== undefined) {
      clearTimeout(this.exitHintTimer);
      this.exitHintTimer = undefined;
    }
    this.exitHintOn = on;
    if (on) {
      this.exitHintTimer = setTimeout(() => {
        this.exitHintTimer = undefined;
        this.exitHintOn = false;
        this.updateStatus();
        this.tui.requestRender();
      }, this.exitWindowMs());
      this.exitHintTimer.unref?.();
    }
    this.updateStatus();
  }

  setLastCtrlCAt(at: number | null): void {
    this.lastCtrlCAtValue = at;
  }

  reasonMode(): boolean {
    return this.reasonModeOn;
  }

  setReasonMode(on: boolean): void {
    this.reasonModeOn = on;
  }

  exitWindowMs(): number {
    return this.options.exitWindowMs ?? 1000;
  }

  addSystem(line: string): void {
    this.flow.addSystem(line);
    // 决策 443：面板上主消息区看不见，最新一行另写在面板的说明行
    if (this.view === "panel") this.sessionPanel.setNote(line);
  }

  // 要醒目的一行（真正的报错）：消息区照常显示，不弱化
  addAlert(line: string): void {
    this.flow.addAlert(line);
    if (this.view === "panel") this.sessionPanel.setNote(line);
  }

  addHistoryLines(lines: Parameters<MessageFlow["addHistory"]>[0]): void {
    this.flow.addHistory(lines);
  }

  clearInput(): void {
    this.input.setText("");
  }

  render(): void {
    this.tui.requestRender();
  }

  sessionId(): SessionId {
    return this.current.sessionId;
  }

  grants(): TuiGrantsContext | undefined {
    return this.current.grants;
  }

  resumeConfigured(): boolean {
    return this.options.resume !== undefined;
  }

  sandbox(): TuiSandboxFace | undefined {
    return this.options.sandbox;
  }

  // 决策 485：/resume 只管当前会话所在的项目
  resumeOptions(): ResumeOptions<TuiSessionBinding> | undefined {
    const resume = this.options.resume;
    return resume !== undefined
      ? { ...resume, root: this.sessionsRoot() ?? resume.root }
      : undefined;
  }

  // 决策 485：当前会话所在项目的会话记录根（缺省启动时的）
  private sessionsRoot(): string | undefined {
    return this.current.root ?? this.options.sessions?.root ?? this.options.resume?.root;
  }

  historyLimit(): number | undefined {
    return this.options.historyLimit;
  }

  setResuming(resuming: boolean): void {
    this.resuming = resuming;
    // /resume 流程收尾（成败皆然）后发出排队的输入；延到本轮调用栈之后，让流程先写完收尾行
    if (!resuming) queueMicrotask(() => this.drainQueue());
  }

  // /resume：不带会话号弹出选择器（286）；沙箱会话不在本机界面里续接，说明用法
  resumeCommand(arg: string | undefined): void {
    // 决策 484：换会话与进入面板里的会话同一道守卫
    const blocked = this.handOffBlocked();
    if (blocked !== undefined) {
      this.flow.addSystem(blocked);
      return;
    }
    if (arg === undefined) {
      this.openSessionPicker();
      return;
    }
    const root = this.options.resume !== undefined ? this.sessionsRoot() : undefined;
    if (root !== undefined && isSandboxSession(root, arg)) {
      this.flow.addSystem(sandboxResumeHint(arg));
      return;
    }
    dispatchResumeCommand(this, arg);
  }

  // 决策 496：/clear 与 /new [path]——开一个新会话并换过去；当前会话还在干活时退到面板接着跑（装配方在 create 里做这件事）
  newSessionConfigured(): boolean {
    return this.options.newSession !== undefined;
  }

  newSessionCommand(request: NewSessionRequest): void {
    // 决策 484：换会话与 /resume、进入面板里的会话同一道守卫（收尾、回退、重读设置、压缩进行中不给换）
    const blocked = this.handOffBlocked();
    if (blocked !== undefined) {
      this.flow.addSystem(blocked);
      return;
    }
    const create = this.options.newSession?.create;
    const command = request.kind === "clear" ? "clear" : "new";
    if (create === undefined) {
      this.flow.addSystem(`/${command} is not available in this session`);
      return;
    }
    // 换手期间与 /resume 同样占住输入
    this.setResuming(true);
    this.updateStatus();
    this.render();
    const finish = (error?: unknown): void => {
      this.setResuming(false);
      if (error !== undefined) this.flow.addAlert(failureLine(command, error));
      this.updateStatus();
      this.render();
    };
    void create(request).then(
      (created) => {
        // 新会话的 SessionStart 按 startup（不是续跑），花费从零起算
        this.rebindSession(created.sessionId, created.binding, {
          source: "startup",
          resumed: false,
        });
        finish();
      },
      (error: unknown) => finish(error)
    );
  }

  // 决策 340：/reload——重读期间与 Run 同样占住输入；结果逐行写进消息区
  get reloadCommand(): ((args: readonly string[]) => void) | undefined {
    const reload = this.options.reload;
    if (reload === undefined) return undefined;
    return (args) => {
      this.running = true;
      this.updateStatus();
      this.tui.requestRender();
      const finish = (lines: readonly string[], failed = false): void => {
        this.running = false;
        for (const line of lines) {
          if (failed) this.flow.addAlert(line);
          else this.flow.addSystem(line);
        }
        this.updateStatus();
        this.tui.requestRender();
        this.drainQueue();
      };
      reload(args).then(
        (lines) => finish(lines),
        (error: unknown) =>
          finish(
            [
              `reloading settings failed: ${error instanceof Error ? error.message : String(error)}`,
            ],
            true
          )
      );
    };
  }

  // 决策 189：/compact [重点] 手动压缩——压缩期间与 Run 同样占住输入（输入排队，决策 286）；压成时的一行提示由订阅给出，
  // 没有压成时说明原因
  compactCommand(focus: string | undefined): void {
    const runtime = this.current.runtime;
    if (runtime.compact === undefined) {
      this.flow.addSystem("/compact is not available in this session");
      this.tui.requestRender();
      return;
    }
    this.running = true;
    this.updateStatus();
    this.tui.requestRender();
    // 没压成：压缩出错（failed）是报错，醒目；没有可压缩的等跳过的照常
    const settleCompact = (line: string | undefined, failed = false): void => {
      this.running = false;
      if (line !== undefined) {
        if (failed) this.flow.addAlert(`[compact] ${line}`);
        else this.flow.addSystem(`[compact] ${line}`);
      }
      this.refreshContext();
      this.collectChildCosts();
      this.updateStatus();
      this.tui.requestRender();
      this.drainQueue();
    };
    runtime.compact(focus).then(
      (outcome) => settleCompact(manualCompactionText(outcome), outcome.kind === "failed"),
      (error: unknown) =>
        settleCompact(`failed: ${error instanceof Error ? error.message : String(error)}`, true)
    );
  }

  // ---- 退出与取消（键位路由在 modal.ts）----

  // 优雅退出（S5+，裁决 033）：双击 Ctrl+C 与 /quit 共用本路径——先 stop()（dispose
  // 对称；挂起审批 fail-closed 按拒绝处理、理由逐字 APPROVAL_CANCEL_CLOSED，证据链不断；
  // 恢复菜单按 EOF 语义回 null），再回调注入的 onExit。幂等：退出恰好一次
  requestExit(): void {
    if (this.exitRequested) return;
    // 决策 482：Ctrl+C 或 /exit 时还有子 agent 在跑：先问一句（再次要求退出即算确认）
    if (!this.exitConfirmOn && !this.exitConfirmed && (this.options.agents?.running() ?? 0) > 0) {
      this.exitConfirmOn = true;
      this.updateStatus();
      this.tui.requestRender();
      return;
    }
    this.exitConfirmOn = false;
    this.exitRequested = true;
    this.stop();
    this.options.onExit?.();
  }

  // 取消入口（S5）：触发 adapter.interrupt()（固定姿势 abort → waitForIdle，注释约束 5）。
  // 重复取消防御：中断飞行中不再触发——不 double-abort、不悬挂；running 清算在
  // handleRunEnd（run() 决议承载终态），interrupt 决议只清飞行标记
  requestInterrupt(cause?: RunStopCause): void {
    if (this.interrupting) return;
    this.interrupting = true;
    // 决策 452：被打转检测等叫停的，收尾行写 stopped 与原因
    if (cause !== undefined) this.stopCause = cause;
    // 决策 323：被取消的一轮不跑 Stop 钩子（外部取消与打转叫停都算）
    this.runCancelled = true;
    // 决策 484：还在等 UserPromptSubmit 钩子的（运行面上还没开跑）钩子之后不再开跑
    this.cancelWork?.();
    // pi 惯例：中断时排队内容退回输入框，不在中断后自动发出。决策 458：在会话面板里中断当前会话时，
    // 输入框不是它的，先拿出来留着，回到主视图时再放进输入框（决策 484：换走时随会话带走，回到它时再放进输入框）
    if (this.view === "panel") this.heldQueue.push(...this.queue.clear());
    else this.restoreQueueToEditor();
    this.updateStatus();
    this.tui.requestRender();
    const settle = (error?: unknown): void => {
      this.interrupting = false;
      if (error !== undefined) {
        // interrupt 自身抛异常（装配级故障）：如实呈现，不伪装成已取消
        this.flow.addAlert(
          `[cancel] interrupt failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.updateStatus();
      this.tui.requestRender();
    };
    this.current.runtime.interrupt(cause).then(
      () => settle(),
      (error: unknown) => settle(error)
    );
  }

  // 决策 307：打转叫停——消息区写明检测到打转、重复的调用与轮数，再同 Esc 一样中断本轮（原因记为打转）；会话照常可用
  stopForLoop(text: string): void {
    this.flow.addSystem(text);
    this.requestInterrupt("looping");
  }

  // D2 可见化的 TUI 投影（S5）：会话记录写入失败非空时消息区警告——措辞与 cli repl 同口径，
  // 增量报数（同一批故障不重复刷屏，新故障以累计数提醒）；启动即查 + 每次 run 收尾复查
  private warnEvidenceGaps(): void {
    const count = this.current.runtime.listenerErrors().length;
    if (count > this.reportedListenerErrors) {
      this.flow.addAlert(`${count} session ${count === 1 ? "record" : "records"} failed to write`);
      this.reportedListenerErrors = count;
    }
  }

  // ---- 决策 323、324：会话级钩子（SessionStart / SessionEnd / Notification 与 /hooks）----

  // SessionStart：装配方在壳接管终端之前（首次）调用；补的上下文存起来当作下一条输入的前缀，
  // 消息区提示一行。source：首次启动 "startup"、续跑或换绑/重建 "resume"
  async beginSession(source: "startup" | "resume"): Promise<void> {
    this.hookContexts = [];
    const hooks = this.current.hooks;
    if (hooks === undefined || hooks.disabled) return;
    try {
      const report = await hooks.runEvent("SessionStart", source, { source });
      for (const line of report.systemMessages) this.flow.addSystem(line);
      this.hookContexts = [...report.additionalContext];
    } catch (error) {
      this.flow.addAlert(
        `SessionStart hook failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.tui.requestRender();
  }

  // SessionEnd：退出前（reason "exit"）与换绑/重建换走旧会话前（reason "switch"）调用；
  // 必须在释放运行面之前跑，记录才落在本会话文件里
  async endSession(reason: "exit" | "switch"): Promise<void> {
    const hooks = this.current.hooks;
    if (hooks === undefined || hooks.disabled) return;
    try {
      await hooks.runEvent("SessionEnd", reason, { reason });
    } catch {
      // 收尾钩子出错不挡退出（记录已在 SessionHooks 里如实落盘）
    }
  }

  // 决策 323、324：Notification（只作副作用）——审批面板出现时 permission_prompt（message 用面板提示原文）
  notifyApprovalHook(notificationType: string, message: string): void {
    const hooks = this.current.hooks;
    if (hooks === undefined || hooks.disabled) return;
    void hooks
      .runEvent("Notification", notificationType, { message, notification_type: notificationType })
      .catch(() => undefined);
  }

  // /hooks 的只读面（跟着当前会话；/resume 换绑与 /reload 重建后是新会话的面）
  hooksView(): TuiHooksFace | undefined {
    return this.current.hooks;
  }

  // 换绑（S4）：会话上下文一体替换（sessionId + 运行面 + 治理上下文），chrome 标题跟进，
  // 运行面订阅先退旧再订新；消息区内容保留（对账报告与重建说明是恢复的证据链呈现）
  rebindSession(
    sessionId: SessionId,
    binding: TuiSessionBinding,
    options: { source?: "startup" | "resume"; resumed?: boolean } = {}
  ): void {
    // 决策 458：换到别的会话时当前会话卡的摘要（首条输入、最近回复、偷看）从新会话重新记（随后画的历史一并记下）。
    // 决策 496：旧会话留给下一条输入的程序说明不带进新会话（还在干活的已随 handOff 交走）
    if (sessionId !== this.current.sessionId) {
      this.flow.resetDigest();
      this.nextInputNotes.length = 0;
    }
    this.current = {
      sessionId,
      runtime: binding.runtime,
      ...(binding.root !== undefined ? { root: binding.root } : {}),
      ...(binding.grants !== undefined ? { grants: binding.grants } : {}),
      ...(binding.hooks !== undefined ? { hooks: binding.hooks } : {}),
    };
    this.followWorkspace(binding);
    // 先换会话面再切视图（切视图时按新会话重画）
    this.showView("main");
    // 决策 323、324：换到新会话——SessionStart（缺省 source "resume"；决策 496 的 /clear、/new 用 "startup"）补的上下文归新会话；
    // 旧会话的 SessionEnd 由装配方在释放旧运行面前跑
    void this.beginSession(options.source ?? "resume");
    this.activeRunId = null;
    // S5：落盘失败警告计数随运行面一起换绑——新面的 listenerErrors 从零起算
    this.reportedListenerErrors = 0;
    this.bindRuntime(binding.runtime);
    // 决策 496：/clear、/new 的新会话从零起算（不按会话记录累计）
    this.resetCosts(sessionId, options.resumed ?? true);
    this.tui.requestRender();
  }

  // 决策 484：路径补全与 @ 引用的根跟着当前会话的工作区
  private followWorkspace(binding: TuiSessionBinding): void {
    const autocomplete = this.options.autocomplete;
    if (autocomplete === undefined || binding.workspaceRoot === undefined) return;
    setPromptAutocompleteRoot(
      this.input,
      this.promptAutocomplete ?? autocomplete,
      binding.workspaceRoot
    );
  }

  // 读会话文件渲染历史（与 /resume 同一份读取与上限）；endLine 为历史之后的分隔行（不给即不写）
  private renderHistoryInto(
    flow: MessageFlow,
    sessionId: string,
    endLine?: string,
    rootOf?: string
  ): void {
    const root = rootOf ?? this.sessionsRoot();
    if (root === undefined) return;
    try {
      const limit = this.options.historyLimit;
      const lines = loadSessionHistory(root, sessionId, limit !== undefined ? { limit } : {});
      flow.addHistory(lines);
      if (endLine !== undefined) flow.addSystem(endLine);
    } catch (error) {
      flow.addAlert(
        `rendering history failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 输入框里现在的文字（测试与命令用）
  inputText(): string {
    return this.input.getText();
  }

  // 当前视图（测试与命令用）
  currentView(): ShellView {
    return this.view;
  }

  // 切换视图：重排组件、标题与状态行跟着变；消息区整体换掉，强制全量重绘
  private showView(view: ShellView): void {
    if (view !== "agent") this.leaveAgentSession();
    if (view !== "elsewhere") this.elsewhereSession = undefined;
    // 换了视图，面板回到最上层、不选中
    this.agentPanel.reset();
    // 决策 442：离开设置视图即关它（它不可见时不能再吞键）
    if (view !== "config") this.configPanel.close();
    // 决策 471：离开续接视图即关掉列表，按没选处理
    if (view !== "resume" && this.picker.isOpen()) this.picker.close();
    this.view = view;
    // 决策 458：在面板里中断主会话时留着的排队内容，回到主视图时放进输入框（排队在前、草稿在后）
    if (view === "main" && this.heldQueue.length > 0) {
      this.input.setText(
        [...this.heldQueue.splice(0), this.input.getText()]
          .filter((text) => text.trim() !== "")
          .join("\n\n")
      );
    }
    this.title.setText(this.titleText());
    this.layout();
    this.tui.setFocus(this.input);
    this.updateStatus();
    this.tui.requestRender(true);
  }

  // 视图的按键。Ctrl+C 与审批挂起期间放给壳级键控；会话回退打开时按键全归它
  private handleScreenKey(data: string): { consume: true } | undefined {
    // 决策 492：/worktrees clean 的 y/N 问一次就作数——y 删、别的键作罢；排在别的按键之前。等着时来了审批，审批优先：
    // 按键归审批，不当成 y/N 的回答（审批答完问句还在）。y、n 与 Esc 只当回答、不进输入框；别的键作罢之后照常生效
    //（再打一条命令即作罢，命令的第一个字不丢）
    if (this.cleanConfirm && this.pendingApprovalState === null) {
      this.cleanConfirm = false;
      const face = this.options.worktrees;
      const yes = data === "y" || data === "Y";
      if (yes) {
        this.flow.addSystem(face?.confirmPending() ?? "nothing pending to confirm");
      } else {
        face?.cancelPending();
        this.flow.addSystem("cancelled");
      }
      this.updateStatus();
      this.tui.requestRender();
      if (yes || data === "n" || data === "N" || matchesKey(data, "escape")) {
        return { consume: true };
      }
    }
    // 决策 482：有子 agent 在跑时退出前的确认，排在审批、设置面板与别的按键之前：y 或 Enter 退出，别的键取消
    //（Ctrl+C 照旧归退出键）
    if (this.exitConfirmOn && data !== "\x03") {
      this.exitConfirmOn = false;
      if (data === "y" || data === "Y" || matchesKey(data, "enter")) {
        this.exitConfirmed = true;
        this.requestExit();
      } else {
        this.updateStatus();
        this.tui.requestRender();
      }
      return { consume: true };
    }
    if (data === "\x03" || this.pendingApprovalState !== null) return undefined;
    // 决策 442：设置面板开着时它独占方向键与回车
    if (this.configPanel.isOpen()) return undefined;
    // 有一方接管了 Esc（/memory edit 排队保存时）：Esc 归它，排在视图与取消键之前
    if (this.escapeCapture !== undefined && matchesKey(data, "escape")) {
      this.escapeCapture();
      return { consume: true };
    }
    // 决策 482：子 agent 面板（输入框为空时 ↓ 进入）与进入的子 agent（Esc 回去）
    if (this.agentPanel.isFocused()) {
      const handled = this.handleAgentPanelKey(data);
      if (handled !== undefined) return handled;
    }
    if (this.view === "agent") {
      if (!matchesKey(data, "escape")) return undefined;
      this.backFromAgentSession();
      return { consume: true };
    }
    if (
      this.view === "main" &&
      this.options.agents !== undefined &&
      matchesKey(data, "down") &&
      this.input.getText() === "" &&
      this.agentPanel.focus()
    ) {
      this.tui.requestRender();
      return { consume: true };
    }
    // 决策 470：输入框为空时按两下 ← 打开会话面板（主视图里）；别的键撤掉第一下
    if (this.leftOpensPanel(data)) return { consume: true };
    if (this.panelLeftAt !== undefined) {
      this.clearPanelHint();
      this.updateStatus();
    }
    // 决策 443：会话面板与进入的会话（Esc 回面板）
    if (this.view === "panel") return this.handlePanelKey(data);
    if (this.view === "elsewhere") {
      if (!matchesKey(data, "escape")) return undefined;
      this.openPanel(this.elsewhereSession?.card.id);
      return { consume: true };
    }
    // 决策 435：会话回退的消息列表
    if (this.view === "rewind") {
      this.handleMessageTreeKey(data);
      this.tui.requestRender();
      return { consume: true };
    }
    return undefined;
  }

  private handleRunEnd(result: RunResult | null, error?: unknown): void {
    this.closing = true;
    this.cancelWork = undefined;
    this.activeRunId = null;
    this.lastRun = { result, error };
    // D2 可见化（S5）：每次 run 收尾复查落盘失败（增量报数，同 repl 口径）
    this.warnEvidenceGaps();
    this.refreshContext();
    this.collectChildCosts();
    // 决策 323、324：Stop 钩子在一轮收尾后跑（拦下即接着跑新一轮）；跑完才真正空闲并发排队输入
    void this.afterRun(result);
  }

  // 决策 452：一次工作开始（空闲时人发出消息，或程序通知叫醒 agent）：记下开始时刻。continuing：上一次工作刚收尾、
  // 收尾行还没落时由通知接着跑，算同一次工作（开始时刻不变）
  private beginWork(continuing = false): void {
    if (continuing && this.workStartedAt !== null && this.lastRun !== null) return;
    this.renderWorkEnd();
    this.workStartedAt = this.now();
    this.lastRun = null;
    this.stopCause = undefined;
  }

  // 决策 452：工作真正结束（Stop 钩子与收尾都跑完、空闲下来）时落一行收尾：用时从开始算到现在，结果取最后一次运行
  private renderWorkEnd(): void {
    const last = this.lastRun;
    const startedAt = this.workStartedAt;
    const stopCause = this.stopCause;
    this.lastRun = null;
    this.workStartedAt = null;
    this.stopCause = undefined;
    if (last === null) return;
    const elapsed = startedAt !== null ? this.now() - startedAt : undefined;
    const { result, error } = last;
    if (result === null) {
      // run() 自身抛异常（装配级故障）：如实呈现，不伪装成正常终态
      const message = error instanceof Error ? error.message : String(error);
      this.flow.addWorkEnd(workEndLine({ status: "failed", errorMessage: message }, elapsed));
      return;
    }
    this.flow.addWorkEnd(
      workEndLine(
        {
          status: result.status,
          ...(stopCause !== undefined ? { ending: stopCause } : {}),
          ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
          ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
          breaker: result.failure?.category === "cancelled" && result.failure.breaker,
        },
        elapsed
      )
    );
  }

  // 一轮真正收尾：空闲下来、刷新状态并发排队输入（Stop 钩子跑完之后）。决策 446：先跑 afterTurn（换运行面），跑完才空闲
  private finishRun(): void {
    const pending = this.options.afterTurn?.({ cancelled: this.runCancelled });
    if (pending !== undefined) {
      const gen = this.workGen;
      void pending.then(
        () => {
          if (gen === this.workGen) this.finishRunNow();
        },
        (error: unknown) => {
          this.flow.addAlert(
            `finishing the turn failed: ${error instanceof Error ? error.message : String(error)}`
          );
          if (gen === this.workGen) this.finishRunNow();
        }
      );
      return;
    }
    this.finishRunNow();
  }

  private finishRunNow(): void {
    this.inflight = undefined;
    this.closing = false;
    this.cancelWork = undefined;
    this.running = false;
    this.updateStatus();
    this.tui.requestRender();
    this.drainQueue();
    // 决策 452：排队的输入已先落了收尾行；通知接着跑的算同一次工作，等它跑完再落
    if (!this.running) this.renderWorkEnd();
  }

  // 决策 323、324：一轮收尾后的 Stop 钩子。外部取消过、run 自身报错或钩子停用即直接收尾；
  // 拦下（或补了上下文）即把理由/上下文作为新一轮输入接着跑，连续拦到上限（stopHookBlockCap，
  // 缺省 8）后不再理会并提示一行。stop_hook_active 首次 false、继续后 true。
  // 出错收尾的 Run 不跑 Stop——它的通知是 StopFailure（复审 P2：与 headless 同一口径）
  private async afterRun(result: RunResult | null): Promise<void> {
    // 决策 484：开始时取定这个会话的运行面与钩子；换过手即不再接着跑、不收尾（收尾期间本不换手，这里再守一道）
    const gen = this.workGen;
    const runtime = this.current.runtime;
    try {
      // 中止收尾（含钩子 continue:false 停下的整轮）：不再跑 Stop（整体审查修复）
      if (result === null || this.runCancelled || result.status === "aborted") return;
      const hooks = this.current.hooks;
      if (hooks === undefined || hooks.disabled) return;
      if (result.status === "failed") {
        try {
          await hooks.runEvent("StopFailure", "", { error: result.errorMessage ?? "unknown" });
        } catch (error) {
          this.flow.addAlert(
            `StopFailure hook failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        return;
      }
      const cap = this.options.stopHookCap?.() ?? DEFAULT_STOP_HOOK_BLOCK_CAP;
      let stopHookActive = false;
      let blockedCount = 0;
      for (;;) {
        let report: HookEventReport;
        try {
          report = await hooks.runEvent("Stop", "", { stop_hook_active: stopHookActive });
          if (gen !== this.workGen) return;
        } catch (error) {
          this.flow.addAlert(
            `Stop hook failed: ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        for (const line of report.systemMessages) this.flow.addSystem(line);
        // continue:false 压过拦截：整个会话停止处理，不再开新一轮
        if (report.continueFalse !== undefined) return;
        const wantsContinue = report.blocked !== undefined || report.additionalContext.length > 0;
        if (!wantsContinue) return;
        if (blockedCount >= cap) {
          this.flow.addSystem(`[hooks] Stop hook blocked ${cap} times in a row; not continuing`);
          return;
        }
        blockedCount += 1;
        stopHookActive = true;
        const reason = report.blocked?.reason;
        const next = [...report.additionalContext, ...(reason !== undefined ? [reason] : [])].join(
          "\n\n"
        );
        const continuing = runtime.run(next);
        this.inflight = continuing;
        const continued = await continuing;
        if (gen !== this.workGen) return;
        this.lastRun = { result: continued };
        this.warnEvidenceGaps();
        this.refreshContext();
        this.collectChildCosts();
        this.updateStatus();
        this.tui.requestRender();
        // 续跑这一轮出错：循环停，这一轮触发 StopFailure、不再触发 Stop，终态如实记出错
        // （整体审查修复：此前只在中止时停，出错会继续触发 Stop 且可能被 stop-hook-limit 盖住）
        if (continued.status === "failed") {
          try {
            await hooks.runEvent("StopFailure", "", {
              error: continued.errorMessage ?? "unknown",
            });
          } catch (error) {
            this.flow.addAlert(
              `StopFailure hook failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          return;
        }
        // 外部取消（Esc / 打转叫停）或本轮以中断收尾：不再接着跑
        if (this.runCancelled || continued.status === "aborted") return;
      }
    } finally {
      if (gen === this.workGen) this.finishRun();
    }
  }

  private handleDelta(delta: StreamTextDelta): void {
    // 024：增量只认 runId 出处——非本 Run 的迟到/幽灵增量不进消息区
    if (this.activeRunId === null || delta.runId !== this.activeRunId) return;
    this.setWaiting(false);
    // M5 S2（决策 045）：thinking 增量单独一段弱化渲染，正文增量照常生长
    if (delta.kind === "thinking") {
      this.flow.appendThinkingDelta(delta.delta);
    } else {
      this.flow.appendDelta(delta.delta);
    }
    this.tui.requestRender();
  }

  private handleEvent(event: EventEnvelope): void {
    // 消息区的投影在 message-flow.ts；活动 Run、花费与上下文用量在此记
    if (event.kind === RuntimeEventKind.TurnStarted) {
      this.activeRunId = event.runId;
      this.turnStartedAt = event.timestamp;
      if (this.running) this.setWaiting(true);
    }
    projectRuntimeEvent(this.flow, event);
    if (event.kind === RuntimeEventKind.TurnCompleted) {
      this.setWaiting(false);
      const payload = event.payload as TurnCompletedPayload;
      // 286：主 agent 每轮的用量与价格计入本会话花费；上下文用量按最近一次回复重算
      if (payload.usage !== undefined) {
        addUsage(this.costLive, payload.usage, {
          ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
          ...(this.turnStartedAt !== undefined ? { startMs: this.turnStartedAt } : {}),
          endMs: event.timestamp,
        });
        this.refreshCost();
      }
      this.refreshContext();
    }
    this.tui.requestRender();
  }
}

// 沙箱会话在本机界面里不续接（续接要在同一容器配方里开箱）：给出命令行用法
function sandboxResumeHint(sessionId: string): string {
  return `${sessionId} is a sandbox session; resume with: pigeon --sandbox --resume ${sessionId}`;
}

function isSandboxSession(root: string, sessionId: string): boolean {
  try {
    return listRecentMainSessions(root).some(
      (session) => session.sessionId === sessionId && session.sandbox
    );
  } catch {
    return false;
  }
}

// 答完的审批收成的一行：多行（heredoc 一类的命令、多行理由）只取首行，后面写 …
export function oneLineConclusion(line: string): string {
  const lines = line.split(/\r?\n/);
  return lines.length > 1 ? `${lines[0]} …` : line;
}
