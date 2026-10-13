# 终端界面全屏与 pi-tui 部件（决策 441、439、440）审计

基线 9cff73b，分支 worktree-product-build。

## 一、改了什么

### 441 全屏

- `src/tui/shell.ts`：`TuiMainScreen` 换成 `TuiAltScreen`；`layout()` 为每个视图建一个 `VStack` 作布局根（`setLayoutRoot`）：消息区（主会话、worker 会话、历史视图）与树形视图为 `{basis: 0, grow: 1, minSize: 1}`，标题、状态行、排队、会话选择器、输入框、状态栏、编排面板按自身高度排在上下。消息区沿用 `ScrollView({follow: "end", primary: true})`。
- 退出（`stop()`）：离开全屏前把布局根换成"标题加主会话消息区"，pi-tui 离开备用屏时把它完整打印到普通屏幕（不打印输入框、状态行与状态栏）。`suspendFor`（打开外部编辑器）用 `stop({ preserveScreen: true })`，暂离时不打印。
- 按键：全屏的搜索框是浮层，开着时壳的三个按键监听让开（Ctrl+C 除外）；输入框的补全列表开着时同样让开。拖选出选区后 Ctrl+C 复制选区（`copyActiveSelectionToClipboard`，OSC 52），不计退出布防。Windows 上右键粘贴：新文件 `src/tui/clipboard.ts` 用 `powershell.exe Get-Clipboard -Raw`（不弹窗、限时 3 秒），取到的文字按 bracketed paste 交给输入框。
- 键位缺省的两处改动（见 439 键位表）：`tui.altScreen.top/bottom` 改为 Ctrl+Home/Ctrl+End（Home/End 留给输入框），`tui.altScreen.search` 另加 F3。
- 测试夹具 `src/tui/testing.ts` 的虚拟屏：仿备用屏（`?1049h` 进、`?1049l` 回主屏并恢复主屏内容）、自动换行开关（`?7l` 时写到行末即截断）、按参数定位的 `CSI 行;列 H`；新增 `mainLines()` 与 `alternate`。

### 439 复用 pi-tui 部件

- 模型回复用 `Markdown` 渲染（`src/tui/markdown-theme.ts`）：粗体、斜体、下划线、删除线与行内代码的少量样式；引用边 `│` 与分隔线 `─` 换成 ASCII，代码框线与列表符号 pi-tui 本就是 ASCII；`renderLatex: false`。流式时整段 `setText`（pi-tui 按文本与宽度缓存）。历史视图里的助手行同样按 Markdown。内容先经 036 净化再交给 Markdown。
- 输入框补全：`createPromptEditor` 接 `CombinedAutocompleteProvider`，命令取自 `command-table.ts`（按首段去重，说明取用法），路径与 `@` 以工作区为根；`fd` 在 PATH 里找（`src/tui/fd-path.ts`，找不到即 `null`，`@` 不出结果）；选中前缀 `→` 换成 `>`。`@路径` 发出时原样作为文字。
- 等模型时的 `Loader`：一轮开始（运行开始、每个 `turn.started`）出现在消息区与状态行之间，第一段流式输出、本轮结束或运行结束即收起；帧为 `- \ | /`，提示 `waiting for model`。
- OSC 8 链接：消息区的系统行与工具行里的网址与绝对路径（盘符或 `/` 开头、带扩展名、前面不是路径或词的一部分），终端支持超链接时加链接（在 036 净化之后加，序列来自受信代码），句末标点留在链接外。助手的 Markdown 正文不加（Markdown 自己处理链接样式）。
- 图片：`ToolResultNotice` 增加 `images`（工具结果里的图片块），终端界面在消息区追加 `Image`（最宽 60 列、最高 20 行），不能显示图片的终端由 pi-tui 退回一行 `[Image: …]` 文字占位。
- 会话选择器（`src/tui/session-picker.ts`）的列表改用 `SelectList`（滚动、翻页、选中由它做；键位取 `tui.select.*`），对外接口不变，壳把打开期间的按键原样交给它。树形视图保留自写。
- 键位：新文件 `src/tui/keybindings.ts` 用 `KeybindingsManager`，在 pi-tui 的键位表上加 Pigeon 自己的动作（`pigeon.cancel`、`pigeon.exit`、`pigeon.toggleToolOutput`、`pigeon.tree`、`pigeon.dequeue`、`pigeon.approval.*` 六个），缺省与改用之前逐个一致；壳与审批面板的按键判断改为查表。设置新节 `keybindings`（`src/state/keybindings-config.ts`，校验键名须形如 `pigeon.*`/`tui.*`），开局与 `/reload` 后按快照重装；未知的动作名、两个 Pigeon 动作绑同一个键（全局动作一组、审批面板一组）在消息区提示。
- `status-bar.ts` 的 `clipToWidth` 改用 `truncateToWidth`（不补省略号；它截断时补的样式复位在原文没有控制序列时去掉）。

### 440 对话框不用浮层

- 审批面板、扣住消息的二选一、会话选择器都仍在布局里（审批块写进消息区、选择器在输入框上方），没有用浮层；唯一的浮层是全屏自带的查找框。

## 二、测试

- 新文件 `src/tui/fullscreen.test.ts`（8 条）：进全屏且标题在顶、对话超过一屏时最新的在、状态栏在底；退出打印对话（含滚出视口的早先内容）且不打印输入框与状态栏；暂离不打印、回来重新进全屏；Home/End 留给输入框；F3 打开查找、开着时回车不提交、Esc 关后照常；运行中打开查找时 Esc 关查找不取消这一轮；拖选后 Ctrl+C 复制（OSC 52）且不清输入；等模型时转圈、第一段输出即收起、帧为 ASCII。
- 新文件 `src/tui/keybindings.test.ts`（4 条）：缺省键位逐个对照；按动作名改键（含 `tui.*`、空数组取消）；未知动作名与冲突的提示并在开局写进消息区；设置文件里 `keybindings` 键名与值的校验。
- 新文件 `src/tui/markdown.test.ts`（1 条）：标记不露出、列表与代码块、引用边与分隔线为 ASCII、`$5 到 $10` 原样、流式生长、控制序列先净化、粗体由主题加上。
- 新文件 `src/tui/autocomplete.test.ts`（3 条）：命令表去重与用法；`/sess` 列出命令、选中前缀不是 `→`、回车套用并作为命令执行；补全列表开着时 Esc 只关列表、Tab 以工作区为根补全路径。
- 新文件 `src/tui/links-images.test.ts`（2 条）：网址与绝对路径加 OSC 8、句末标点在外、相对路径与词中斜杠不加、终端不支持时原样；工具结果里的图片在不能显示图片的终端退回文字占位。
- `src/tui/status-bar.test.ts` 加 `clipToWidth` 一条（宽字符不劈开、不带控制序列、长串线性）。
- 既有用例的改动（全屏下视口只有终端那么高）：`approval.test.ts` 两处、`cancel.test.ts` 一处、`continue-flags.test.ts` 一处、`session-view.test.ts` 一处、`shell.test.ts` 的注入用例把虚拟终端调高（内容滚出视口）；`history.test.ts` 的"控制序列不写往终端"改为断言模型内容里的那一个（`锚点` 加 `\x1b[2J`）没有原样写出——全屏自己会写清屏序列；`shell.test.ts` 的 dispose 用例改为停下（打印对话）之后再取屏幕快照比对。`runtime-fixtures.ts` 加 `emitDelta`。

## 三、验证

- 变异核对（均已恢复）：11 处里 10 处变红——退出不换布局根（打印了状态栏）、暂离用不保留的停止（打印了标题与状态行；原用例按对话内容断言测不到，改为按标题与状态行断言后变红）、Ctrl+C 不先复制选区、`tui.altScreen.top` 回到 Home、去掉 F3、引用边不换 ASCII、链接把句末标点算进去（原用例的句末是中文句号与路径，测不到，加了网址后跟英文句号的一句后变红）、第一段输出到来不收转圈、补全选中前缀不换 ASCII、`clipToWidth` 留着样式复位。保持绿的一处：搜索框开着时壳的监听让开——去掉之后"运行中打开查找、Esc 关查找不取消这一轮"仍过，pi-tui 的查找监听本就先拿到按键，这段是防御（第四节已述）。
- 回归（一个 vitest 进程）：src 根 3 条边界测试、src/tui、src/cli、src/state、src/persistence、src/pi-runtime 全部，130 个文件 703 条通过、3 条跳过。整仓 `npx biome check .` 无问题、`tsc` 通过、`npm run deps` 无违规。
- 真实运行（打包产物，本机 Windows；HOME、USERPROFILE、XDG_CONFIG_HOME、GIT_CONFIG_GLOBAL 指临时；用户级设置写了 `keybindings`，其中一个是未知动作名）：隐藏窗口起终端界面，10 秒后仍在运行，会话名录里有它的条目，项目里没有建 `.pigeon/state`。首次用 PowerShell 5.1 的 `Set-Content -Encoding utf8` 写设置文件时带了 BOM，Pigeon 按"不是合法 JSON"报错退出（读设置文件不认 BOM 是原有行为，本段没有改），改为不带 BOM 写之后正常。隐藏窗口看不到画面，全屏的实际观感列在第五节。

## 四、自定的细节

- 退出时打印"标题加主会话消息区"，查看 worker 会话或树形视图时退出也打印主会话的对话。
- Ctrl+Home/Ctrl+End 本是输入框"到行首/行尾"的备用键，全屏下归视口；输入框用 Home/End（及 Ctrl+A/Ctrl+E）。
- 查找的另一个键选 F3；`pigeon.exit` 在有选区时先复制，复制不计第一下。
- 右键粘贴用 PowerShell 读剪贴板（每次起一个进程，约数百毫秒）；读失败即什么都不贴。
- `@` 引用的文件搜索需要 `fd`，没有不另做（施工说明的缺省是"@ 只做补全"）。
- 转圈只在主会话视图显示（worker 会话视图与树形视图不显示）；提示文字为英文 ASCII（状态行一带的 chrome 照"歧义宽字符不进 chrome"）。
- 链接只加在系统行与工具行（含工具结果）；助手的 Markdown 正文、用户回显不加。
- 图片的最大尺寸 60×20 字符格。
- 搜索框开着时让开的判断：实测 pi-tui 的查找监听本就先于壳的监听拿到按键（变异核对时去掉这段用例仍过），这段保留作防御。
- 性能对照沿用 10 月 12 日调研时的数据（stream-prep 的 pi-tui 使用盘点笔记：1 万条消息时流式每帧主屏约 31 ms、全屏约 1.5 ms），这次没有重测。

## 五、尚待确认（需要人看与按键）

- 全屏下中文宽度与输入法候选窗的位置；鼠标滚轮、拖选复制（OSC 52 是否进系统剪贴板）、右键粘贴；Ctrl+Shift+F 是否被 Windows Terminal 截走、F3 是否可用；改窗口大小；长会话退出时打印完整对话的耗时。
- Markdown 表格框线是 pi-tui 写死的 `┌─┬┐`（歧义宽字符），在中文环境的终端里可能错位；没有主题钩子可换。
- 能显示图片的终端（kitty、iTerm2 等）里图片的实际显示；Windows Terminal 下是文字占位。
- 补全列表的观感与 `@` 在装了 fd 的机器上的表现。
