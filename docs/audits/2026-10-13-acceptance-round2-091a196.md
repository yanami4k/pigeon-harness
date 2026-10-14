# 第二轮验收修改：七件修正、界面文字清理、去掉命令行对话、界面文字改英文（决策 459–462）

基线 091a196，分支 worktree-product-build。本文只记事实：改了什么、怎么验的、还剩什么。

## 一、七件验收修改

### `/config` 不往消息区写

- 在设置面板里改一项：那一项的值当场更新就是反馈，消息区不写行，面板提示行也不写"已改"；改不成（运行中、有 worker 在跑、写不进文件）与重读失败写在面板提示行，醒目样式（`ConfigPanel.setNote(text, alert)`）。重读设置回话里的"已重读""没有变化"两句不再显示（按 `SETTINGS_RELOADED_PREFIX`、`SETTINGS_UNCHANGED` 两个常量过滤，`src/application/settings-reload.ts` 导出、`src/tui/shell.ts` 引用），其余回话照写。
- `/config 选项=值`（不开面板）写一行结果：`<选项> = <值> (written to user settings[, but <层> override it])`；值没变不写文件、不重建，也不说。
- 每项说明只留一句；生效值与用户级写的不同时附上；被别的层覆盖的名字旁标 `(overridden)`。
- 用例：`config-panel.test.ts`（面板里改、被覆盖的一项、改不成只写在提示行、直接改一行、值没变不说）。

### 主目录下项目级与用户级是同一个目录

- 判定：`src/persistence/pigeon-layers.ts` 的 `projectSharesUserPigeonDir`——两个 `.pigeon` 都在时比真实路径（Windows 不分大小写），没建时比项目根与主目录的真实路径。
- 设置（`settingsLocations`）：只读用户级与项目个人两层；`ensureStateDirOf` 同一判定。修好的现象：`trustedDirectories` 写在用户级启动即报错、`/config` 误报"被项目设置覆盖"、键位与放权规则重复计层。
- 记忆：`availableMemoryLayers` 只给用户级；推送只推一次；`update_memory` 写项目级即拒绝（给模型的英文说明）；`/memory edit project` 回一句改用 user。
- Skill：`scanLocalSkills` 的 `projectIsUserDir` 只按用户级扫一次（`runtime.ts` 两处传入）。
- 迁移命令：项目共享层按用户级校验，说明写明写进的是用户级、对所有项目生效。
- 用例：`pigeon-layers.test.ts`（3）、`home-layers.test.ts`（3）、`memory-command.test.ts`、`catalog.test.ts`、`migrate-config.test.ts`（撤掉修复时该用例失败、报 trustedDirectories 只能写在用户级，已核对）。

### 非 git 目录下面板派会话共用当前目录（决策 459）

- `src/tui/main-pool.ts`：`isGitWorkspace` 为否时不建工作树、不持有工作树在用锁，运行面工作区即治理根；`LocalSessionPool` 的 `sharedDir` 选项在派出时判定，卡片带 `sharedDir`，面板卡片名字后标暗色 `shared dir`；`/take` 回 `X has no worktree; nothing to take`；停下不清理工作树。派出时不加提示（说明在文档）。
- 用例：`main-pool.test.ts` 新增一条真实装配用例（非 git 临时目录：改动直接在目录里、没有工作树与在用锁、卡片标记、/take 回话、停下不动改动、会话文件头的工作目录即当前目录）。

### 提示灰色、报错醒目

- `MessageFlow.addSystem` 用 454 的弱化样式；新增 `addAlert` 照常醒目。壳与命令层里报错、要作答的审批块、运行期告警走 `addAlert`。分类见第二节末。

### 去掉顶部标题行

- 主视图、树形视图与会话面板不显示标题行；worker、只读历史、面板会话三处顶上一行暗色说明：`worker <名字> · esc to go back`、`history · read only · esc to go back`、`session <名字> · esc to go back to the panel`，不写会话号。退出打印的对话不带它。消息区里原有的视图头（`== 会话 … | 会话号 ==` 等）一并去掉。改名后不再刷新标题（`refreshTitle` 删除）。
- 用例：`fullscreen.test.ts`、`peer-shell.test.ts`、`orchestration-ui.test.ts`、`session-tree.test.ts` 等改写。

### 去掉 /sessions；session list 加会话名

- 命令表与分发去掉 `/sessions`（按未知命令处理）；壳的 `sessions` 选项保留作花费累计的会话根。`pigeon session list` 每行 `时间  会话名  N runs  会话号 …`，会话名取会话文件记的名字，没有即缺省名（`SessionSummary` 带上 `name`、`cwd`）。
- 用例：`session-list.test.ts`（含改过名的一条）、`session-view.test.ts`（/sessions 为未知命令）。

## 二、界面文字清理（决策 460）

按盘点（第 2 节 65 条、第 3 节按处理口径、第 5 节 1–5、之后定的 UNSURE 1、10、11、17、22）处理；第 4 节的缩短条目并进改英文一起做（直接写成缩短后的英文）。要点：

- 消息区删去的：SessionStart 补上下文的说明、改成原值的回话、回退后的两条说明、取消选择会话、脚本内同类放行的说明、拒绝理由回显、取消拒绝理由、中断那一行、worker 中断/递话/补批/派出、`/spawn` 的派出行、`/search` 命中工具输出的"可能已过时"、交回中、交回结果里的合并提醒（进文档）、分叉中、`/rename` 成功、`/grants` 的两处括注、工作树没有改动即删的回话、移进工作树当轮那一行（未带过去的改动数并进移进后那一行）、续接报告里的还原条数与未收尾的 Run（只留悬空调用一行）、`/memory` 的括注、`/worktrees` 列表后的删除用法、自动压缩压成了的那一行（手动 `/compact` 与压缩失败照写）、记忆旧格式改写成功与写进 git 全局排除文件的告知（没改成的照报）、保留拿不准的复述、选择器续接时伪造的 `> /resume` 回显、补批续做的事件标记、脚本开跑行、pnpm 全局配置降级说明。
- 给模型的原文不再显示：打转提醒、worker 与后台作业的结束通知、脚本汇总（`onNotice` 只重画）、`/orchestrate` 交给模型的那段（`submitNow(text, false)` 不回显；运行中敲 `/orchestrate` 与普通输入一样排队，空闲后再派发）。
- 去重：钩子拦下输入与 Stop 钩子拦下只留钩子自己那一行。
- 状态与面板：状态行只写状态词（`running`、`cancelling`、`resuming`、`panel: N sessions[, M waiting]`、`session: X state`、`worker: X state|waiting for approval`），空闲与审批挂着时不写；转圈不带字；面板、选择器、树形视图的头不写按键；排队区不写说明行；工具结果折叠不写按键；回退期间的进度并成一条。
- 审批答完收成一行（UNSURE 10、11）：消息区的审批块经 `MessageFlow.addApprovalBlock` 写入，答完 `settleApproval` 原地换成一行（`ConclusionLine`：暗色、按宽度截断）；worker 会话的消息区与其他视图的审批框同样收起；超时撤回收成 `✗ approval timed out …`。命令行内联审批随命令行对话去掉。
- 全屏之前写到 stderr 的启动行：上游版本告警、`--worktree` 开局行、沙箱就绪、带入未提交文件数、本机放手风险提示删去；MCP 起不来、钩子出错、取远端失败先存起来，壳起来后在会话里醒目显示（`src/tui/main.ts` 的 `early`）。
- `/search` 用法改为实际认的选项（`--conversation-only`），加用例核对用法与解析一致。
- 未改：脚本编排的输入语法（点名词"脚本编排"、额度写法"额度""万"）保留中文，随 457 删除。

提示与报错的划分（消息区）：

- 报错（`addAlert` / 面板提示行醒目）：命令失败、交回失败、分叉失败、续接失败、历史渲染失败、请求出错（`error · …`）、压缩没压成、钩子拦下/要求停止/出错、读不了设置与改不成设置、重读设置失败、回退写回出错与出错的文件、会话记录写入失败、发给 worker 没送达与失败、续做失败、收尾时出错、worker 收尾异常与取消/取用失败、MCP 起不来、取远端失败、运行期告警（`addWarning`）、要作答的审批块。
- 提示（`addSystem`，暗色）：命令的结果（`/grants`、`/workers`、`/memory`、`/search`、`/worktrees`、`/config 选项=值` 的结果行等）、手动压缩结果、审批答完的结论行、worker 收尾摘要、历史分隔线（`--- resumed ---` 等）、移进/离开工作树的事实行、续接报告的悬空调用行、打转叫停行。

## 三、去掉命令行对话（决策 461）

删除：`src/cli/repl.ts`、`src/cli/approval-ui.ts`；测试 `repl-notices`、`repl-compact`、`approval-ui`、`approval-source`、`approval-sandbox`（cli 版，终端界面有对应用例）、`cli.test.ts`；`src/cli/index.ts` 的 `--line` 路由、`lineMain`、旧 `resumeMain` 与只为它们服务的辅助（放权命令上下文、行内配置确认、沙箱提示与交回、记忆写入提示、分叉入口），`spawn-worker-cli.test.ts` 的两条命令行对话用例（`--line` 进入与 `--line`/`pigeon resume` 注册任务清单；任务清单另有 `orchestration-wiring`、`rewind` 等覆盖）。

改动：

- `pigeon resume [会话号] [参数]` → `launchTui(["--resume", …])`；新用例：会话不存在时在接管终端前报错（经终端界面入口）。`--line` 交给终端界面按未知参数报错（用例覆盖）。
- `sanitizedWriter` 挪到 `src/cli/output.ts`（附净化用例）；`loadStreamFn` 用例挪到 `src/application/load-stream-fn.test.ts`；放权写盘失败即不生效的用例挪到 `src/tui/approval-host.test.ts`。
- 借命令行审批界面当"按脚本作答的人"的治理测试（outside-read、run-command-e2e、run-command-shell-e2e、web-governance、workers-approvals-e2e）改用 `src/tui/approval-fixtures.ts`（终端界面同一个审批 handler）；`grants-e2e` 移到 `src/application/` 并改为直接调运行面与 `runGrantCommand`，治理断言一条没少（另加了免审时不出审批块、冷恢复后不问人等断言）。
- 续跑流程的入口 `enterRepl` 改名 `enter`；记忆来源只剩 `tui`（旧条目里的 `cli` 照旧能读）。
- 沙箱续接命令统一为 `pigeon --sandbox --resume <会话号>`（`sandbox-session.ts`、`settings-reload.ts`、`continue-flags.ts`、`shell.ts`）。
- 依赖核对：`pigeon run`、打包产物入口、脚本与冒烟不依赖命令行对话；`bundle-entry.ts` 只按环境变量分派。
- 随之没有调用方的函数删除：开局与沙箱就绪行、风险提示、上限摘要、记忆写入提示行、工作树开局行、脚本开跑行、旧格式改写成功文字、放权范围注记等。

## 四、界面文字改英文（决策 462）

- 范围：终端界面、`pigeon --help` 与各子命令的用法与输出、`pigeon run` 的报错、trace / replay / session list。三个子任务按目录分开做（tui/cli/approvals/memory/tools/skills/mcp；application；state/execution/persistence/pi-runtime/orchestration），之后统一改齐跨目录的断言。非测试源码里含中文的字符串字面量由约 1400 处降到 40 处（粗略计数：去掉注释后看引号与反引号里的中文）。
- 刻意保留的中文（均加注释）：
  - 认旧记录：旧版打转提醒、脚本通知、worker 通知前缀与标记，旧开工状态权威句，旧续跑提示，旧 `run_command` 结果的"文件变化："，旧审批 fail-closed 理由，旧记忆文件头、旧来源名与旧尾巴的正则。
  - 用户输入语法：脚本编排的点名词与额度写法（随 457 删除）、`/take` 的 `会话:` 前缀（另认 `session:`）。
  - 缓存规则表里的出处引句（`scripts/check-cache-rule-sources.ts` 逐字比对服务商中文页面）。
  - 解析：告警归类同时认全角与半角冒号（别处旧文字）；链接边界的中文标点字符类。
- 统一的写法：报错 `<what> failed: …`；用法 `usage: …`；未知参数 `unknown option: X (usage)`；运行中拒绝 `can't … while running`；审批与放权、trace/replay、设置校验、配置确认、worker 与工作树等说法见三个子任务的对照（`plural()` 处理单复数）。
- 顺带改英文的给模型的文字：审批撤回理由（另有给模型的完整句）、记忆锁报错、无人值守拒绝理由后缀、搜索后端缺 key 的说明、`enter_worktree` 结果里的起点标签、若干工具注册说明与注册报错、会话存储告警模板。
- 行为改动：Ctrl+C 第一下不再往消息区写 `[cleared]`，状态行临时显示 `press Ctrl+C again to exit`，布防窗口一过或有别的输入即恢复（有别的输入时撤销布防）；`exit.test.ts` 新增用例。

## 五、决策与文档

- 决策 459–462；按规则 319 给 003、031、189、244、266、267、331、379、384、428、432、443、444、456 加"部分已改"。
- `docs/configuration.md`：三层设置（主目录）、程序状态（全局排除文件写入不告知）、worker 收尾摘要与 /take、独立工作树与 enter_worktree 的提示、终端界面（无标题行、状态词、审批收成一行、排队、斜杠命令与 /sessions、Ctrl+C、编排面板与树形视图按键、给模型的文字不显示）、设置面板、会话面板（非 git 共用目录、在面板上中断时排队的话）、记忆、会话检索、迁移命令、重读设置、风险与容器沙箱（交回分支第一条提交是开箱时的未提交改动、合并前先收起）、放权撤销范围、后台作业通知、钩子（SessionStart 补的上下文随下一条输入、拦下只一行）、上下文压缩的界面提示；删去所有命令行对话的说法。文档仍为中文，引用的界面文字为英文。

## 六、独立复查与修正

改英文提交（d0fb807）之后另起子任务独立复查 091a196 以来的全部改动，按结论修正：

- 打包冒烟脚本（`scripts/bundle-smoke.mjs`）仍按中文版 `--version` 逐字比对：期望改为 `pigeon <版本> (commit <短号>[, uncommitted changes])`。用 `build-bundle.mjs --out <临时目录>` 打包核对过输出写法（没有动仓库里的 `dist/`）；完整的冒烟（`npm run bundle && node scripts/bundle-smoke.mjs`）未在本机跑。
- 运行中输入 `/orchestrate stop|resume|drop` 被排队：只有 `/orchestrate <任务>` 排队，子命令与不带参数的照常立即执行（`isOrchestrateTask`）。
- 答完的审批收成一行时多行命令（heredoc）把换行带进按行渲染的全屏：结论只取首行加 `…`（壳的 `settleApproval` 与 `ConclusionLine` 两处）。另：另有审批挂着（BUSY）被拒的请求不再去收起挂着的那一块；撤回、放权写盘失败时审批块也收成一行；没有挂着的块时不再补写一行。
- 面板会话的后台作业通知仍把给模型的原文写进主消息区：不显示。面板会话的取远端失败、钩子与 MCP 出错改为醒目；主会话的 `/reload` 失败、`/compact` 出错、`/orchestrate` 命令失败、移进工作树没成同样改为醒目。
- `[r]` 写理由的提示行在审批收起后残留：提示改在状态行（`reason for rejecting (enter to send, esc to go back)`）。
- 启动缓冲：壳起来之后先冲刷（早于 SessionStart 钩子与开局的其余提示）；壳起来之前出错退出的，退出时写到标准错误输出；沙箱开箱时的告警（残留容器、没有内存上限、大文件没带入、未提交改动没带入、MCP 不可用）进会话，拉镜像与建镜像的进度照旧写在进入全屏之前（沙箱日志加 `progress` 标记区分）。
- `--worktree` 取远端失败的判据改为结构化的 `fetchFailed`（没有远端默认分支不再误报）。
- 回看历史与回退：/orchestrate 交给模型的包装还原成人敲的 `/orchestrate <任务>`（含 ↑ 召回与回退放回输入框）；后台作业通知、跨会话消息与回告、`[Pigeon]` 程序附注显示为系统行，不当人输入；会话面板的偷看与 /resume 列表的首条输入同一套识别。
- 容器执行端三处报错漏翻（容器起不来、移除失败、列出失败）。
- `/take <worker>` 与 `/orchestrate resume|stop|drop` 给人看的回话改为短句（给模型的整句只给工具）；`/take` 的用法与命令表一致（`<worker|session>`）。
- 小项：面板里改设置成功时清掉上次的报错；`pigeon resume --yolo <会话号>` 这类参数在前的写法照样认会话号；主目录下 `/memory edit project` 的回话写明改用 user；报错本身已说清的（`usage:`、`can't …`）不再叠一层 `… failed:`；面板会话的共用目录只判定一次（卡片与开会话同一个判定）。
- 死代码与测试：删去没有调用方的常量与参数、空分支；只断言"不出现中文"的空断言改为同时查英文写法与不随语言变的特征；测试夹具的理由提示改英文常量。上游版本探测（`upstream-version.ts`）启动时不再打印，保留作测试守门（说明已改）。
- 新增与扩展的用例：`review-fixes.test.ts`（运行中 /orchestrate 两种情形、多行命令收起、理由提示在状态行且不留残行、BUSY 不收别人的块）、`orchestration-ui.test.ts`（树形视图与主会话里审批收起）、`session-panel.test.ts`（`/take session:`）、`history.test.ts`、`rewind.test.ts`。

## 七、验证

- `tsc --noEmit`、biome、dependency-cruiser 干净。
- 全量测试（本机）：1830 过，8 条失败，其中 3 条是复查修正改了措辞后没跟上的断言（已改，单独重跑通过），其余 5 条是本机已知失败：`checkpoints-async` 保留修改时间的同长度覆盖、`spawn-worker-headless` 撞上时间上限、`script-acceptance` 卡住监测（偶发）、`container-host` 与 `container-round-trips`（本机没有建符号链接的权限）。

补验（pigeon-verify，41171e6）：打包冒烟通过；verify:full 1 条失败——`peer-security.test.ts` 只在 POSIX 上跑的"目录是符号链接即拒开收件口"仍按中文报错匹配（行为正确，报错已是英文 `… is not a regular directory`），本机 Windows 跳过没看到，已改断言。随之扫了所有按平台或条件跳过的测试：含 `process.platform`/`win32` 判断的 46 个文件与带 `skipIf`/`runIf`/`.skip` 的 29 个文件（合计 47 个），找正则字面量、`includes`/`match`/`startsWith`/`rejects`/`throws` 的参数与 `equal` 期望值里的中文，再看这段中文在非测试源码（去掉注释）里还在不在；只此一处是遗留，其余命中都是测试自己传入的数据（模型回复、命令输出、注入的报错、锁的说明）或中英并列的否定断言。另对全部 345 个测试文件跑了同样的扫描，命中的都在本机会跑且通过的用例里，同属测试数据。

开发脚本（`scripts/build-bundle.mjs`、`scripts/bundle-smoke.mjs` 等）的输出给开发者看，不在决策 462 "给使用者看"的范围里，照旧中文（与仓库的注释语言一致）；只改了冒烟脚本里与产品输出比对的期望值。

## 八、遗留

- 命令行对话不显示模型回复的缺陷随入口删除，不再单独修。
- 跨进程通信相关的休眠文案（决策 450）随 457 删除，这次只把文字改了英文。
- 脚本编排的输入语法（点名词"脚本编排"、额度写法）保留中文，随 457 删除。
- 回退的消息树只看一次运行里的第一条用户消息：人输入时恰有待递的通知排在前面，这条人的话进不了消息树（原有缺口，未改）。
- 没有用例的：启动缓冲的冲刷与出错退出时写到标准错误输出、面板会话的作业通知不显示。
- `/reload` 的回话里需要人确认的条目，在面板提示行与消息区照常是弱化样式；各处"运行中不能做"的说法、worker 状态词两套等措辞还没有完全统一。

## 九、续验修改（决策 463）

### 五件修改

- `/rename` 改成了写一行暗色的 `renamed to <名字>`。
- 工具调用条目（调用行与结果预览）整块暗色；调用失败的只把开头的 `$` 换成红色 `✗`（先关暗色、写完再开回来），整行仍暗。实时流、worker 会话、面板会话与回看历史走同一处（`MessageFlow`）；历史行带上 `failed` 标记。
- Tab：补全器换成 `PromptAutocompleteProvider`（继承 pi-tui 的 `CombinedAutocompleteProvider`），光标前一个字符是空白、引号、等号或没有字符时不触发文件补全；斜杠命令的补全不经这一处，不变。
- 会话回退的消息树：`RewindNode` 加 `parent`（上一条消息的 key），界面按它还原树、画 ASCII 连接线（迭代，不递归）；当前路径正常亮度、其余分支与 reply 行暗色；`current` 标在当前末端的上一条消息后面（会话开头即末端自己）；时间右对齐，窄到放不下时只留文字。`TreeList` 加可选的整行渲染函数，会话树不受影响。
- 文档：`docs/configuration.md` 的补全、次要信息、会话名、后台作业、`/config`、会话面板与会话回退几处；会话名一段里残留的"标题栏""命令行对话"一并删去。

### 盘点复核：删除理由是"别处看得到"的确认行

逐条到代码里核那个"别处"现在是否还看得见（主视图去掉标题行、去掉 /sessions、审批收成一行、面板里改设置不写消息区之后）：

| 盘点条目 | 内容 | 依据的"别处" | 现状 | 处理 |
|---|---|---|---|---|
| 2 | `/config` 设成相同的值 | （删） | 直接打命令时毫无反应；面板里是轮换，遇不到 | 恢复：`<选项> is already <值>`，被覆盖时同一行写明 |
| 28 | 改名成功 | 标题栏会变 | 标题栏已去掉；/resume 列表不列当前会话；只在面板卡片上 | 恢复：`renamed to <名字>` |
| 31 | 后台作业结束 | 编排面板有收尾状态 | 后台作业不进编排面板、树形视图，终端界面里无处可见 | 恢复：`job <作业号> <结束状态>: $ <命令>`（暗色；给模型的通知仍不显示） |
| 43 | 面板里中断主会话 | 卡片状态 | 卡片一直写 running，直到这一轮停下 | 修正：中断途中卡片写 `cancelling` |
| 43、44 | 面板里第二次 Ctrl+X | — | "press Ctrl+X again …" 一直留到移动光标 | 修正：第二次之后清掉 |
| 6、7 | 续接报告 | 紧接着渲染历史 | 可见 | 保持删除 |
| 9 | 脚本内同类调用已允许 | 审批结论行 | 可见 | 保持删除 |
| 10 | 拒绝理由回显 | 裁决行 | 可见（理由在结论行里） | 保持删除 |
| 12、U26 | 请求中断 | 状态行 cancelling | 主视图可见 | 保持删除 |
| 14 | 中断 worker | 面板状态 | 可见（cancelled；30 秒后淡出） | 保持删除 |
| 15 | 递话给 worker | 输入回显 | 可见 | 保持删除 |
| 16、U12 | 补批 worker | 状态行 | 可见 | 保持删除 |
| 18、19 | 派出 worker | 面板与 /workers | 名字与状态在面板上；分支与会话号要打 /workers | 保持删除 |
| 25 | 脚本汇总 | 树形视图的脚本节点 | 要主动打开树形视图 | 保持删除（汇总进模型，模型会说） |
| 30 | worker 结束通知 | 编排面板收尾状态 | 面板上留 30 秒，之后 /workers 或树形视图 | 保持删除 |
| 32 | 移进工作树 | 移进后另有一行 | 可见 | 保持删除 |
| 35、36、U29、U30 | 状态行的说明 | 审批框、特殊视图的说明行、状态词 | 可见 | 保持删除 |
| 40 | 面板里改设置已生效 | 面板上的值 | 可见；直接打命令的照写一行 | 保持删除 |
| 44、45、46、47、48 | 面板里停、发话、派会话 | 卡片 | 可见 | 保持删除 |
| 62 | --worktree 开局行 | 欢迎头的目录 | 可见 | 保持删除 |
| U1 | 自动压缩 | 状态栏 ctx 百分比 | 可见 | 保持删除 |
| U18 | 记忆已记下 | 工具调用行 | 可见 | 保持删除 |

理由不属于"别处看得到"的条目（3、8、11、21、23、33、55、58、60、64 等）不在这次复核范围里。

### 验证

- `tsc --noEmit`、biome、dependency-cruiser 干净。
- 本机按改动跑了相关的 12 个测试文件，全部通过：`autocomplete`、`peer-shell`、`shell`、`history`（终端界面与应用层各一）、`message-tree`（新增）、`rewind`（终端界面与应用层各一）、`session-tree`、`config-panel`、`session-panel`、`background-jobs`。
- 本机全量测试没跑完：机器内存不足，测试进程被停掉。全量测试与打包冒烟交给 pigeon-verify。

## 十、续验修改第二批（决策 464–470）

### 七件修改

- 会话回退（464）：消息树改成当前路径的单行列表，分叉用行尾的版本箭头 `‹2/2›`，←/→ 就地切换；回车弹动作菜单，做不到的项不出现。版本的选择在 `MessageVersions`（按 `RewindNode.parent` 还原；没看过的分叉取当前路径上的、都不在取最近有动静的那个），"回退后还没发"作为一个暗色版本；菜单打开前依次规划"退到这一条之前""整支切过去""撤销上次退代码"三者，只给做得成的。上一版的连接线画法与它的用例换掉。
- 设置视图（464、465）：/config 打开整屏视图（`config` 视图，布局同树形视图），按组列出全部简单配置项，数字与字符串就地输入，键位一组可按下新键绑定；写入前合并三层核对跨字段约束。读写改成按路径（任意层），类型加了小数与带格式的字符串，整数不再限 0–999。等新键与就地输入时按键全归视图（Shift+Tab、Ctrl+X 也能绑）。
- /resume 打字即筛选（466）：选择器自己收可打印的字、Backspace 与 Esc，停下 150 毫秒检索、迟到的结果丢弃；`application/search.ts` 改成 `createSessionFilter`；/search 命令、壳的 `search` 选项与命令表项删去。
- 审批区（467）：`ApprovalArea` 放在主视图输入框上方与各视图的状态行之上，限高（留开头与按键行，中间写明省略），内容经 036 净化——此前树形视图等视图里的审批框原样显示，没有净化，这次一并补上。消息流的 `addApprovalBlock` 换成答完写一行结论的 `addConclusion`；回看历史按工具结果上记的审批结果（人答过的）补一行结论。
- 状态栏（468）：只写上下文用量与累计 token 数（记账不变，取三类 token 之和）；模型名与花费去掉。
- 审批模式（469）：运行面持当前模式单元，治理与 Run 开头记录、钩子的 permission_mode、脚本收回、派 worker 都按它读；切换写 `pigeon.approval-mode` 条目（会话文件没建时留在内存，同钩子记录）；trace 与 replay 认它；主会话的单元在 /reload、换工作树、/resume 时沿用，面板派会话按当时的模式新开单元。
- 面板方向键（470）：两下 ← 开面板并选中来源会话（第一下状态行提示，Ctrl+C 退出同一做法），面板里 → 进入；新设置 `tui.leftArrowOpensPanel`。

### 设置项核对（465）

对着设置的 schema 逐项核过。放进设置视图的 72 项（组、范围与缺省）：

| 路径 | 放否 | 组 | 范围与缺省 |
|---|---|---|---|
| `thinking.level` | 放 | model | off / minimal / low / medium / high / xhigh / max；缺省 by model |
| `modelRequest.maxRetries` | 放 | model | 整数 >=0；缺省 4 |
| `web.enabled` | 放 | web | 开关；缺省 true |
| `web.search.backend` | 放 | web | deepseek / zai / tavily；缺省 deepseek |
| `web.search.maxResults` | 放 | web | 整数 >=1，<=20；缺省 5 |
| `web.search.timeoutMs` | 放 | web | 整数 >=1；缺省 60000 |
| `web.fetch.timeoutMs` | 放 | web | 整数 >=1；缺省 30000 |
| `web.fetch.maxBytes` | 放 | web | 整数 >=1；缺省 2097152 |
| `web.fetch.maxChars` | 放 | web | 整数 >=1；缺省 400000 |
| `web.fetch.distillMaxTokens` | 放 | web | 整数 >=1；缺省 4096 |
| `contextPrune.enabled` | 放 | context | 开关；缺省 true |
| `contextPrune.protectTurns` | 放 | context | 整数 >=0；缺省 5 |
| `contextPrune.horizonTurns` | 放 | context | 整数 >=1；缺省 20 |
| `contextPrune.minBatchTokens` | 放 | context | 整数 >=0；缺省 10000 |
| `contextPrune.minResultTokens` | 放 | context | 整数 >=1；缺省 500 |
| `contextPrune.priceRatio` | 放 | context | 数 >=1；缺省 by model (50 if unknown) |
| `contextPrune.writeMultiplier` | 放 | context | 数 >=0；缺省 by model |
| `contextPrune.retentionSeconds` | 放 | context | 整数 >=1；缺省 by cache rules |
| `contextPrune.onCompaction` | 放 | context | 开关；缺省 true |
| `contextPrune.onIdle` | 放 | context | 开关；缺省 true |
| `contextPrune.staleReads` | 放 | context | 开关；缺省 true |
| `contextPrune.maxImageBytes` | 放 | context | 整数 >=1；缺省 8388608 |
| `truncationContinuation.enabled` | 放 | context | 开关；缺省 true |
| `truncationContinuation.maxConsecutive` | 放 | context | 整数 >=1；缺省 2 |
| `truncationContinuation.maxPerRun` | 放 | context | 整数 >=1；缺省 5 |
| `repetitionGuard.enabled` | 放 | context | 开关；缺省 true |
| `repetitionGuard.mode` | 放 | context | abort / log；缺省 abort |
| `repetitionGuard.preset` | 放 | context | omp / wide；缺省 omp |
| `repetitionGuard.checkIntervalChars` | 放 | context | 整数 >=1；缺省 by preset (128) |
| `repetitionGuard.windowChars` | 放 | context | 整数 >=1；缺省 by preset (4096) |
| `repetitionGuard.maxPeriodChars` | 放 | context | 整数 >=1；缺省 by preset (1024) |
| `repetitionGuard.minRepeats` | 放 | context | 整数 >=2；缺省 by preset (3) |
| `repetitionGuard.minRepeatedChars` | 放 | context | 整数 >=1；缺省 by preset (1024) |
| `repetitionGuard.shortPeriodChars` | 放 | context | 整数 >=0；缺省 by preset (60) |
| `repetitionGuard.shortMinRepeats` | 放 | context | 整数 >=2；缺省 by preset (4) |
| `repetitionGuard.shortMinRepeatedChars` | 放 | context | 整数 >=1；缺省 by preset (180) |
| `repetitionGuard.similarity` | 放 | context | 数 >0，<=1；缺省 0.8 |
| `repetitionGuard.segmentMaxChars` | 放 | context | 整数 >=1；缺省 by preset (700) |
| `repetitionGuard.segmentMinChars` | 放 | context | 整数 >=1；缺省 by preset (60) |
| `repetitionGuard.segmentWindow` | 放 | context | 整数 >=1；缺省 by preset (16) |
| `repetitionGuard.minSegments` | 放 | context | 整数 >=1；缺省 by preset (8) |
| `repetitionGuard.minCluster` | 放 | context | 整数 >=2；缺省 by preset (4) |
| `repetitionGuard.minConsecutive` | 放 | context | 整数 >=1；缺省 by preset (3) |
| `memory.projectLimitChars` | 放 | context | 整数 >=1；缺省 4000 |
| `memory.userLimitChars` | 放 | context | 整数 >=1；缺省 4000 |
| `tools.grep.maxResults` | 放 | tools | 整数 >=1；缺省 200 |
| `tools.glob.maxResults` | 放 | tools | 整数 >=1；缺省 100 |
| `tools.readFile.maxBytes` | 放 | tools | 整数 >=1；缺省 51200 |
| `tools.readFile.maxLineChars` | 放 | tools | 整数 >=1；缺省 2000 |
| `tools.runCommand.outputHeadBytes` | 放 | tools | 整数 >=1；缺省 8192 |
| `tools.runCommand.outputTailBytes` | 放 | tools | 整数 >=0；缺省 24576 |
| `tools.runCommand.savedOutputsMaxBytes` | 放 | tools | 整数 >=1；缺省 209715200 |
| `tools.runCommand.timeoutSeconds` | 放 | tools | 整数 >=1；缺省 120 |
| `tools.runCommand.maxTimeoutSeconds` | 放 | tools | 整数 >=1；缺省 600 |
| `tools.runCommand.maxBackgroundJobs` | 放 | tools | 整数 >=1；缺省 2 |
| `tools.runCommand.maxBackgroundJobsTotal` | 放 | tools | 整数 >=1；缺省 8 |
| `tools.runCommand.backgroundOutputMaxBytes` | 放 | tools | 整数 >=1024；缺省 16777216 |
| `tools.runCommand.backgroundCloseoutSeconds` | 放 | tools | 整数 >=0；缺省 600 |
| `sessionSearch.enabled` | 放 | tools | 开关；缺省 true |
| `loopGuard.enabled` | 放 | guards & hooks | 开关；缺省 true |
| `loopGuard.remindAt` | 放 | guards & hooks | 整数 >=1；缺省 5 |
| `loopGuard.warnAt` | 放 | guards & hooks | 整数 >=1；缺省 10 |
| `loopGuard.stopAt` | 放 | guards & hooks | 整数 >=1；缺省 20 |
| `disableAllHooks` | 放 | guards & hooks | 开关；缺省 false |
| `stopHookBlockCap` | 放 | guards & hooks | 整数 >=1；缺省 8 |
| `worktree.baseRef` | 放 | workspace | fresh / head；缺省 fresh |
| `snapshot.untrackedFileMaxBytes` | 放 | workspace | 整数 >=0；缺省 10485760 |
| `snapshot.untrackedTotalMaxBytes` | 放 | workspace | 整数 >=0；缺省 209715200 |
| `sandbox.memory` | 放 | workspace | 字符串（格式核对）；缺省 half of the Docker host memory |
| `sandbox.pids` | 放 | workspace | 整数 >=0；缺省 4096 |
| `sandbox.cpus` | 放 | workspace | 数 >=0；缺省 0 (no limit) |
| `tui.leftArrowOpensPanel` | 放 | interface | 开关；缺省 true |

另有键位一组（每个动作一行，Pigeon 的 `pigeon.*` 在前、pi-tui 部件的 `tui.*` 在后）。

不放的：

| 路径 | 理由 |
|---|---|
| `$schema` | 只给编辑器用，不影响行为 |
| `trustedDirectories` | 权限类（且只许写在用户级） |
| `permissions.grants`、`permissions.readDeny` | 权限类（readDeny 已不生效）；`/grants` 照旧查看 |
| `web.search.deepseek.baseUrl`、`web.search.zai.baseUrl`、`web.search.tavily.baseUrl`、`web.search.deepseek.model` | 自由文本的地址与模型名，写错了搜索就坏；照旧在设置文件里写 |
| `loopGuard.exemptTools` | 数组 |
| `sandbox.image`、`sandbox.dockerfile`、`sandbox.context`、`sandbox.build.*` | 自由文本与路径；Dockerfile 路径按各项目根解析，写进用户级对所有项目都生效没有意义；镜像与源另有环境变量 |
| `orchestration.*`、`commands.roles`、`messaging.*` | 即将随子 agent 与会话统一改造删除（messaging 现在也不生效） |
| `commands.commands` | 结构复杂（短名 → 命令串） |
| `hooks.*` | 钩子配置本身 |
| `mcp.servers` | 结构复杂 |
| `modelInfo.models` | 按模型覆盖 |
| `keybindings` | 不在本表逐项列，单独成键位组 |

写入与校验：每改一项先核对整份用户级文件（schema 与层规则），再把三层合并起来跑合并后的检查（loopGuard 三个轮数递增、repetitionGuard 的窗口不小于最长重复单元乘最少重复次数、sandbox 的 image 与 dockerfile 不并存、memory 至少 6m 等），过不了即不写。各节都允许只写一个子字段（读取处逐项补缺省，三层按键深合并）。不随重建当场生效的几项写在文档里：`web.search.backend`（web_search 可用性变了要重启）、`worktree.baseRef`（新建工作树时才读）、`sandbox.*`（开沙箱时才读，改了要重新确认）。

### 验证

- `tsc --noEmit`、biome、dependency-cruiser 干净。
- 本机分批跑了全部测试（内存不够一次跑完；每批两个并行进程）：`src/tui` 54 个文件全部通过（全屏用例里状态栏的断言跟着改了，重跑通过）；`src/application` 124 个文件，失败 2 条；其余目录 172 个文件，失败 2 条。这 4 条都是本机已知失败（`checkpoints-async` 保留修改时间的同长度覆盖、`spawn-worker-headless` 撞上时间上限、`container-host` 与 `container-round-trips` 本机没有建符号链接的权限），与本批改动无关。
- 整套一次跑与打包冒烟交给 pigeon-verify。
