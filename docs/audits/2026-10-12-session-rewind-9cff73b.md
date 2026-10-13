# 会话回退（决策 433–438）审计

基线 9cff73b，分支 worktree-product-build。

## 一、改了什么

- 会话记录：新条目 `pigeon.turn-snapshot`（发消息时的工作区快照：Run 号、ref、提交、树、过大没收的未跟踪文件）与 `pigeon.rewind`（回退或切换分支：之前的叶子、目标点、退了什么、还原前的现状快照、写了、删了、因手改保留、因护栏没动的路径，以及被覆盖或删掉的文件的原样字节对象）。`src/state/session-entries.ts`、`src/application/session-store.ts`（`turnSnapshotEntry`、`rewindEntry`）。
- 发消息时的快照（436）：`PiRuntimeAdapter.subscribeRunStart`（Run 开始条目排进写入之后、第一次模型请求之前通知）；`attachCheckpoints` 新选项 `turnSnapshots`，Run 开始时在后台 `snapshotNow`，拍完写 `pigeon.turn-snapshot`；第一个工具执行前照旧经工具等待口等它拍完，拍失败只告警不写条目。只有终端界面开（`openSessionRuntime` 的 `turnSnapshots`，`tui/main.ts` 与 `main-reload.ts` 传 true）。
- 写者：`SessionStoreWriter.leafId()`、`moveMain(entryId | null)`（经写入队列调 pi 的 `moveLane`，条目不存在报错）。
- 运行面就地换上下文：`PiRuntimeAdapter.replaceMessages`（空闲时换掉 Agent 的消息，运行中或手动压缩中拒绝）、`StatusTracker.reseed`、`ContextPruner.reseed`、`TaskList.replace`；快照器 `Checkpointer.resync`（写回之后以现状为比较起点，还没有快照时记为改前基线）。
- 新文件 `src/application/rewind.ts`：
  - `rewindTree`：读整个会话文件拼消息树——每个人发起的 Run（Run 开始之后第一条人输入，跳过状态块，程序通知、作业通知、会话间消息不算）一个节点，父节点是往上最近的那个；分支末端：当前叶子总列，其余只列下面没有更多消息、且 Run 收了尾的叶子；缩进只在有多个孩子处加一级。
  - `planRewind`：当前叶子与目标点的公共前段之后，两边各 Run 的 agent 改动 = 该 Run 发消息时的快照（没有即首份 agent 快照的父提交）到最后一份 agent 快照之间变了的文件；"agent 留下的样子"取 agent 最后一次改它的那个 Run 收尾时的快照，只在目标分支上改过的取分叉处；目标内容取目标分支在分叉之后最后一个有快照的 Run 收尾（或开工）时的快照，没有即分叉处。各 Run 的快照按 Run 号从整个会话文件收（见自定的细节）。
  - `classifyPlan`：拿现状快照分出"已是目标""直接退"与"手改过"。
  - `prepareRewind`、`checkCode`（先等快照拍完、再 `snapshotNow` 拍现状）、`applyRewind`（核对叶子没变 → 写回 → `resync` → 挪主分支 → 写 `pigeon.rewind` → 437 补记授权 → 从文件还原上下文、任务清单、状态块与裁剪起点）。
- 新文件 `src/orchestration/rewind-restore.ts`：`SnapshotTrees`（ls-tree、diff-tree、父提交）与 `restoreFiles`（护栏与原样字节，见下）。
- 决策 438：作业号按全部分支（`previousJobsOfSession`：丢失的作业看主分支，最大作业号看整个文件）；会话花费按全部分支（`readSessionBranchViews` 读每个叶子的视图，`branchesCostTally` 按消息条目去重相加；`sessionCostTally` 与 `accumulatedSessionCost` 的本会话部分改用它）。
- 终端界面：新文件 `src/tui/tree-list.ts`（通用树列表：压平的行、光标、按光标滚动、说明行），`SessionTree` 改用它；新文件 `src/tui/message-tree.ts`（消息树：树、三选一、手改文件逐个选、进行中四种状态；文字 036 净化、压成一行）。`shell.ts`：树形视图第三种模式 `messages`、`rewind` 选项（`TuiRewindFace`）、`/rewind`、双击 Esc（`idleEscape`，500 毫秒，`modal.ts` 的取消键在空闲时问它）、回退进行中占住输入与排队、消息树开着时不发排队、退完清空消息区按新主分支重绘（`MessageFlow.clear`）、原消息放回输入框、写回结果逐项写明。`command-table.ts`、`commands.ts` 登记 `/rewind`（运行中不可用）。`tui/main.ts` 按当前运行面现取回退面。
- 文档：`docs/configuration.md` "终端界面"一节加"会话回退 `/rewind`"，键位表 `pigeon.cancel` 补双击说明。

## 二、测试

- 新文件 `src/application/rewind.test.ts`（9 条，运行面与终端界面同一条装配路径、假模型、临时 git 仓库）：改—退—切回（core.autocrlf 关与开各一条）：只退 agent 改过的、新建的删掉连同空目录、两条消息之间手改与手建的不碰、对话换成目标分支、切回后文件逐字节一致、发消息时的快照每个 Run 一条；agent 改后又被手改的列为冲突、缺省保留、选了才退，被忽略的文件不动，只退代码时对话不动；非 git 工作区只退对话、选点后又有新内容拒绝、切回再退不留多余末端、重发形成两条分支、状态块与裁剪起点按目标分支重设；一个 Run 最后那份快照的条目落在下一个 Run 开始之后时，退到更早一条之前照样退掉它的改动；授权沿用回退前（补记 1 条授权、1 条撤销）；花费按全部分支（回退前后相等）；作业号按全部分支。
- 新文件 `src/orchestration/rewind-restore.test.ts`（4 条）：上级目录是目录联接时不写、仓库外的文件不动；`.pigeon` 下、目标是符号链接、磁盘上有而现状快照没有、规划之后又被改过的都不碰；原样字节往返（行尾转换开着）；没有原样字节时 LF 文件照 LF 写、CRLF 文件按检出规则写。
- 新文件 `src/tui/rewind.test.ts`（5 条，回退面用替身）：双击打开、单击与输入框有字不开（另直接调 `idleEscape` 核对）、消息里的控制序列不写进终端、当前位置回车不动；`/rewind` 打开、三选一、只退对话不拍现状、原消息放回输入框、运行中 `/rewind` 被拒且 Esc 不开消息树；没有代码要退时只给退对话；手改文件逐个选（缺省保留、空格切换）、写回结果列出；消息树开着时排队的输入不发、关了即发。
- 既有用例的改动：`src/tui/input-queue.test.ts` 的"运行中不可用"清单加 `rewind`（新命令）。

## 三、验证

- 变异核对（均已恢复）：第一轮 24 处 18 处变红；保持绿的 6 处（开工起点只取父提交、选点后叶子变了不拒、末端列出全部叶子、`.pigeon` 护栏、状态块与裁剪起点不重设、输入框有字也算双击）补了用例后与新加的两处（快照只按路径收、没有原样字节时不照 LF 写）一并重跑，8 处全部变红。变红的包括：不拍发消息时的快照、不分手改与 agent 改动、丢掉只在目标分支改过的文件、不补记授权与撤销、缩进不分层、上级目录联接护栏、现状快照外的文件、规划后被改过的、原样字节、花费重复计、作业号只看主分支、单击即开、不放回原消息、不净化、总给三个选项、消息树开着照样发排队。
- 回归（一个 vitest 进程）：src 根 3 条边界测试、src/tui、src/cli、src/state、src/persistence、src/pi-runtime、src/orchestration 全部与 rewind、checkpoints、checkpoints-async、session-cost、background-jobs、session-runtime、history、fork、format、config-options、session-settings、settings-reload、tui-exit、resume，163 个文件 908 条通过、9 条跳过、1 条失败——`checkpoints-async.test.ts` 的"保留修改时间的同长度覆盖"，改动之前（暂存全部改动、在基线上单跑）同样失败。整仓 `npx biome check .` 无问题、`tsc` 通过、`npm run deps` 无违规。
- 真实运行（真实模型即打包的 deepseek 接入，临时 git 仓库，`core.autocrlf=true`，临时 HOME、XDG、全局 git 配置）：脚本按终端界面同一套装配开运行面（`turnSnapshots` 开），第一条让模型建 `notes.txt`（alpha），手改 `manual.txt`，第二条让模型把 `notes.txt` 改成两行并新建 `src/extra.txt`。消息树 3 个节点（两条消息、当前末端）；退到第二条之前（两者都退）：规划 `notes.txt`、`src/extra.txt`，没有手改冲突，写回 `notes.txt` 为 `alpha\n`（字节与模型写的一致）、删掉 `src/extra.txt`、`manual.txt` 保持手改；对话最后一条是第一条的回复。切回原分支末端：两个文件的哈希与回退前一致。之后再发一条问 `notes.txt` 有几行，模型答 2。全局 git 配置的哈希核对未变。
- 打包产物在隐藏窗口里起终端界面（临时 HOME 等、临时仓库）10 秒后仍在运行。消息树的按键需要人操作，未做。

## 四、自定的细节

- 不重建运行面，就地换上下文：施工说明写的是按 `/reload` 的先建后换重建；但 `/reload` 的重建在有 worker 在跑时被拒（编排器随运行面重建），决策 438 要求回退时 worker 与后台作业照常跑、不拦。所以改为空闲时就地换：Agent 的消息、任务清单、状态块与裁剪起点按目标分支从文件取（与续跑同一套函数），授权、后台作业、worker、MCP、快照器都留在内存里接着用。
- 消息节点是"人发起的 Run"：退到这条消息之前 = 主分支挂到该 Run 开始条目的父条目上。程序通知（worker、脚本、打转、作业通知）与会话间消息发起的 Run 不列，它们之后的分支末端照常列。
- 分支末端只列：当前叶子；以及下面没有更多消息、所属 Run 收了尾的叶子（撞上限续跑移出的截断回复、回退留下的空位置不列）。
- 各 Run 的快照按 Run 号从整个会话文件收，不只看路径：Run 最后一份快照在后台拍，条目常在下一个 Run 开始之后才写下（测试与真实运行里都出现过），回退到下一个 Run 之前时它落在旧分支上。
- "agent 留下的样子"按文件取 agent 最后一次改它的那个 Run 收尾时的快照（不是整条分支最后一份）：改后到下一个 Run 之间的手改因此算手改，列为冲突。
- 发消息时的快照没拍成（失败、旧会话）的 Run，以它首份 agent 快照的父提交为起点，此时两条消息之间的手改会混进 agent 的改动（与 436 写的盲区同类）。
- 原样字节：回退覆盖或删掉文件前，把它原样（`hash-object --no-filters -w`）存进对象库，记在 `pigeon.rewind` 的 `saved`；之后写回某文件时，若存下过规范化内容与目标相同的原样字节即写它。没有存下的：磁盘上现有的文件没有 CRLF 即照 LF 写（不经检出转换），否则按 `cat-file --filters`（检出规则）写。目的是本机 `core.autocrlf=true` 时 agent 写的 LF 文件往返不变成 CRLF。这些对象没有 ref 钉住，git gc 可能在宽限期后回收（回收后退回到检出规则）。
- 写回护栏：每个文件写前再算一次规范化哈希，与现状快照不同即不写（规划后被改过）；磁盘上有、现状快照里没有的不写（被忽略、过大）；路径带 `.pigeon` 段、目标模式不是普通文件、磁盘上是符号链接或目录、上级任一级是符号链接或目录联接、上级实际位置在仓库外的不写。写回范围以仓库根为准（快照覆盖整个仓库）。
- 只退代码：主分支不动，`pigeon.rewind` 写在当前叶子后，`to` 记所选的点。
- 选点之后、执行之前主分支叶子变了（期间来了作业通知等）即拒绝，提示重新打开；消息树开着时不从排队里发输入与通知。
- 双击间隔 500 毫秒；输入框有字、有补全、会话选择器或设置面板开着、不在主视图时不算。
- 消息树的 Tab：有回退面时会话树 Tab 去消息树（表头写 `[tab] messages`），消息树 Tab 回运行中（有 worker 编排面时）；没有回退面时会话树照旧回运行中。
- 授权补记：目标分支上"建立减撤销"与内存里的生效授权逐个对：内存有、分支没有的补一条建立（沿用原授权号与首次调用）；分支有、内存没有的补一条撤销。
- 花费：每个叶子一个视图，按消息条目号去重；worker 与复盘子会话仍按各自主分支。

## 五、尚待确认

- 消息树与三选一、手改文件逐个选在真实终端里的观感与按键（需要人操作；用例与真实运行走的是同一套应用层函数）。
- 双击 Esc 在真实终端里的手感（500 毫秒）。
- 本机 `src/application/checkpoints-async.test.ts` 的"保留修改时间的同长度覆盖"一条在改动之前就失败（暂存全部改动后在基线上同样失败），与本段无关，未改。
- 存下的原样字节对象没有 ref 钉住，是否需要钉。
