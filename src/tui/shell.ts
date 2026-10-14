// Application Shell（M2 S2，ROADMAP §M2 交付第 1 件）：pi-tui ProcessTerminal + TuiMainScreen
// 驱动的最小壳——消息区（每消息一个 Text）+ 底行输入区 + 纯 ASCII chrome（标题/状态栏）。
//
// 决策 067 拆分（零行为变化）：消息流在 message-flow.ts，审批面板与按键路由在 modal.ts，
// 斜杠命令分发在 commands.ts，worker 命令与状态行在 workers-view.ts，resume / 历史 / 换绑在
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
//   斜杠命令不排队：只读类与 /cancel、/quit 运行中照常执行，改主会话状态或工作目录的命令拒绝并说明原因、输入留在
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
// - 决策 301（编排进度）：输入框下方、状态栏之下是编排面板（worker-panel.ts，取代原先输入框上方的 worker 状态行）；Ctrl+X 或
//   /agents 切换整屏的树形视图（worker-tree.ts）；输入框为空时按 ↓ 进入面板选 worker。在面板与树形视图里回车进入 worker 的会话：
//   消息区换成它的对话（历史取自会话记录，之后实时），输入作为消息发给它，/stop 停止、/approve 补批续做，Esc 回主会话。
//   主会话在此期间照常运行（主会话的消息区在后台照常更新）；审批面板就地在当前视图弹出（写明来源），答完仍留在原处。
//   已收尾的 worker 会话只读（停在等审批的可 /approve 补批续做）。
// - 决策 304：树形视图分两种模式，Tab 切换——运行中（上面的编排树）与会话树（session-tree.ts，当前会话这一家）。会话树里
//   Enter 查看（本次运行编排器里的 worker 进入其会话，其余只读看历史，Esc 回树），r 在此续接（主会话、分支、失败重试；
//   走 /resume 同一流程）。
//   面板、树形视图与状态栏的在跑 worker 花费同源（worker-activity.ts，编排器的只读观察口）。
import {
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
import { plural, workEndLine } from "../application/format.ts";
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
import { type FamilyNode, loadSessionFamily } from "../application/session-family.ts";
import type {
  PooledSessionCard,
  PooledSessionState,
  SessionPanelSource,
} from "../application/session-pool.ts";
import { renameStoredSession } from "../application/session-rename.ts";
import { SETTINGS_RELOADED_PREFIX, SETTINGS_UNCHANGED } from "../application/settings-reload.ts";
import type { TaskItem } from "../application/task-list-tool.ts";
import {
  previousRunWorkerText,
  renderWorkerOutcome,
  resumeApprovalText,
  type WorkerActivity,
  type WorkerLifecycleEvent,
  type WorkerStatus,
} from "../application/workers-commands.ts";
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
import { openExternalUrl, PigeonAltScreen, TrimmedTranscript } from "./alt-screen.ts";
import type { ApprovalBlockLine, ApprovalPanelResult, TuiApprovalFace } from "./approval.ts";
import { ApprovalArea } from "./approval-area.ts";
import {
  lookupSlashCommand,
  rejectInWorkerSession,
  rejectWhileRunning,
  slashTokens,
} from "./command-table.ts";
import {
  type CommandsHost,
  handleSlashCommand as dispatchSlashCommand,
  type TuiGrantsContext,
  type TuiMemoryFace,
} from "./commands.ts";
import { ConfigPanel } from "./config-panel.ts";
import type { TuiHooksFace } from "./hooks-view.ts";
import { createPromptEditor, type PromptAutocomplete } from "./input-editor.ts";
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
  peerChoiceStatus,
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
import { SessionTree } from "./session-tree.ts";
import { StatusBar } from "./status-bar.ts";
import { secondary } from "./style.ts";
import { WelcomeHeader, type WelcomeInfo } from "./welcome.ts";
import { WorkerActivityTracker } from "./worker-activity.ts";
import {
  hasFadingWorkers,
  isActiveWorker,
  isBlockedWorker,
  PANEL_FADE_MS,
  PANEL_MAX_ROWS,
  WorkerPanel,
  workerStateWord,
} from "./worker-panel.ts";
import { WorkerTree } from "./worker-tree.ts";
import {
  handleCancelCommand,
  handleSpawnCommand,
  handleTakeCommand,
  refreshWorkers as refreshWorkersView,
  renderWorkersTable,
  showWorkersStatus,
  type TuiWorkersFace,
  type WorkersViewHost,
} from "./workers-view.ts";

export type { TuiGrantsContext } from "./commands.ts";
export type { TuiWorkersFace } from "./workers-view.ts";

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
  // 决策 297：worker 完成通知——待递的条数与空闲时只带通知跑一轮；缺省（替身运行面）即不支持
  pendingNotices?(): number;
  runNotices?(): Promise<RunResult>;
  // 决策 286：工具结果（展开显示与 diff）与上下文用量（状态栏）；缺省即不显示结果块、状态栏不显示上下文
  subscribeToolResults?(listener: (notice: ToolResultNotice) => void): () => void;
  contextUsage?(): { tokens: number; contextWindow: number } | undefined;
}

// /resume 换绑产物（S4）：目标会话的新运行面与新治理上下文（形状定义在 resume-view.ts）
export interface TuiSessionBinding
  extends SessionBinding<TuiRuntimeFace, TuiGrantsContext, TuiWorkersFace> {
  // 决策 323/324：目标会话的钩子面——换绑后本会话的会话级事件用它（各会话的清单随各自的快照冻结）
  hooks?: TuiHooksFace;
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
  // 决策 340：/reload 重读设置——返回给人看的行（装配方实现：重读、确认、换上新快照并重建运行面）
  reload?: (args: readonly string[]) => Promise<string[]>;
  // S5+（裁决 033）：优雅退出回调——双击 Ctrl+C / /quit 触发；壳先 stop() 再回调。
  // 注入使测试绝不真退进程；缺省 = 退出只停壳（装配方必须注入真实退出路径）
  onExit?: () => void;
  // 双击窗口（毫秒）：缺省 1000；测试注入小窗口断言过期语义
  exitWindowMs?: number;
  // M5 S2（决策 045）：/resume 历史渲染的安全上限（行）；缺省 500
  historyLimit?: number;
  // M5.5 S4（决策 040）：/spawn /cancel /workers 与状态栏 worker 行；缺省 = 命令不可用
  workers?: TuiWorkersFace;
  // worker 状态行刷新间隔（毫秒，有 worker 在跑时生效）；缺省 1000
  workerRefreshMs?: number;
  // 决策 237、245：沙箱会话——/export 手动交回；分叉、worker 与 /resume 换绑在沙箱里不支持，命令给出原因
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
  // 决策 301：编排面板最多列几行（缺省 5）、结束的 worker 多久后淡出（毫秒，缺省 30 秒）；时钟（缺省 Date.now，测试注入）
  panelMaxRows?: number;
  panelFadeMs?: number;
  now?: () => number;
  // 决策 301：树形视图按标签标出清单项用的任务清单（清单关着时返回 undefined）；缺省不标
  taskItems?: () => readonly TaskItem[] | undefined;
  // 决策 323、324：当前会话的钩子面（会话级事件与 /hooks）；缺省 = 本会话不接钩子
  hooks?: TuiHooksFace;
  // 决策 323：收尾钩子的连续拦截上限（取设置快照的 merged.stopHookBlockCap，/reload 后跟着变）；缺省 8
  stopHookCap?: () => number;
  // 决策 331：/memory 的命令面（记忆按项目与用户分层，不跟会话走）；缺省 = 命令不可用
  memory?: TuiMemoryFace;
  // 决策 448：/worktrees 的命令面（留下的 worker 工作树与分支）；缺省 = 命令不可用
  worktrees?: TuiWorktreesFace;
  // 决策 446：一轮真正收尾、空闲下来之前调用（会话移进工作树时在这里换运行面）；期间仍按在跑处理，输入排队
  // 没有要做的返回 undefined（照常同步空闲下来）
  afterTurn?: (info: { cancelled: boolean }) => Promise<void> | undefined;
  // 决策 450：忙闲变化（一轮开始、真正空闲）
  onBusyChange?: (busy: boolean) => void;
  // 决策 450、456：/rename 改当前会话的名字（记进会话记录，名录跟着改）；返回给人看的一行。缺省 = 命令不可用
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
    // 现在不能改的原因（有 worker 在跑等）；能改为 undefined
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

// 决策 301：界面所处的视图——主会话、整屏的树形视图、进入的 worker 会话
export type ShellView =
  | "main"
  | "tree"
  | "worker"
  | "history"
  | "panel"
  | "pooled"
  | "config"
  | "resume";

// 决策 469：一个会话的审批模式——取当前模式、切换（切换写一条会话记录，之后的工具调用按新模式判定）
export interface ApprovalModeControl {
  get(): "prompt" | "yolo";
  set(mode: "prompt" | "yolo"): void;
}

// 决策 443：会话面板（进程内版）：面板只经 source 取数与下指令；进入会话时直接订阅它的运行面（进程内版才有）
export interface TuiPoolFace {
  source: SessionPanelSource;
  live?(id: string):
    | (Pick<TuiRuntimeFace, "subscribe" | "subscribeStream"> &
        Partial<Pick<TuiRuntimeFace, "subscribeToolResults">> & {
          // 决策 469：面板会话自己的审批模式
          approvalMode?: ApprovalModeControl;
        })
    | undefined;
}

// 决策 443：会话面板里连按两次 Ctrl+X 停止的间隔
const PANEL_STOP_CONFIRM_MS = 1500;
// 设置面板里"被哪一层覆盖"的说法（与面板上那一项旁的标注同一口径）
const OVERRIDE_LAYER = { project: "project settings", local: "project local settings" } as const;

// 决策 304：树形视图的两种模式
export type TreeMode = "running" | "sessions" | "messages";

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

// 从哪里进入的 worker 会话或历史查看（Esc 回到那里）
type ReturnTo = { view: "main" } | { view: "tree"; mode: TreeMode };

// 沙箱会话的命令面：交回返回给人看的一行（分支名与查看命令，或失败原因）
export interface TuiSandboxFace {
  exportChanges(): Promise<string>;
}

export class PigeonTuiShell
  implements
    TuiApprovalFace,
    ModalHost,
    CommandsHost,
    WorkersViewHost,
    ResumeViewHost<TuiSessionBinding>
{
  private readonly options: TuiShellOptions;
  private readonly tui: PigeonAltScreen;
  private readonly flow = new MessageFlow();
  // 决策 454：状态行是次要信息（弱化样式）。验收修改：不带上下空行，紧贴在输入框上沿；与上方内容之间隔一行空白
  //（statusGap，窗口装不下时先让出它），状态行本身不压缩
  private readonly statusLine = new Text("", 1, 0, secondary);
  private readonly statusGap = new Spacer(1);
  // M5.5 S4（决策 040）：worker 的刷新定时器（有 worker 在跑或还有结束的在淡出期内才开）
  private workerTimerHandle: ReturnType<typeof setInterval> | null = null;
  // 决策 301：worker 活动记录（面板、树形视图与状态栏花费同源）、编排面板、树形视图与当前视图
  private readonly tracker: WorkerActivityTracker;
  private readonly panel: WorkerPanel;
  private readonly tree: WorkerTree;
  private view: ShellView = "main";
  // 决策 304：树形视图的模式、会话树、只读历史查看与 Esc 回到哪里
  private treeMode: TreeMode = "running";
  private readonly sessionTree: SessionTree;
  // 决策 435：消息树（会话回退）与双击 Esc 的上一下
  private readonly messageTree: MessageTree;
  // 决策 443：会话面板、进入的会话与连按两次 Ctrl+X 停止的上一下
  private readonly sessionPanel: SessionPanel;
  private pooledSession:
    | { id: string; flow: MessageFlow; unsubscribe: () => void; mode?: ApprovalModeControl }
    | undefined;
  // 决策 458：对当前会话的两次 Ctrl+X 须落在同一次工作上（work 为那次工作的开始时刻）
  private lastPanelStop: { id: string; at: number; work?: number | null | undefined } | undefined;
  // 决策 458：在面板里中断主会话时留着的排队内容（回到主视图时放进输入框）
  private heldQueue: string[] = [];
  // 偷看的内容（会话池的接口是异步的，取回来先存着再画）
  private readonly peekCache = new Map<string, string[]>();
  private lastIdleEscapeAt: number | undefined;
  private historySession: { sessionId: string; flow: MessageFlow } | undefined;
  private returnTo: ReturnTo = { view: "main" };
  // 决策 301、467：挂着的审批显示在底部的审批区（各视图都是；主视图里在输入框上方），不进消息流；高度上限按窗口取
  private readonly approvalBox = new ApprovalArea(() =>
    Math.max(4, this.options.terminal.rows - APPROVAL_CHROME_ROWS)
  );
  // 挂着的审批块的收起函数（答完收成一行）
  private approvalSettlers: Array<(line: string) => void> = [];
  // 进入的 worker 会话：它的会话号、消息区与活动订阅
  private workerSession:
    | { sessionId: SessionId; flow: MessageFlow; unsubscribe: () => void }
    | undefined;
  private readonly input: Editor;
  private readonly queue = new InputQueue();
  private readonly picker = new SessionPicker();
  private readonly statusBar: StatusBar;
  // 本会话花费（286）：打开或续接时从会话记录累计的已有部分 + 本次运行中主 agent 的新增 + 之后收尾的子会话
  private costBase: CostTally = emptyCostTally();
  private costLive: CostTally = emptyCostTally();
  private childCosts: ChildSessionCosts | undefined;
  private runningWorkerCount = 0;
  // 本轮开始的时刻（DeepSeek 计价看开始与结束是否落在高峰）
  private turnStartedAt: number | undefined;
  private readonly title: Text;
  // 当前会话上下文（S4）：/resume 换绑整体替换——运行面、治理上下文、sessionId 一体，
  // 绝不换一半（grants 命令与提交必须落在同一会话上）
  private current: {
    sessionId: SessionId;
    runtime: TuiRuntimeFace;
    grants?: TuiGrantsContext;
    workers?: TuiWorkersFace;
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
  private lastRun: { result: RunResult | null; error?: unknown } | null = null;
  private stopCause: RunStopCause | undefined;
  // start/stop 的 dispose 对称面：壳级监听器在此成对登记（S5 的同位置留位）；
  // 运行面订阅单独登记——/resume 换绑时只退订运行面，壳级监听（模态键控）不动
  private readonly disposers: Array<() => void> = [];
  private runtimeDisposers: Array<() => void> = [];
  private runningState = false;
  // 决策 450：忙闲变化即告诉装配方（会话名录里的忙闲、空闲通知）
  private get running(): boolean {
    return this.runningState;
  }
  private set running(value: boolean) {
    if (value === this.runningState) return;
    this.runningState = value;
    this.setWaiting(value);
    this.options.onBusyChange?.(value);
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
    if (options.workers !== undefined) this.current.workers = options.workers;
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
    this.input = createPromptEditor(
      this.tui,
      options.promptHistory?.load() ?? [],
      options.autocomplete
    );
    this.statusBar = new StatusBar({ cost: emptyCostTally() });
    // chrome 除会话名外纯 ASCII（spike 纪律：歧义宽字符不进边框/标题/状态栏）；sessionId 全 ASCII ULID。决策 456：会话名
    // 按名字规则只含字母、数字与 _ . -（不含控制字符、零宽与可忽略字符），其他文字的宽度按 pi-tui 的算法
    // 只在特殊视图里有一行，不带上下空行
    this.title = new Text("", 1, 0);
    this.title.setText(this.titleText());
    this.tracker = new WorkerActivityTracker(
      options.provider !== undefined ? { provider: options.provider } : {}
    );
    this.panel = new WorkerPanel({
      statuses: () => this.workerStatuses(),
      tracker: this.tracker,
      now: () => this.now(),
      maxRows: options.panelMaxRows ?? PANEL_MAX_ROWS,
      fadeMs: options.panelFadeMs ?? PANEL_FADE_MS,
    });
    this.tree = new WorkerTree({
      sources: () => {
        const tasks = options.taskItems?.();
        return {
          mainSessionId: this.current.sessionId,
          statuses: this.workerStatuses(),
          tracker: this.tracker,
          ...(tasks !== undefined ? { tasks } : {}),
          now: this.now(),
        };
      },
      // 标题一行、状态栏一行
      height: () => Math.max(3, this.options.terminal.rows - 2),
    });
    this.sessionTree = new SessionTree({
      height: () => Math.max(3, this.options.terminal.rows - 2),
    });
    this.sessionPanel = new SessionPanel({
      // 标题、审批框、输入框（上下边框）与状态栏
      height: () => Math.max(3, this.options.terminal.rows - 6),
      cards: () => this.options.pool?.source.list() ?? [],
      peek: (id) =>
        id === this.current.sessionId ? this.mainPeekLines() : (this.peekCache.get(id) ?? []),
      // 决策 458：当前窗口的主会话作为第一张卡
      main: () => this.mainCard(),
    });
    this.messageTree = new MessageTree({
      height: () => Math.max(3, this.options.terminal.rows - 2),
    });
    // 决策 451：欢迎头放在对话流最上方
    if (options.welcome !== undefined) this.flow.setHeader(new WelcomeHeader(options.welcome));
    this.layout();
    for (const line of keyNotices) this.flow.addSystem(line);
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.updateStatus();
  }

  // 按视图排布组件：排队内容与会话选择器在输入框上方，状态栏在输入框下方，编排面板在状态栏之下（决策 286、301）；
  // 树形视图整屏（标题、树、状态栏）；worker 会话的消息区换成它的对话，排队内容与会话选择器属于主会话，不显示
  private layout(): void {
    // 状态行紧贴在输入框上沿（没有输入框的视图里在状态栏之上），上方隔一行空白
    const status: StackChild[] = [this.statusGap, keep(this.statusLine)];
    const children: StackChild[] =
      this.view === "tree"
        ? [
            fill(
              this.treeMode === "sessions"
                ? this.sessionTree
                : this.treeMode === "messages"
                  ? this.messageTree
                  : this.tree
            ),
            keep(this.approvalBox),
            this.statusBar,
          ]
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
              : this.view === "pooled" && this.pooledSession !== undefined
                ? [
                    this.title,
                    fill(this.pooledSession.flow.view),
                    keep(this.approvalBox),
                    ...status,
                    keep(this.input),
                    this.statusBar,
                  ]
                : this.view === "history" && this.historySession !== undefined
                  ? [
                      this.title,
                      fill(this.historySession.flow.view),
                      keep(this.approvalBox),
                      ...status,
                      this.statusBar,
                    ]
                  : this.view === "worker" && this.workerSession !== undefined
                    ? [
                        this.title,
                        fill(this.workerSession.flow.view),
                        keep(this.approvalBox),
                        ...status,
                        keep(this.input),
                        this.statusBar,
                        this.panel,
                      ]
                    : [
                        fill(this.flow.view),
                        ...(this.loader !== undefined ? [this.loader] : []),
                        this.queue.view,
                        keep(this.approvalBox),
                        ...status,
                        keep(this.input),
                        this.statusBar,
                        this.panel,
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

  private workerStatuses(): WorkerStatus[] {
    return this.current.workers?.status() ?? [];
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
    // 决策 301：编排视图的按键（树形视图、面板选择、worker 会话的 Esc）排在最前；审批挂起期间与 Ctrl+C 一律放给壳级键控
    // 决策 441：全屏的搜索框开着时（它是浮层）按键一律让给它，Ctrl+C 除外
    this.disposers.push(
      this.tui.addInputListener((data) =>
        isKeyRelease(data) || this.keysToOthers(data)
          ? undefined
          : this.handleOrchestrationKey(data)
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
    refreshWorkersView(this);
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
    // 决策 294、301：worker 生命周期事件驱动编排面板——agent 派出的 worker 同样即时显示与刷新
    const unsubscribeWorkers = this.current.workers?.subscribe?.((event) => {
      if (event !== undefined) this.handleWorkerLifecycle(event);
      refreshWorkersView(this);
      this.tui.requestRender();
    });
    if (unsubscribeWorkers !== undefined) {
      this.runtimeDisposers.push(unsubscribeWorkers);
    }
    // 决策 301：worker 的运行事件、流式正文与工具结果（面板的轮数、花费与正在做什么；进入的 worker 会话实时显示）
    const unsubscribeActivity = this.current.workers?.observe?.((activity) =>
      this.handleWorkerActivity(activity)
    );
    if (unsubscribeActivity !== undefined) {
      this.runtimeDisposers.push(unsubscribeActivity);
    }
  }

  stop(): void {
    // fail-closed（决策 029）：壳停止时挂起的审批按拒绝处理、恢复菜单按 EOF 语义回 null
    closePendingModals(this);
    if (this.exitHintTimer !== undefined) {
      clearTimeout(this.exitHintTimer);
      this.exitHintTimer = undefined;
    }
    this.workerSession?.unsubscribe();
    this.leavePooledSession();
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const dispose of this.runtimeDisposers.splice(0)) dispose();
    if (this.workerTimerHandle !== null) {
      clearInterval(this.workerTimerHandle);
      this.workerTimerHandle = null;
    }
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
    // 单击 Ctrl+C 布防期间状态行只写退出提示
    if (this.exitHintOn) {
      this.statusLine.setText(EXIT_HINT);
      return;
    }
    if (this.panelLeftAt !== undefined) {
      this.statusLine.setText(PANEL_HINT);
      return;
    }
    // 决策 301：worker 会话里状态行说明这个 worker 的状态与可用的动作
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
    // 决策 443：进入的会话里状态行写它的状态与可用的动作
    if (
      this.view === "pooled" &&
      this.pooledSession !== undefined &&
      this.pendingApprovalState === null
    ) {
      const id = this.pooledSession.id;
      const card = this.options.pool?.source.list().find((item) => item.id === id);
      this.statusLine.setText(`session: ${card?.name ?? "?"} ${card?.state ?? "unknown"}`);
      return;
    }
    // 只读看历史：顶上那行已写明，状态行不再写
    if (this.view === "history" && this.pendingApprovalState === null) {
      this.statusLine.setText("");
      return;
    }
    if (
      this.view === "worker" &&
      this.workerSession !== undefined &&
      this.pendingApprovalState === null
    ) {
      this.statusLine.setText(this.workerSessionStatusText(this.workerSession.sessionId));
      return;
    }
    // 状态行纯 ASCII，只写状态词（空闲与审批挂着时不写：审批框就在眼前）；审批期间输入归模态键控，运行中与 resume 期间
    // 输入排队（决策 286）
    const base =
      this.pendingApprovalState !== null
        ? this.pendingApprovalState.peerMessage === true
          ? peerChoiceStatus(this.pendingApprovalState)
          : this.reasonModeOn
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
    // 决策 443：会话面板与进入的会话里的输入归会话面板（与主会话是否在跑无关）
    if (this.view === "panel" || (this.view === "pooled" && this.pooledSession !== undefined)) {
      this.handlePoolSubmit(value);
      this.tui.requestRender();
      return;
    }
    // 决策 301：worker 会话里的输入归这个 worker（与主会话是否在跑无关）
    if (this.view === "worker" && this.workerSession !== undefined) {
      this.handleWorkerSessionSubmit(this.workerSession.sessionId, value);
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

  // 立即提交一条输入（空闲时的回车，或空闲后从队列取出的一条）；echo 为 false 时不回显
  private submitNow(value: string, echo = true): void {
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
    if (echo) this.flow.addUserEcho(value);
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
  private async runWithHooks(value: string): Promise<void> {
    let input = value;
    const hooks = this.current.hooks;
    if (hooks !== undefined && !hooks.disabled) {
      try {
        const report = await hooks.runEvent("UserPromptSubmit", "", { prompt: value });
        for (const line of report.systemMessages) this.flow.addSystem(line);
        const blocked =
          report.blocked?.reason ??
          (report.continueFalse !== undefined
            ? (report.continueFalse.stopReason ?? "hook stopped the session")
            : undefined);
        if (blocked !== undefined) {
          this.finishRun();
          return;
        }
        const contexts = [...this.hookContexts, ...report.additionalContext];
        this.hookContexts = [];
        if (contexts.length > 0) input = `${contexts.join("\n\n")}\n\n${value}`;
      } catch (error) {
        this.flow.addAlert(
          `UserPromptSubmit hook failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const notes = this.nextInputNotes.splice(0);
    if (notes.length > 0) input = `${notes.join("\n\n")}\n\n${input}`;
    this.current.runtime.run(input).then(
      (result) => this.handleRunEnd(result),
      (error: unknown) => this.handleRunEnd(null, error)
    );
  }

  // 决策 446：一段说明随人的下一条输入前缀给模型（不开新的一轮）
  addNextInputNote(text: string): void {
    this.nextInputNotes.push(text);
  }

  // 空闲后发出排队的输入（pi 惯例逐条：一条跑完再发下一条）；即时完成的命令不占住，接着发下一条。
  // 决策 297：worker 完成通知也从这里发出——有排队的输入时先发输入，这一轮由运行面在开头带上已到的通知（通知在前、输入在后）；
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
      // 决策 452：刚收尾就有通知叫醒（换工作树后自动续一轮、worker 的结果等）算同一次工作接着跑
      this.beginWork(true);
      this.updateStatus();
      runtime.runNotices().then(
        (result) => this.handleRunEnd(result),
        (error: unknown) => this.handleRunEnd(null, error)
      );
    }
    this.tui.requestRender();
  }

  // 决策 297：worker 完成通知到来时叫醒主 agent——与排队输入同一个出口；在跑时不动，通知留在运行面上，下一轮或这一轮结束后再递
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
        this.panel.blur();
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
  // 主运行中、上一次重建还没完、或有 worker 在跑时不改（改了也重建不了），说明原因
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
  takePooled(name: string): Promise<string> | undefined {
    const source = this.options.pool?.source;
    const card = source?.list().find((item) => item.name === name);
    if (source === undefined || card === undefined) return undefined;
    return (
      source.take?.(card.id) ?? Promise.resolve("this session has no worktree; nothing to take")
    );
  }

  // 决策 443：会话面板里有没有这个名字的会话（/take 先判歧义，不取）
  hasPooled(name: string): boolean {
    return (this.options.pool?.source.list() ?? []).some((item) => item.name === name);
  }

  // 决策 443：会话面板里还开着（没停）的会话号（/resume 与会话选择器排除它们）
  pooledSessionIds(): ReadonlySet<string> {
    return new Set(
      (this.options.pool?.source.list() ?? [])
        .filter((card) => card.state !== "stopped")
        .map((card) => card.id)
    );
  }

  // 决策 458：会话面板里当前会话那张卡——名字、状态（主会话自己的审批挂着为等待回应，在跑、空闲）、首条输入与最近回复
  private mainCard(): PooledSessionCard {
    const id = this.current.sessionId;
    const digest = this.flow.digest();
    const waiting = this.pendingApprovalState?.mainWaiting;
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

  // 决策 458：偷看当前会话——在等什么，加最近几条对话
  private mainPeekLines(): string[] {
    const waiting = this.pendingApprovalState?.mainWaiting;
    return [
      ...(waiting !== undefined ? [`waiting: ${waiting}`] : []),
      ...this.flow.digest().recent,
    ];
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
    if (this.options.pool === undefined) return;
    this.panel.blur();
    this.returnTo = { view: "main" };
    // 决策 458：打开时从不偷看开始（输入框里的话派新会话，不会悄悄发给上次偷看的会话）
    this.sessionPanel.closePeek();
    if (select !== undefined) this.sessionPanel.selectId(select);
    this.showView("panel");
    this.tui.requestRender();
  }

  // 决策 470：主视图或进入的面板会话里，输入框为空时按 ←：第一下在状态行提示，短时间内再按一下才打开面板并选中刚才所在的
  // 会话（照 Claude Code，防误触）。没有面板（沙箱等）或设置关掉时不做事、不吞键
  private leftOpensPanel(data: string): boolean {
    if (
      (this.view !== "main" && this.view !== "pooled") ||
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
      this.openPanel(this.view === "pooled" ? this.pooledSession?.id : this.current.sessionId);
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
        this.returnTo = { view: "main" };
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
        this.returnTo = { view: "main" };
        this.showView("main");
        this.drainQueue();
      } else if (card !== undefined) {
        this.openPooledSession(card);
      }
    } else if (isKey(data, "pigeon.tree")) {
      this.stopFromPanel();
    } else {
      return undefined;
    }
    this.tui.requestRender();
    return { consume: true };
  }

  // 连按两次 Ctrl+X 停下选中的会话（第一次只提示）
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
    if (card.state === "stopped") {
      this.sessionPanel.setNote(`${card.name} already stopped`);
      return;
    }
    const now = Date.now();
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
      if (main) {
        this.requestInterrupt();
        return;
      }
      pool.source.stop(card.id).then(
        () => this.tui.requestRender(),
        (error: unknown) => {
          this.sessionPanel.setNote(
            `stopping ${card.name} failed: ${error instanceof Error ? error.message : String(error)}`
          );
          this.tui.requestRender();
        }
      );
      return;
    }
    this.lastPanelStop = { id: card.id, at: now, work };
    this.sessionPanel.setNote(
      main
        ? `press Ctrl+X again to interrupt ${card.name}`
        : `press Ctrl+X again to stop ${card.name}`
    );
  }

  // 会话面板里的输入：偷看时发给选中的会话（回复），否则派新会话；进入的会话里发给它
  private handlePoolSubmit(value: string): void {
    const pool = this.options.pool;
    if (pool === undefined) return;
    const pooled = this.view === "pooled" ? this.pooledSession : undefined;
    if (value.startsWith("/")) {
      const line = "slash commands don't work in the session panel";
      if (pooled !== undefined) pooled.flow.addSystem(line);
      else this.sessionPanel.setNote(line);
      this.input.setText(value);
      return;
    }
    if (pooled !== undefined) {
      void pool.source.send(pooled.id, value).then((refusal) => {
        if (refusal !== undefined) {
          pooled.flow.addSystem(refusal);
          if (this.input.getText() === "") this.input.setText(value);
        } else {
          pooled.flow.addUserEcho(value);
        }
        this.tui.requestRender();
      });
      return;
    }
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
        this.sessionPanel.selectName(card.name);
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

  // 进入会话面板里的一个会话：消息区换成它的对话（历史取自它的会话记录，之后实时投影，与主会话同一套），Esc 回面板
  private openPooledSession(card: PooledSessionCard): void {
    const pool = this.options.pool;
    if (pool === undefined) return;
    this.leavePooledSession();
    const flow = new MessageFlow();
    flow.setToolsExpanded(this.flow.toolsExpandedState());
    if (card.id.startsWith("pending:")) {
      flow.addSystem("session is still opening");
    } else {
      this.renderHistoryInto(flow, card.id, "--- live ---");
    }
    const live = pool.live?.(card.id);
    const disposers: Array<() => void> = [];
    if (live !== undefined) {
      disposers.push(
        live.subscribe((event) => {
          // 面板会话没有收尾行（决策 452），轮内出错在消息区写一行
          projectRuntimeEvent(flow, event, { turnErrors: true });
          this.updateStatus();
          this.tui.requestRender();
        }),
        live.subscribeStream((delta) => {
          if (delta.kind === "thinking") flow.appendThinkingDelta(delta.delta);
          else flow.appendDelta(delta.delta);
          this.tui.requestRender();
        })
      );
      const offResults = live.subscribeToolResults?.((notice) => {
        attachToolResultTo(flow, notice);
        this.tui.requestRender();
      });
      if (offResults !== undefined) disposers.push(offResults);
    }
    this.pooledSession = {
      id: card.id,
      flow,
      ...(live?.approvalMode !== undefined ? { mode: live.approvalMode } : {}),
      unsubscribe: () => {
        for (const dispose of disposers) dispose();
      },
    };
    this.panel.blur();
    this.showView("pooled");
    this.updateStatus();
  }

  private leavePooledSession(): void {
    this.pooledSession?.unsubscribe();
    this.pooledSession = undefined;
  }

  // 决策 435：/rewind
  get rewindCommand(): (() => void) | undefined {
    return this.options.rewind === undefined ? undefined : () => this.openRewind();
  }

  private messageTreeOpen(): boolean {
    return this.view === "tree" && this.treeMode === "messages";
  }

  // 决策 435：打开消息树（双击 Esc、/rewind、会话树里 Tab）
  openRewind(): void {
    const rewind = this.options.rewind;
    if (rewind === undefined) return;
    if (this.isBusy()) {
      this.flow.addSystem("can't rewind while running");
      this.tui.requestRender();
      return;
    }
    this.panel.blur();
    this.treeMode = "messages";
    this.messageTree.loading();
    this.showView("tree");
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
    this.returnTo = { view: "main" };
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
      if (matchesKey(data, "escape") || isKey(data, "pigeon.tree")) {
        this.closeMessageTree();
      } else if (matchesKey(data, "tab")) {
        if (this.current.workers !== undefined) this.showTree("running");
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
    this.returnTo = { view: "main" };
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

  // 决策 450：输入框为空（扣住的消息面板等它为空再弹）
  inputIsEmpty(): boolean {
    return this.input.getText().trim() === "";
  }

  // 决策 450、456：/rename（CommandsHost）
  get renameSession(): ((name: string) => string) | undefined {
    return this.options.renameSession;
  }

  private titleText(): string {
    // 验收修改：主视图不显示标题行；worker、只读历史与面板会话里留一行很短的弱化说明——在哪、怎么回去（这里没有它会不知道
    // 自己在哪、为什么没有输入框），不写会话号
    const session = this.workerSession;
    if (this.view === "worker" && session !== undefined) {
      const worker = this.workerStatuses().find((status) => status.sessionId === session.sessionId);
      return secondary(`worker ${worker?.name ?? "?"} · esc to go back`);
    }
    if (this.view === "history" && this.historySession !== undefined) {
      return secondary("history · read only · esc to go back");
    }
    if (this.view === "pooled" && this.pooledSession !== undefined) {
      const id = this.pooledSession.id;
      const card = this.options.pool?.source.list().find((item) => item.id === id);
      return secondary(`session ${card?.name ?? "?"} · esc to go back to the panel`);
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

  // ---- 决策 286：排队接口（编排一段在"下一轮发什么"处接入 worker 完成通知）----

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

  // 决策 469：当前会话的审批模式——进入的面板会话是它自己的，其余视图是主会话的
  private modeControl(): ApprovalModeControl | undefined {
    if (this.view === "pooled") return this.pooledSession?.mode;
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
      this.workerSession?.flow.setToolsExpanded(expanded);
      this.pooledSession?.flow.setToolsExpanded(expanded);
      this.historySession?.flow.setToolsExpanded(expanded);
      this.tui.requestRender();
      return { consume: true };
    }
    // 决策 443：面板与进入的会话里不动主会话排队的内容
    if (
      isKey(data, "pigeon.dequeue") &&
      this.queue.size() > 0 &&
      this.view !== "panel" &&
      this.view !== "pooled"
    ) {
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
    // 决策 301：在跑 worker 的实时花费（与面板同源）；收尾后由会话记录计入的不再另算
    const children = this.childCosts;
    mergeCostTally(
      total,
      this.tracker.uncountedTotal((sessionId) => children?.isCollected(sessionId) === true)
    );
    this.statusBar.update({ cost: total });
  }

  // 打开或续接会话时重置花费：续接从会话记录累计已有花费（主会话、其 worker 与复盘）
  private resetCosts(sessionId: SessionId, resumed: boolean): void {
    const root = this.options.sessions?.root;
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

  // 收尾了的 worker 与复盘会话的花费（运行收尾、压缩、worker 收尾时查）
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
    const root = this.options.resume?.root;
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
    this.panel.blur();
    this.showView("resume");
  }

  // ---- S3 审批面板（TuiApprovalFace 实现；交互语义在 modal.ts）----

  askApproval(request: ApprovalRequest, directoryGrant?: boolean): Promise<ApprovalPanelResult> {
    // 决策 301：就地弹出——在树形视图、面板或 worker 会话里时不切走，面板写明来源，答完仍留在原处
    this.clearApprovalBox();
    return askApprovalPanel(this, request, directoryGrant);
  }

  // 审批答完（handler 在决议后调用）：挂着的审批块收成这一行结论
  noteApproval(line: string): void {
    this.settleApproval(line);
  }

  // 挂着的审批块：显示在底部的审批区（决策 467，各视图都是），不进消息流；记下答完时写结论行的地方——主会话的消息流，
  // 在 worker 会话里同时写进它的消息流
  addApprovalBlock(text: string, lines?: readonly ApprovalBlockLine[]): void {
    // 决策 472：分好类的各行由审批区上色画框；没给（替身等）即整块按细节显示
    this.approvalBox.setBlock(
      lines ?? text.split("\n").map((line) => ({ kind: "detail" as const, text: line }))
    );
    const flows = [this.flow];
    if (this.view === "worker" && this.workerSession !== undefined) {
      flows.push(this.workerSession.flow);
    }
    this.approvalSettlers = flows.map((flow) => (line: string) => flow.addConclusion(line));
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
    if (this.view === "worker" && this.workerSession !== undefined) {
      this.workerSession.flow.addSystem(line);
    }
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
    if (pending === null) this.clearApprovalBox();
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

  workers(): TuiWorkersFace | undefined {
    return this.current.workers;
  }

  resumeConfigured(): boolean {
    return this.options.resume !== undefined;
  }

  sandbox(): TuiSandboxFace | undefined {
    return this.options.sandbox;
  }

  resumeOptions(): ResumeOptions<TuiSessionBinding> | undefined {
    return this.options.resume;
  }

  historyLimit(): number | undefined {
    return this.options.historyLimit;
  }

  hasRunningWorkers(): boolean {
    return this.current.workers?.status().some((worker) => worker.state === "running") === true;
  }

  setResuming(resuming: boolean): void {
    this.resuming = resuming;
    // /resume 流程收尾（成败皆然）后发出排队的输入；延到本轮调用栈之后，让流程先写完收尾行
    if (!resuming) queueMicrotask(() => this.drainQueue());
  }

  // worker 状态刷新（生命周期事件、命令与定时器）：收尾（在跑的个数减少）时把其花费由会话记录计入本会话
  workersRefreshed(workers: readonly WorkerStatus[]): void {
    // 面板淡出按收尾时刻：生命周期事件没带到的（编排面不发事件时），以第一次看到它已收尾的时刻为准
    for (const status of workers) {
      if (!isActiveWorker(status) && this.tracker.get(status.sessionId)?.settledAt === undefined) {
        this.tracker.settled(status.sessionId, this.now());
      }
    }
    const running = workers.filter((w) => w.state === "running").length;
    if (running < this.runningWorkerCount) this.collectChildCosts();
    else this.refreshCost();
    this.runningWorkerCount = running;
    if (this.view === "worker") this.updateStatus();
  }

  // 定时刷新（面板的耗时在走、结束的到点淡出）：有在跑或排队的，或还有结束的在淡出期内
  workersNeedTicking(workers: readonly WorkerStatus[]): boolean {
    return (
      workers.some(isActiveWorker) ||
      hasFadingWorkers(workers, this.tracker, this.now(), this.options.panelFadeMs ?? PANEL_FADE_MS)
    );
  }

  workerActivity(): WorkerActivityTracker {
    return this.tracker;
  }

  clock(): number {
    return this.now();
  }

  workerTimer(): ReturnType<typeof setInterval> | null {
    return this.workerTimerHandle;
  }

  setWorkerTimer(timer: ReturnType<typeof setInterval> | null): void {
    this.workerTimerHandle = timer;
  }

  workerRefreshMs(): number {
    return this.options.workerRefreshMs ?? 1000;
  }

  spawnCommand(workers: TuiWorkersFace, raw: string): void {
    handleSpawnCommand(this, workers, raw);
  }

  cancelCommand(workers: TuiWorkersFace, ref: string | undefined): void {
    handleCancelCommand(this, workers, ref);
  }

  takeCommand(workers: TuiWorkersFace, name: string | undefined): void {
    handleTakeCommand(this, workers, name);
  }

  workersStatusCommand(workers: TuiWorkersFace): void {
    showWorkersStatus(this, workers);
  }

  // /resume：不带会话号弹出选择器（286）；沙箱会话不在本机界面里续接，说明用法
  resumeCommand(arg: string | undefined): void {
    if (arg === undefined) {
      this.openSessionPicker();
      return;
    }
    const root = this.options.resume?.root;
    if (root !== undefined && isSandboxSession(root, arg)) {
      this.flow.addSystem(sandboxResumeHint(arg));
      return;
    }
    dispatchResumeCommand(this, arg);
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
    // pi 惯例：中断时排队内容退回输入框，不在中断后自动发出。决策 458：在会话面板（或进入的面板会话）里中断主会话时，
    // 输入框不是主会话的，先拿出来留着，回到主视图时再放进输入框
    if (this.view === "panel" || this.view === "pooled") this.heldQueue.push(...this.queue.clear());
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

  // 决策 323、324：Notification（只作副作用）——审批面板出现时 permission_prompt；
  // worker 的请示汇到本会话时另记 worker_approval（message 用面板提示原文）
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
  rebindSession(sessionId: SessionId, binding: TuiSessionBinding): void {
    // 决策 301：换到另一个会话——worker 记录属于原会话的编排器，清掉并回到主会话视图
    this.leaveWorkerSession();
    this.tracker.clear();
    // 决策 458：换到别的会话时当前会话卡的摘要（首条输入、最近回复、偷看）从新会话重新记（随后画的历史一并记下）
    if (sessionId !== this.current.sessionId) this.flow.resetDigest();
    this.current = {
      sessionId,
      runtime: binding.runtime,
      ...(binding.grants !== undefined ? { grants: binding.grants } : {}),
      ...(binding.workers !== undefined ? { workers: binding.workers } : {}),
      ...(binding.hooks !== undefined ? { hooks: binding.hooks } : {}),
    };
    // 先换会话面再切视图（切视图时按新会话重画）
    this.showView("main");
    // 决策 323、324：换到新会话——SessionStart（source "resume"）补的上下文归新会话；
    // 旧会话的 SessionEnd 由装配方在释放旧运行面前跑
    void this.beginSession("resume");
    this.activeRunId = null;
    // S5：落盘失败警告计数随运行面一起换绑——新面的 listenerErrors 从零起算
    this.reportedListenerErrors = 0;
    this.bindRuntime(binding.runtime);
    this.resetCosts(sessionId, true);
    refreshWorkersView(this);
    this.tui.requestRender();
  }

  // ---- 决策 301：编排面板、树形视图与进入 worker 会话 ----

  // 当前视图（测试与命令用）
  currentView(): ShellView {
    return this.view;
  }

  // 切换视图：重排组件、标题与状态行跟着变；消息区整体换掉，强制全量重绘
  private showView(view: ShellView): void {
    if (view !== "pooled") this.leavePooledSession();
    // 决策 442：离开设置视图即关它（它不可见时不能再吞键）
    if (view !== "config") this.configPanel.close();
    // 决策 471：离开续接视图（切到树形视图等）即关掉列表，按没选处理
    if (view !== "resume" && this.picker.isOpen()) this.picker.close();
    if (view !== "worker") this.leaveWorkerSession();
    if (view !== "history") this.historySession = undefined;
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

  // /agents 与 Ctrl+X：打开或关上树形视图（没有编排面时说明）
  toggleTree(): void {
    if (this.current.workers === undefined) {
      this.flow.addSystem("workers are not available in this session");
      this.tui.requestRender();
      return;
    }
    this.panel.blur();
    if (this.view === "tree") {
      this.showView("main");
      return;
    }
    // /agents 与 Ctrl+X 进运行中模式
    this.treeMode = "running";
    this.showView("tree");
  }

  // 决策 304：回到树形视图的某个模式（会话树每次进入都重读这一家）
  private showTree(mode: TreeMode): void {
    this.treeMode = mode;
    if (mode === "sessions") this.loadSessionTree();
    this.showView("tree");
  }

  private loadSessionTree(): void {
    const root = this.options.sessions?.root;
    if (root === undefined) {
      this.sessionTree.fail("session tree is not available in this session");
      return;
    }
    try {
      this.sessionTree.load(loadSessionFamily(sessionsDirOf(root), this.current.sessionId));
    } catch (error) {
      this.sessionTree.fail(
        `reading session tree failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 会话树里 Enter：本次运行编排器里的 worker 进入其会话（实时加历史），其余只读看历史
  private viewFamilyNode(node: FamilyNode): void {
    if (node.kind === "unreadable") {
      this.sessionTree.setNote("can't read this session");
      return;
    }
    this.returnTo = { view: "tree", mode: "sessions" };
    if (
      node.kind === "worker" &&
      this.workerStatuses().some((status) => status.sessionId === node.sessionId)
    ) {
      this.openWorkerSession(node.sessionId as SessionId, this.returnTo);
      return;
    }
    this.openHistory(node.sessionId);
  }

  // 只读的历史查看（任意会话）：与进入 worker 会话同一份历史渲染，没有输入框，Esc 回到进入的地方
  private openHistory(sessionId: string): void {
    const flow = new MessageFlow();
    flow.setToolsExpanded(this.flow.toolsExpandedState());
    this.renderHistoryInto(flow, sessionId, "--- end of history ---");
    this.historySession = { sessionId, flow };
    this.showView("history");
  }

  // 读会话文件渲染历史（与 /resume 同一份读取与上限）
  private renderHistoryInto(flow: MessageFlow, sessionId: string, endLine: string): void {
    const root = this.options.sessions?.root;
    if (root === undefined) return;
    try {
      const limit = this.options.historyLimit;
      const lines = loadSessionHistory(root, sessionId, limit !== undefined ? { limit } : {});
      flow.addHistory(lines);
      flow.addSystem(endLine);
    } catch (error) {
      flow.addAlert(
        `rendering history failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 会话树里 r：在此续接——只对主会话、分支与失败重试，走 /resume 同一流程；说明写在树下方
  private resumeFamilyNode(node: FamilyNode): void {
    const refusal =
      node.kind === "review"
        ? "review sessions can't be resumed"
        : node.kind === "worker"
          ? "worker sessions can't be resumed here"
          : node.kind === "fork"
            ? "forks of unknown kind can't be resumed"
            : node.kind === "unreadable"
              ? "can't read this session"
              : node.sessionId === this.current.sessionId
                ? "can't resume the current session"
                : this.isBusy()
                  ? resumeWhileRunningText()
                  : !this.resumeConfigured()
                    ? "resume is not available in this session"
                    : undefined;
    if (refusal !== undefined) {
      this.sessionTree.setNote(refusal);
      return;
    }
    const root = this.options.resume?.root;
    if (root !== undefined && isSandboxSession(root, node.sessionId)) {
      this.sessionTree.setNote(sandboxResumeHint(node.sessionId));
      return;
    }
    this.returnTo = { view: "main" };
    this.showView("main");
    dispatchResumeCommand(this, node.sessionId);
  }

  // 进入 worker 的会话：消息区换成它的对话——历史取自它的会话记录（与 /resume 同一份渲染），之后的运行事件、流式正文与
  // 工具结果实时投影（与主会话同一套投影）
  openWorkerSession(sessionId: SessionId, returnTo: ReturnTo = { view: "main" }): void {
    const status = this.workerStatuses().find((worker) => worker.sessionId === sessionId);
    if (status === undefined) return;
    this.leaveWorkerSession();
    this.returnTo = returnTo;
    const flow = new MessageFlow();
    flow.setToolsExpanded(this.flow.toolsExpandedState());
    this.renderHistoryInto(flow, sessionId, "--- live ---");
    if (status.outcome !== undefined) flow.addSystem(renderWorkerOutcome(status.outcome));
    const unsubscribe = this.tracker.listen((activity) => {
      if (activity.worker.sessionId !== sessionId) return;
      if (activity.kind === "event") {
        projectRuntimeEvent(flow, activity.event);
      } else if (activity.kind === "delta") {
        if (activity.delta.kind === "thinking") flow.appendThinkingDelta(activity.delta.delta);
        else flow.appendDelta(activity.delta.delta);
      } else {
        attachToolResultTo(flow, activity.result);
      }
    });
    this.workerSession = { sessionId, flow, unsubscribe };
    this.panel.blur();
    this.showView("worker");
  }

  private leaveWorkerSession(): void {
    this.workerSession?.unsubscribe();
    this.workerSession = undefined;
  }

  private workerSessionStatusText(sessionId: SessionId): string {
    const status = this.workerStatuses().find((worker) => worker.sessionId === sessionId);
    if (status === undefined) return "worker: unknown";
    return `worker: ${status.name} ${isBlockedWorker(status) ? "waiting for approval" : workerStateWord(status)}`;
  }

  // 生命周期：面板淡出与续做的记账；进入的 worker 会话里写上收尾摘要与续做
  private handleWorkerLifecycle(event: WorkerLifecycleEvent): void {
    if (event.kind === "worker.settled") {
      this.tracker.settled(event.worker.sessionId, event.at);
    } else if (event.kind === "worker.resumed") {
      this.tracker.resumed(event.worker.sessionId);
    }
    const session = this.workerSession;
    if (session === undefined || session.sessionId !== event.worker.sessionId) return;
    if (event.kind === "worker.settled") {
      session.flow.addSystem(renderWorkerOutcome(event.outcome));
    } else if (event.kind === "worker.blocked") {
      session.flow.addSystem(`== worker waiting for approval: ${event.action} ==`);
    }
    this.updateStatus();
  }

  // worker 活动：记下（面板、树形视图、状态栏花费）并转给进入的 worker 会话；轮次收尾时刷新花费
  private handleWorkerActivity(activity: WorkerActivity): void {
    this.tracker.record(activity);
    if (activity.kind === "event" && activity.event.kind === RuntimeEventKind.TurnCompleted) {
      this.refreshCost();
    }
    this.tui.requestRender();
  }

  // 编排视图的按键。Ctrl+C 与审批挂起期间放给壳级键控；树形视图打开时按键全归它
  private handleOrchestrationKey(data: string): { consume: true } | undefined {
    if (data === "\x03" || this.pendingApprovalState !== null) return undefined;
    // 决策 442：设置面板开着时它独占方向键与回车，编排视图的入口（↓ 进 worker 面板等）不响应；切换树形视图照常（切过去即关面板）
    if (
      this.configPanel.isOpen() &&
      (this.configPanel.busyWithInput() || !isKey(data, "pigeon.tree"))
    ) {
      return undefined;
    }
    // 有一方接管了 Esc（/memory edit 排队保存时）：Esc 归它，排在视图与取消键之前
    if (this.escapeCapture !== undefined && matchesKey(data, "escape")) {
      this.escapeCapture();
      return { consume: true };
    }
    // 决策 470：输入框为空时按两下 ← 打开会话面板（主视图与进入的面板会话里）；别的键撤掉第一下
    if (this.leftOpensPanel(data)) return { consume: true };
    if (this.panelLeftAt !== undefined) {
      this.clearPanelHint();
      this.updateStatus();
    }
    // 决策 443：会话面板与进入的会话（Esc 回面板）
    if (this.view === "panel") return this.handlePanelKey(data);
    if (this.view === "pooled") {
      if (!matchesKey(data, "escape")) return undefined;
      this.openPanel(this.pooledSession?.id);
      return { consume: true };
    }
    // 决策 435：消息树不依赖 worker 编排面
    if (this.view === "tree" && this.treeMode === "messages") {
      this.handleMessageTreeKey(data);
      this.tui.requestRender();
      return { consume: true };
    }
    const workers = this.current.workers;
    if (workers === undefined) return undefined;
    if (this.view === "tree" && this.treeMode === "sessions") {
      if (matchesKey(data, "escape") || isKey(data, "pigeon.tree")) {
        this.returnTo = { view: "main" };
        this.showView("main");
      } else if (matchesKey(data, "tab")) {
        // 决策 435：有会话回退时依次是运行中、会话树、消息树
        if (this.options.rewind !== undefined) this.openRewind();
        else this.showTree("running");
      } else if (matchesKey(data, "up")) {
        this.sessionTree.move(-1);
      } else if (matchesKey(data, "down")) {
        this.sessionTree.move(1);
      } else if (matchesKey(data, "enter")) {
        const selected = this.sessionTree.selected();
        if (selected !== undefined) this.viewFamilyNode(selected);
      } else if (data === "r" || data === "R") {
        const selected = this.sessionTree.selected();
        if (selected !== undefined) this.resumeFamilyNode(selected);
      }
      this.tui.requestRender();
      return { consume: true };
    }
    if (this.view === "history") {
      if (matchesKey(data, "escape")) {
        this.goBack();
        return { consume: true };
      }
      // Ctrl+O 交给视图按键；其余按键吞掉（只读）
      return isKey(data, "pigeon.toggleToolOutput") ? undefined : { consume: true };
    }
    if (this.view === "tree") {
      if (matchesKey(data, "escape") || isKey(data, "pigeon.tree")) {
        this.returnTo = { view: "main" };
        this.showView("main");
      } else if (matchesKey(data, "tab")) {
        this.showTree("sessions");
      } else if (matchesKey(data, "up")) {
        this.tree.move(-1);
      } else if (matchesKey(data, "down")) {
        this.tree.move(1);
      } else if (matchesKey(data, "right")) {
        this.tree.setExpanded(true);
      } else if (matchesKey(data, "left")) {
        this.tree.setExpanded(false);
      } else if (matchesKey(data, "space")) {
        this.tree.toggleExpanded();
      } else if (matchesKey(data, "enter")) {
        const selected = this.tree.selected();
        if (selected !== undefined) {
          this.openWorkerSession(selected, { view: "tree", mode: "running" });
        }
      } else if (data === "x") {
        const selected = this.tree.selected();
        if (selected !== undefined) this.stopWorker(selected, (line) => this.flow.addSystem(line));
      }
      this.tui.requestRender();
      return { consume: true };
    }
    if (this.panel.isFocused()) {
      if (matchesKey(data, "up")) {
        this.panel.move(-1);
      } else if (matchesKey(data, "down")) {
        this.panel.move(1);
      } else if (matchesKey(data, "escape")) {
        this.panel.blur();
      } else if (matchesKey(data, "enter")) {
        const selected = this.panel.selected();
        if (selected !== undefined) this.openWorkerSession(selected.sessionId);
      } else if (data === "x" || data === "X") {
        const selected = this.panel.selected();
        if (selected !== undefined) {
          this.stopWorker(selected.sessionId, (line) => this.activeFlow().addSystem(line));
        }
      } else {
        // 其余按键：离开面板、交回输入框照常处理
        this.panel.blur();
        this.tui.requestRender();
        return undefined;
      }
      this.tui.requestRender();
      return { consume: true };
    }
    if (isKey(data, "pigeon.tree")) {
      this.toggleTree();
      return { consume: true };
    }
    if (this.view === "worker" && matchesKey(data, "escape")) {
      this.goBack();
      return { consume: true };
    }
    // 输入框为空时按 ↓ 进入面板（Claude Code 惯例）；会话选择器打开时不抢
    if (
      matchesKey(data, "down") &&
      this.input.getText() === "" &&
      !this.picker.isOpen() &&
      this.panel.focus()
    ) {
      this.tui.requestRender();
      return { consume: true };
    }
    return undefined;
  }

  // Esc：从 worker 会话或历史查看回到进入它的地方（主会话，或树形视图的某个模式）
  private goBack(): void {
    const back = this.returnTo;
    this.returnTo = { view: "main" };
    if (back.view === "tree") this.showTree(back.mode);
    else this.showView("main");
  }

  // 当前显示的消息区（worker 会话里是它的对话）
  private activeFlow(): MessageFlow {
    return this.view === "worker" && this.workerSession !== undefined
      ? this.workerSession.flow
      : this.flow;
  }

  // 停止一个 worker（面板与树形视图的 x、worker 会话里的 /stop）：走编排器的取消，收尾照常
  private stopWorker(sessionId: SessionId, write: (line: string) => void): void {
    const workers = this.current.workers;
    const status = this.workerStatuses().find((worker) => worker.sessionId === sessionId);
    if (workers === undefined || status === undefined) return;
    // 续接后找回的之前运行的 worker：不在本进程运行
    if (status.previousRun !== undefined) {
      write(previousRunWorkerText(status, "cancel"));
      return;
    }
    if (!isActiveWorker(status)) {
      write(`worker ${status.name} already finished (${workerStateWord(status)})`);
      return;
    }
    workers.cancel(sessionId).then(
      () => {
        refreshWorkersView(this);
        this.tui.requestRender();
      },
      (error: unknown) => {
        write(
          `stopping worker ${status.name} failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.tui.requestRender();
      }
    );
  }

  // worker 会话里的输入：斜杠命令按命令表（只放行 worker 会话里能用的），其余作为消息——在跑的递进它的下一轮，
  // 已收尾的带着这段话接着做
  private handleWorkerSessionSubmit(sessionId: SessionId, value: string): void {
    const session = this.workerSession;
    const workers = this.current.workers;
    if (session === undefined || workers === undefined) return;
    const flow = session.flow;
    const status = this.workerStatuses().find((worker) => worker.sessionId === sessionId);
    if (status === undefined) return;
    if (value.startsWith("/")) {
      const rejection = rejectInWorkerSession(value);
      if (rejection !== undefined) {
        this.input.setText(value);
        flow.addSystem(rejection);
        return;
      }
      flow.addUserEcho(value);
      const tokens = slashTokens(value);
      const name = lookupSlashCommand(tokens)?.name;
      if (name === "stop") {
        this.stopWorker(sessionId, (line) => flow.addSystem(line));
      } else if (name === "approve") {
        if (status.previousRun !== undefined) {
          flow.addSystem(previousRunWorkerText(status, "resume"));
          return;
        }
        this.approveWorker(status, value.trim().slice("/approve".length).trim(), flow);
      } else if (name === "agents") {
        this.toggleTree();
      } else if (name === "workers") {
        flow.addSystem(renderWorkersTable(workers.status(), this.tracker, this.now()));
      } else if (name === "tasks") {
        flow.addSystem(this.tasks?.() ?? "task list is off");
      } else if (name === "quit") {
        this.requestExit();
      }
      return;
    }
    // 续接后找回的之前运行的 worker：只读，话留在输入框
    if (status.previousRun !== undefined) {
      this.input.setText(value);
      flow.addSystem(previousRunWorkerText(status, "send"));
      return;
    }
    // 已收尾的 worker 会话只读：发话不续做，话留在输入框（停在等审批的用 /approve 补批续做）
    if (!isActiveWorker(status)) {
      this.input.setText(value);
      flow.addSystem(
        isBlockedWorker(status)
          ? `${WORKER_ENDED_READ_ONLY}; waiting for approval`
          : WORKER_ENDED_READ_ONLY
      );
      return;
    }
    flow.addUserEcho(value);
    if (workers.send === undefined) {
      flow.addSystem("messaging workers is not supported");
      return;
    }
    workers.send(sessionId, value).then(
      (result) => {
        if (result !== "delivered") {
          flow.addAlert(`not delivered: worker ${status.name} has ended or is finishing`);
        }
        this.tui.requestRender();
      },
      (error: unknown) => {
        flow.addAlert(
          `sending message failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.tui.requestRender();
      }
    );
  }

  // /approve [话]：补批停在等审批的 worker，放行它重新发起的同一个调用并接着做（编排一段的补批续做）
  private approveWorker(status: WorkerStatus, extra: string, flow: MessageFlow): void {
    const blocked = status.outcome?.blocked;
    if (!isBlockedWorker(status) || blocked === undefined) {
      flow.addSystem(`worker ${status.name} is not waiting for approval`);
      return;
    }
    this.resumeWorker(
      status,
      {
        approve: true,
        ...(extra !== "" ? { message: `${resumeApprovalText(blocked.action)}\n${extra}` } : {}),
      },
      flow
    );
  }

  private resumeWorker(
    status: WorkerStatus,
    options: { approve?: boolean; message?: string },
    flow: MessageFlow
  ): void {
    const workers = this.current.workers;
    if (workers?.resume === undefined) {
      flow.addSystem("resuming workers is not supported");
      return;
    }
    try {
      workers.resume(status.sessionId, options);
    } catch (error) {
      flow.addAlert(
        `resuming worker failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    refreshWorkersView(this);
  }

  private handleRunEnd(result: RunResult | null, error?: unknown): void {
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
      void pending.then(
        () => this.finishRunNow(),
        (error: unknown) => {
          this.flow.addAlert(
            `finishing the turn failed: ${error instanceof Error ? error.message : String(error)}`
          );
          this.finishRunNow();
        }
      );
      return;
    }
    this.finishRunNow();
  }

  private finishRunNow(): void {
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
        const continued = await this.current.runtime.run(next);
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
      this.finishRun();
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
    // 消息区的投影与进入的 worker 会话共用（message-flow.ts）；活动 Run、花费与上下文用量在此记
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

// 决策 304：主 agent 运行中按 r 在此续接——同 /resume 运行中被拒
function resumeWhileRunningText(): string {
  return "can't resume while running";
}

// 决策 301：已收尾的 worker 会话只读
export const WORKER_ENDED_READ_ONLY = "worker has ended; read-only";

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
