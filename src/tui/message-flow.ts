// 消息流（决策 067 拆分自 shell.ts，零行为变化）：每条消息一个 Text（spike 铁律——未变消息渲染
// O(1) 命中缓存，流式只重折行尾巴）。工具行按 toolCallId 索引原位更新，一行呈现「提议 → 结果」的完整生命周期。
// 决策 036：本类是消息区唯一 Text 创建/setText 入口，半信任内容（模型流式文本、工具参数摘要、审批块、
// 错误消息）携带的终端控制序列在此统一净化——pi-tui 的 Text 按设计保留并直通 ANSI/OSC/APC（M2 审计 P2-1），
// 故净化必须发生在进 Text 之前；幂等，流式累积文本每帧重净化是安全的。
// 决策 286：工具结果显示在调用行下方，与调用行同一个 Text（仍是每消息一个 Text）；结果块缺省收起，
// setToolsExpanded 一次切换全部（Ctrl+O），此后到达的结果按当前状态显示。
// 决策 301：运行事件在消息区的投影（projectRuntimeEvent）由主会话与进入的 worker 会话共用，同一套措辞。
import { pathToFileURL } from "node:url";
import {
  type Component,
  Container,
  getCapabilities,
  hyperlink,
  Image,
  Markdown,
  ScrollView,
  Text,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText, summarizeArgs } from "../application/format.ts";
import type { HistoryLine } from "../application/history.ts";
import type { EventEnvelope } from "../state/events.ts";
import {
  RuntimeEventKind,
  type ToolProposedPayload,
  type ToolSettledPayload,
  type TurnCompletedPayload,
} from "../state/runtime-events.ts";
import { MARKDOWN_OPTIONS, MARKDOWN_THEME } from "./markdown-theme.ts";
import { clipToWidth } from "./status-bar.ts";
import { failureMark, secondary } from "./style.ts";
import { diffOfDetails, type ToolResultView, toolResultBody } from "./tool-output.ts";

// thinking 段视觉弱化（M5 S2，决策 045）：暗色由壳的受信代码在 pi-tui 补齐行宽后逐行包裹；
// 内容在进 Text 前已经 036 净化，模型文本里的控制序列此时已惰性化，这里的 SGR 不来自模型。
// 决策 454：与其他次要信息同一个样式函数（style.ts 的 secondary）

// 决策 458：偷看当前会话时显示的最近几条对话
const RECENT_LINES = 6;

export class MessageFlow {
  // Container 承载任意多 Text child；ScrollView 恰好包一个 child（决策 028：main-screen 下
  // 裁剪/follow 由终端 scrollback 实现，ScrollView 声明意图并兼容 alt-screen 布局引擎）
  readonly view: ScrollView;
  private readonly list = new Container();
  // 决策 439：模型回复的正文段用 Markdown 渲染（流式时每帧整段 setText，pi-tui 按文本与宽度缓存）
  private streamTail: Markdown | null = null;
  private streamText = "";
  // M5 S2（决策 045）：thinking 流式段——与正文尾巴分开，谁的增量到了谁开段（同 035 懒创建）
  private thinkingTail: Text | null = null;
  private thinkingText = "";
  private readonly toolLines = new Map<string, ToolEntry>();
  private toolsExpanded = false;
  // 决策 451：对话流最上方的欢迎头（随消息滚动；清空消息区时留着）
  private header: Component | undefined;
  // 决策 458：会话面板里当前会话那张卡用的摘要——首条输入（斜杠命令不算）、最近一条回复的全文、最近几条对话（偷看用；
  // 流式回复原位更新最后一条）
  private firstInput: string | undefined;
  private lastReply = "";
  private recent: string[] = [];

  constructor() {
    this.view = new ScrollView(this.list, { follow: "end", primary: true });
  }

  private append(text: string, style?: (line: string) => string): Text {
    const line = new Text(linkify(sanitizeTerminalText(text)), 1, 1, style);
    this.list.addChild(line);
    return line;
  }

  // 模型回复正文：先净化，再交给 Markdown
  private appendMarkdown(text: string): Markdown {
    const block = new Markdown(
      sanitizeTerminalText(text),
      1,
      1,
      MARKDOWN_THEME,
      undefined,
      MARKDOWN_OPTIONS
    );
    this.list.addChild(block);
    return block;
  }

  // 弱化段（thinking 与收尾行）：同样先净化，再由受信的逐行样式函数加暗色
  private appendDim(text: string): Text {
    const line = new Text(sanitizeTerminalText(text), 1, 1, secondary);
    this.list.addChild(line);
    return line;
  }

  // 决策 451：放欢迎头——总在最上方
  setHeader(header: Component): void {
    if (this.header !== undefined) this.list.removeChild(this.header);
    this.header = header;
    this.list.children.unshift(header);
    this.list.invalidate();
  }

  // 决策 452：一次工作结束的收尾行（次要信息的弱化样式）
  addWorkEnd(line: string): void {
    this.appendDim(line);
  }

  private remember(line: string, replaceLast = false): void {
    if (replaceLast && this.recent.length > 0) this.recent[this.recent.length - 1] = line;
    else this.recent.push(line);
    if (this.recent.length > RECENT_LINES) this.recent.splice(0, this.recent.length - RECENT_LINES);
  }

  private rememberInput(text: string): void {
    if (text.startsWith("/")) return;
    this.firstInput ??= text;
    this.remember(`> ${text}`);
  }

  // 决策 458：换到别的会话（/resume）时清掉摘要，消息区内容不动
  resetDigest(): void {
    this.firstInput = undefined;
    this.lastReply = "";
    this.recent = [];
  }

  // 决策 458：当前会话的摘要（会话面板里那张卡与偷看）
  digest(): { firstInput: string; lastReply: string; recent: readonly string[] } {
    return { firstInput: this.firstInput ?? "", lastReply: this.lastReply, recent: this.recent };
  }

  // 决策 434：会话回退或切换分支后清空消息区（随后按新的主分支重绘历史）；欢迎头留着
  clear(): void {
    this.list.clear();
    if (this.header !== undefined) this.list.addChild(this.header);
    this.firstInput = undefined;
    this.lastReply = "";
    this.recent = [];
    this.streamTail = null;
    this.streamText = "";
    this.thinkingTail = null;
    this.thinkingText = "";
    this.toolLines.clear();
  }

  // 历史行（M5 S2，决策 045）：/resume 换绑后一次性渲染；thinking 行弱化，其余同实时流口径
  addHistory(lines: readonly HistoryLine[]): void {
    for (const line of lines) {
      if (line.kind === "thinking" || line.kind === "end") {
        this.appendDim(line.text);
      } else if (line.kind === "tool" || line.kind === "toolResult") {
        // 工具调用行与结果行同实时流：暗色，失败的开头标红色 ✗
        this.list.addChild(
          new Text(toolEntryText(line.text, line.failed === true), 1, 1, secondary)
        );
      } else if (line.kind === "assistant") {
        this.appendMarkdown(line.text);
        this.lastReply = line.text;
        this.remember(line.text);
      } else {
        // 回看历史里的说明行（更早未展开、旧格式会话等）是提示，弱化
        this.append(line.text, line.kind === "notice" ? secondary : undefined);
        if (line.kind === "user") {
          this.rememberInput(line.text.startsWith("> ") ? line.text.slice(2) : line.text);
        }
      }
    }
  }

  // user 消息提交回显
  addUserEcho(text: string): void {
    this.append(`> ${text}`);
    this.rememberInput(text);
  }

  // 系统行：程序写的提示（命令结果、状态说明等），用次要信息的弱化样式（验收修改：提示一律灰色）
  addSystem(line: string): void {
    this.append(line, secondary);
  }

  // 要醒目的系统行：真正的报错（请求、写入、钩子出错等）、要人作答的审批块与运行期告警，照常显示
  addAlert(line: string): void {
    this.append(line);
  }

  // 挂着的审批块：照常醒目显示整块；返回的函数在答完时把整块原地换成一行结论（弱化、按宽度截断，不折行）
  addApprovalBlock(text: string): (line: string) => void {
    const block = this.append(text);
    return (line) => {
      const index = this.list.children.indexOf(block);
      if (index >= 0) this.list.children[index] = new ConclusionLine(sanitizeTerminalText(line));
    };
  }

  // turn.started：只重置流式状态，不 append——尾巴懒创建（决策 035：首个 text_delta 到达时
  // 才开出；纯工具调用轮因此不留占位子组件。pi-tui 0.84.4 的 Text("") 渲染零行
  //（components/text.js 空文本早退），懒创建前后屏幕逐行一致，此不变式是字面性的：
  // 尾巴存在 ⟺ 本轮已流式文本）
  openStream(): void {
    this.streamTail = null;
    this.streamText = "";
    this.thinkingTail = null;
    this.thinkingText = "";
  }

  // thinking_delta（M5 S2，决策 045）：思维链单独一段、~ 前缀、暗色弱化；正文段已开则先收尾，
  // 保证段序与块序一致（真实 provider 块序：thinking 在 text 之前）
  appendThinkingDelta(delta: string): void {
    if (this.thinkingTail === null) {
      this.streamTail = null;
      this.streamText = "";
      this.thinkingTail = this.appendDim("");
    }
    this.thinkingText += delta;
    this.thinkingTail.setText(sanitizeTerminalText(`~ ${this.thinkingText}`));
  }

  // text_delta：流式生长（首个 delta 懒开出尾巴并 setText；无 turn.started 的 deltas
  // 同样经此防御性开出——deltas 不锚身份，024）
  appendDelta(delta: string): void {
    // thinking 段收尾：正文另起一段
    this.thinkingTail = null;
    this.thinkingText = "";
    const opened = this.streamTail === null;
    if (this.streamTail === null) this.streamTail = this.appendMarkdown("");
    this.streamText += delta;
    this.lastReply = this.streamText;
    this.remember(this.streamText, !opened);
    // 累积文本整体重净化（幂等为前提）：跨 delta 劈开的序列在补齐帧被惰性化，
    // 中间帧的裸 ESC 显示为 ␛ 是正常形态
    this.streamTail.setText(sanitizeTerminalText(this.streamText));
  }

  // turn.completed：收尾当前流式消息（从未开过尾巴的轮次不追加任何行）
  closeStream(): void {
    this.streamTail = null;
    this.streamText = "";
    this.thinkingTail = null;
    this.thinkingText = "";
  }

  // 消息条数（渲染耗时测量与测试用）
  size(): number {
    return this.list.children.length;
  }

  // tool.proposed：工具名 + 参数摘要（措辞复用 application/format.ts 的 summarizeArgs）。工具条目整块暗色（调用行与结果预览）
  addToolCall(toolCallId: string, line: string, failed = false): void {
    const text = new Text("", 1, 1, secondary);
    this.list.addChild(text);
    const entry: ToolEntry = { text, content: line, failed };
    this.toolLines.set(toolCallId, entry);
    this.renderTool(entry);
  }

  // 调用行 + 结果块（有结果时）
  private renderTool(entry: ToolEntry): void {
    const body = entry.result !== undefined ? toolResultBody(entry.result, this.toolsExpanded) : "";
    entry.text.setText(
      toolEntryText(body === "" ? entry.content : `${entry.content}\n${body}`, entry.failed)
    );
  }

  // 工具结果（286）：显示在调用行下方；调用行还没出现（结果先到）时如实另起一个空调用行承载
  attachToolResult(toolCallId: string, toolName: string, result: ToolResultView): void {
    let entry = this.toolLines.get(toolCallId);
    if (entry === undefined) {
      this.addToolCall(toolCallId, `$ ${toolName}`);
      entry = this.toolLines.get(toolCallId);
      if (entry === undefined) return;
    }
    entry.result = result;
    this.renderTool(entry);
  }

  // 决策 439：工具结果里的图片（read_file 交给模型的）——能显示图片的终端里显示，不能的退回一行文字占位（pi-tui 的 Image）
  addImages(images: ReadonlyArray<{ data: string; mimeType: string }>): void {
    for (const image of images) {
      const checked = checkedImage(image);
      if (checked === undefined) {
        // 类型不在白名单或数据不是合法的 base64：只显示固定的占位，不把对方给的类型与数据写进终端
        this.append("[image: can't display]");
        continue;
      }
      this.list.addChild(
        new Image(
          checked.data,
          checked.mimeType,
          { fallbackColor: (text) => sanitizeTerminalText(text) },
          { maxWidthCells: 60, maxHeightCells: 20 }
        )
      );
    }
  }

  toolsExpandedState(): boolean {
    return this.toolsExpanded;
  }

  // Ctrl+O：展开或收起全部工具结果
  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const entry of this.toolLines.values()) {
      if (entry.result !== undefined) this.renderTool(entry);
    }
  }

  // tool.settled：在原行追加结果状态（参数摘要保持可见）；settled 先到则如实落整行。失败的开头标记换成红色 ✗
  settleToolCall(toolCallId: string, line: string, state: string, failed = false): void {
    const existing = this.toolLines.get(toolCallId);
    if (existing === undefined) {
      this.addToolCall(toolCallId, `${line} ${state}`, failed);
      return;
    }
    existing.content += ` ${state}`;
    existing.failed = failed;
    this.renderTool(existing);
  }
}

// 运行事件在消息区的投影（主会话与进入的 worker 会话共用）：轮次开始重置流式段，轮次结束收尾流式段，
// 工具调用行随提出与结束原位更新。决策 452：轮次结束不再落标记行（工作结束时由壳落一行收尾）。
// 花费、上下文用量与活动 Run 的记账由调用方各自处理
export function projectRuntimeEvent(
  flow: MessageFlow,
  event: EventEnvelope,
  options: { turnErrors?: boolean } = {}
): void {
  switch (event.kind) {
    case RuntimeEventKind.TurnStarted:
      flow.openStream();
      break;
    case RuntimeEventKind.TurnCompleted: {
      flow.closeStream();
      // 没有收尾行的消息区（面板会话）：轮内出错写一行原因
      const message = (event.payload as TurnCompletedPayload).errorMessage?.split("\n")[0];
      if (options.turnErrors === true && message !== undefined && message !== "") {
        flow.addAlert(`error · ${message}`);
      }
      break;
    }
    case RuntimeEventKind.ToolProposed: {
      const payload = event.payload as ToolProposedPayload;
      flow.addToolCall(payload.toolCallId, toolCallLine(payload));
      break;
    }
    case RuntimeEventKind.ToolSettled: {
      const payload = event.payload as ToolSettledPayload;
      flow.settleToolCall(
        payload.toolCallId,
        `$ ${payload.toolName}`,
        toolSettledState(payload),
        payload.isError
      );
      break;
    }
    default:
      break;
  }
}

interface ToolEntry {
  text: Text;
  content: string;
  result?: ToolResultView;
  failed: boolean;
}

// 工具条目的显示文字：先净化、加链接；失败的把开头的 "$" 换成红色 ✗（整行的暗色由 Text 的逐行样式加）
function toolEntryText(content: string, failed: boolean): string {
  const shown = linkify(sanitizeTerminalText(content));
  return failed && shown.startsWith("$ ") ? `${failureMark("✗")}${shown.slice(1)}` : shown;
}

// 工具调用行：工具名 + 参数摘要（面板的"正在做什么"与树形视图的最近调用用同一行）
export function toolCallLine(payload: { toolName: string; args: unknown }): string {
  return `$ ${payload.toolName} ${summarizeArgs(payload.args)}`;
}

export function toolSettledState(payload: ToolSettledPayload): string {
  return payload.isError
    ? `-> error${payload.errorKind !== undefined ? ` [${payload.errorKind}]` : ""}`
    : "-> ok";
}

// 工具结果（决策 286）挂到调用行下方：details 带 diff 的显示 diff
export function attachToolResultTo(
  flow: MessageFlow,
  notice: {
    toolCallId: string;
    toolName: string;
    isError: boolean;
    text: string;
    details: unknown;
    images?: ReadonlyArray<{ data: string; mimeType: string }>;
  }
): void {
  const diff = diffOfDetails(notice.details);
  flow.attachToolResult(notice.toolCallId, notice.toolName, {
    isError: notice.isError,
    text: notice.text,
    ...(diff !== undefined ? { diff } : {}),
  });
  if (notice.images !== undefined && notice.images.length > 0) flow.addImages(notice.images);
}

// 决策 439：网址与绝对路径输出成 OSC 8 链接（终端支持超链接时）；在净化之后加，序列来自受信代码
// 网址与绝对路径（盘符或 / 开头、带扩展名）。按空白切成词逐个看（线性；不用会回溯的整段正则），词里先剥掉开头的引号括号与
// 结尾的标点；网址可以在词中出现（"见https://…"），路径须从词首开始。超长的词（4096 字以上）不看。
const MAX_TOKEN = 4096;
const LEADING = /^[("'`（「“‘《<[]+/;
const TRAILING = /[.,;:!?)\]）」”’》>，。；：！？、"'`]+$/;
const PATH_TOKEN = /^(?:[A-Za-z]:\\|\/)[^<>"'`:*?|]+\.[A-Za-z0-9]{1,8}$/;

function linkToken(token: string): string {
  if (token.length > MAX_TOKEN) return token;
  const lead = LEADING.exec(token)?.[0] ?? "";
  const rest = token.slice(lead.length);
  const tail = TRAILING.exec(rest)?.[0] ?? "";
  const core = rest.slice(0, rest.length - tail.length);
  if (core === "") return token;
  const at = core.search(/https?:\/\//);
  if (at >= 0) {
    const url = core.slice(at);
    return `${lead}${core.slice(0, at)}${hyperlink(url, url)}${tail}`;
  }
  if (!PATH_TOKEN.test(core)) return token;
  try {
    return `${lead}${hyperlink(core, pathToFileURL(core).href)}${tail}`;
  } catch {
    return token;
  }
}

export function linkify(text: string, hyperlinks = getCapabilities().hyperlinks): string {
  if (!hyperlinks) return text;
  return text.replace(/\S+/g, linkToken);
}

// 决策 439：显示的图片只认这几种类型，数据须是严格的 base64；类型一律换成白名单里的写法
const IMAGE_TYPES = new Map([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
]);

export function checkedImage(image: {
  data: string;
  mimeType: string;
}): { data: string; mimeType: string } | undefined {
  const mimeType = IMAGE_TYPES.get(image.mimeType.trim().toLowerCase());
  if (mimeType === undefined) return undefined;
  const data = image.data;
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return undefined;
  }
  return { data, mimeType };
}

// 答完的审批收成的一行：与其他系统行一样上下各留一行空白、左右各留一格，超宽截断，弱化显示
class ConclusionLine implements Component {
  private readonly line: string;

  constructor(line: string) {
    // 按行渲染：行里不能带换行（多行只取首行）
    const lines = line.split(/\r?\n/);
    this.line = lines.length > 1 ? `${lines[0]} …` : line;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const blank = " ".repeat(width);
    return [blank, secondary(` ${clipToWidth(this.line, Math.max(1, width - 2))}`), blank];
  }
}
