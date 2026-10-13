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

## 六、审查修正（3683d66 之后）

### 改了什么

1. 删除的边界：只删"在回退点快照里确定不存在、且是 agent 在两点之间新建"的文件（该 Run 发消息时的快照里没有、收尾时的快照里有）。其余要删的、这段里 `.gitignore` 变过的、按现在的规则被忽略的，一律列为拿不准（写明原因），缺省保留。会话里任何快照记为"过大没收"的路径整体不碰（不删不写），选择处与结果里列出。
2. 写回中途出错：逐文件写，出错即停；已写、已删、存下的原样字节与出错的文件照实记进 `pigeon.rewind`（新字段 `failed`、`target`、`removedDirs`），对话不退，界面如实列出（不再显示"没有回退"）。新增"撤销上次退代码"：消息树当前位置回车，若主分支上最后一次退代码写了或删了文件，即可按它记下的还原前现状快照把这些文件恢复（写回之后又被改过的列为拿不准）；撤销本身记为 `undo`，之后不再提供撤销。只退代码时同样可以撤销。
3. 行尾：写回不再用 `cat-file --filters`。存下过原样字节的写原样字节；否则取快照里的原样对象（快照以空树为属性来源、不跑过滤器），按工作区当前的 `.gitattributes`（`git check-attr eol text`，不带空树属性来源，只读属性、不执行过滤驱动）与 `core.autocrlf` 自己转换：`-text` 原样；`eol=lf/crlf` 照写；`text` 已设按 autocrlf；没设属性时 autocrlf 开着即照磁盘上现有文件的行尾（没有现有文件写 CRLF），关着原样。git 不认 `--attr-source` 时，没有存下原样字节的文件不写并写明原因。
4. 没有发消息时的快照（拍失败、超时、命令行里发的）：回退点之后两条分支上任一 Run 没有它，即只给退对话并写明原因；规划不再以首份 agent 快照的父提交为起点。
5. 权限：覆盖已有文件不改权限位；新建的以 0666 交给 umask，快照里可执行的另把有读权限的那几类加上执行位。
6. 空目录：只删"删 agent 新建的文件后变空、目标快照里那时这个目录下没有文件、且目录建立时刻不早于新建其中文件的那个 Run 开始"的目录；取不到建立时刻（为 0）不删。删了的记在 `removedDirs`。
7. 核对与写入的竞态：先把要写的内容全部从 git 取到内存；逐文件读一次现有字节、算规范化哈希核对、存原样字节，写之前再 lstat 一次（仍是普通文件）并再读一次比对原样字节（sha1），变了即跳过并列出；POSIX 以 `O_NOFOLLOW` 打开（新建 `O_CREAT|O_EXCL`）。Windows 上数字形式的打开标志会 EINVAL，改用 `wx`（新建）与 `r+` 加截断（覆盖），靠写前的 lstat 核对。
8. 大小写：`.pigeon` 段判断不分大小写；仓库 `core.ignorecase` 为真时，只差大小写的几条在规划分类时整体列为拿不准，写回模块也一律不写。
9. 授权补记与挪主分支：写者新方法 `rewindLane` 在同一个写入请求里核对叶子、挪主分支、依次写回退记录与授权补记（取代 `moveMain`）；补记按目标分支在挪动之前算好。叶子在写回期间变了（作业结束条目等）即什么都不写，回退记录另记在当前位置，对话不退并说明。
10. 跨工作区：回退点与现在的"最后一条 `pigeon.worktree`"不同即不退代码（写明原因）；退对话时在新位置补记现在的那条工作树条目，续接取到同一个工作区；目标分支在工作树里而现在在主检出时不能切过去。
- 建议项：比较叶子与挪主分支在同一个写入请求里（见 9）；会话树每个节点的花费按会话文件全部分支（`session-family.ts`）。

### 测试

- `src/application/rewind.test.ts` 加 11 条（共 20 条，权限一条在 Windows 上跳过）：agent 改 `.gitignore` 放出 `.env` 后退代码不删 `.env`；快照记为过大的文件被 agent 改小后不删不写；只读文件让写回中途出错（停在出错处、已写的记下、对话不退）后撤销回到原样、撤销之后不再可撤销；只退代码之后可撤销；没有发消息时的快照只给退对话；0600 的权限保持（POSIX）；使用者原有的空目录不删、agent 新建的删空即删；换上下文时出错后续接，撤过的授权仍是撤销；跨进独立工作树只给退对话、退后补记工作树；目标在工作树里而现在不在不能切过去（构造的会话文件）；切回 agent 删过使用者文件的分支时删除列为拿不准；写者在叶子不对时什么都不写。
- `src/orchestration/rewind-restore.test.ts` 加 2 条（共 6 条）：`*.sh text eol=lf` 在 autocrlf 开着时写 LF；不分大小写的文件系统上只差大小写的两条与 `.Pigeon/state/x` 都不写。
- `src/tui/rewind.test.ts` 加 2 条（共 7 条）：当前位置回车给撤销并走拍现状与写回；写回中途出错时列出写了的与出错的、对话不退、原消息不放回输入框。既有用例的改动：手改文件那条的结果措辞改为"保留了拿不准的"（冲突现在带原因）。

### 验证

- 变异核对（均已恢复）：16 处，第一轮 15 处变红；保持绿的"授权补记不放进挪动的同一请求"是用例的撤销写在了目标分支上（不靠补记），把撤销挪到第二条消息之后重跑即变红。变红的包括：删除不查是否 agent 新建、不查忽略规则变过、碰过大没收的文件、没有发消息快照也给退代码、跨工作树不补记、不拦切到工作树分支、可重复撤销、出错后照样挪对话、出错不报、写回出错吞掉继续、忽略 `.gitattributes` 的 eol、只差大小写的照写、`.pigeon` 区分大小写、写者不核对叶子、删任意空目录。
- 回归（一个 vitest 进程）：src 根 3 条边界测试、src/tui、src/cli、src/state、src/persistence、src/pi-runtime、src/orchestration 全部与 rewind、checkpoints、checkpoints-async、session-cost、session-family、background-jobs、session-runtime、history、fork、format、config-options、session-settings、settings-reload、tui-exit、resume、enter-worktree-tool、named-worktree，165 个文件 941 条通过、10 条跳过、1 条失败（`checkpoints-async.test.ts` 的"保留修改时间的同长度覆盖"，基线上同样失败）。整仓 `npx biome check .` 无问题、`tsc` 通过、`npm run deps` 无违规。
- 真实运行（真实模型、临时 git 仓库 `core.autocrlf=true`、临时 HOME 等，同第三节的脚本）：规划 `notes.txt`、`src/extra.txt`，没有冲突；退回后 `notes.txt` 为 `alpha\n`、`src/extra.txt` 删掉、手改的 `manual.txt` 不动；切回后两文件哈希与回退前一致；续跑答 2。打包产物隐藏窗口起终端界面 10 秒仍在。全局 git 配置的哈希核对未变。

### 尚待确认（补充）

- 核对与写入之间的竞态没有确定性的用例（要在两次读取之间插入改动）；变异核对未覆盖这一段。
- git 不认 `--attr-source` 的旧版本上"不写并说明"的分支没有用例（本机 git 认）。
- 权限一条只在 POSIX 上跑（验证机）。
- 撤销只针对主分支上最后一次退代码；连续撤销多次、或撤销之后再撤销不提供。

## 七、第二轮复查修正（ed78ada 之后）

总原则：退代码拿不准就不写，列出来交给人，缺省保留。

### 改了什么

1. 过滤后形态：没有存下原样字节的路径，按工作区当前的属性（`git check-attr eol text filter working-tree-encoding`，不带空树属性来源，读 `.gitattributes`、`.git/info/attributes` 与全局属性，不执行驱动；读不到属性按有过滤处理）判断：有 `filter` 或 `working-tree-encoding` 的、快照内容是 LFS 指针的，列为"无法保真还原"、不写。
2. `-text`（或 binary）而 `core.autocrlf` 为 true 或 input 的文本：快照时已被规范化，没有原样字节即不写，列出。二进制内容（含 NUL）不受影响。
3. 两条消息之间的手改：回退范围内当前分支上相邻两个 Run，比较"上一个 Run 收尾（没有 agent 快照即开工）时的快照"与"下一个 Run 发消息时的快照"，其间变过的路径若在规划里即列为"两条消息之间被手改过"。Run 进行中的手改仍分不出（436 已写的盲区）。
4. 硬链接：磁盘上的文件链接数大于 1 的不写不删，列出；写前的最后一次 lstat 同样核对。
5. 中途出错的一致性：退代码动手之前先写一条意图记录（`pigeon.rewind` 带 `phase: "intent"`、`rewindId`、还原前快照、目标快照、计划写的路径）；每个文件动手之后当场追加一条 `pigeon.rewind-step`（写了、删了、出错，带动手前存下的原样字节），写入经 `rewindLane` 核对叶子，期间有别的写入即记下、对话不退；做完再写收尾记录。出错的文件计入撤销范围（撤销时不论现状照退）。整块写用 `writeFileSync(fd, …)`（循环写满）。快照器对齐（resync）出错、挂引用出错、收尾记录没写成都不再抛出，结果里如实列出（"没做成：…"）。撤销中途出错的不算撤销过，可以再撤；撤销查找按 `rewindId` 汇总逐个文件的结果（中途退出、没有收尾记录也能撤）。
6. 撤销查工作区：那次退代码的记录之后，主分支上出现过 `pigeon.worktree` 即不能撤销，写明原因。
7. 原样字节防回收：每次退代码后把存下的原样对象挂到 `refs/pigeon/rewind/<会话号>/<rewindId>`（指向一个只含这些对象的提交）。读不到（被回收）时只这一个文件列为无法保真，其余照写；取快照内容时某个文件出错同样只跳过它。
8. 目录建立时刻：`birthtimeMs` 为 0 或与 `ctimeMs` 相同（老 Linux 上 libuv 以 ctime 充当）即按取不到处理，不删目录（`bornAtOf`）。
9. 权限：恢复被删的文件（新建）一律 0600，快照里可执行的为 0700；覆盖已有文件仍不改权限位。文档写明可能比原来窄。
- 残留风险（写进文档与本审计，没有改）：挪主分支与授权补记在同一个写入请求里，但落盘是先后两次追加，进程恰在两次之间被杀时撤过的授权会在续接后复活，窗口极小；`.git/info/attributes` 里配的过滤器在拍快照（checkpoint）时会执行，属快照的既有行为，另列给产品端。

### 测试

- `src/orchestration/rewind-restore.test.ts` 加 5 条（共 11 条，0600 一条只在 POSIX 上跑）：过滤器（含 `.git/info/attributes`）、`working-tree-encoding`、LFS 指针、`-text` 而 autocrlf 开着都不写、普通文件照写；有别的硬链接的不写、仓库外的文件不变；存下的原样对象读不到时只跳过这一个；目录建立时刻等于 ctime 或为 0 按取不到；恢复被删的文件 0600 与 0700。既有用例改为等待异步的写回。
- `src/application/rewind.test.ts` 加 3 条（共 23 条）：两次 agent 改动中间夹的手改列为冲突、缺省保留；意图记录、逐个文件的结果与收尾记录的先后，原样字节的引用存在，撤销中途出错（只读）之后可以再撤并恢复原样；退代码之后移进过工作树不能撤销。既有用例的改动：写回中途出错那条的撤销范围现在含出错的文件（新定的语义）。

### 验证

- 变异核对（均已恢复）：12 处，首轮 11 处变红；"出错文件计入撤销范围"保持绿是用例里只读文件在打开时就失败、没被截断——在用例里把出错的文件清空模拟截断、并补上它被恢复的断言后重跑变红。变红的包括：不查过滤器、不查 working-tree-encoding、写出 LFS 指针、-text 照写、硬链接照写、原样对象读不到即整体失败、建立时刻等于 ctime 也算、两条消息之间的手改不报、出错的撤销也算撤销过、撤销不查工作区、不挂引用。
- 回归（一个 vitest 进程）：src 根 3 条边界测试、src/tui、src/cli、src/state、src/persistence、src/pi-runtime、src/orchestration、src/approvals 全部与 rewind、session-pool、checkpoints、checkpoints-async、session-cost、session-family、session-runtime、format、named-worktree、enter-worktree-tool、resume，164 个文件 919 条通过、10 条跳过、1 条失败（`checkpoints-async.test.ts` 的"保留修改时间的同长度覆盖"，基线上同样失败）。整仓 `npx biome check .` 无问题（回归时报的一处用例写法已改）、`tsc` 通过、`npm run deps` 无违规。
- 真实运行（真实模型、临时 git 仓库 `core.autocrlf=true`、临时 HOME 等，同第三节的脚本）：规划 `notes.txt`、`src/extra.txt`，没有冲突；退回后 `notes.txt` 为 `alpha\n`、`src/extra.txt` 删掉、手改的 `manual.txt` 不动；切回后两文件哈希与回退前一致；续跑答 2。全局 git 配置的哈希核对未变。

### 尚待确认（补充）

- 收尾记录与快照器对齐出错的路径没有确定性的用例（要让会话存储或 git 在中途失败）。
- 磁盘写满时的半截写没有用例（改为循环写满之后，出错即按写回失败停下并列入撤销范围）。
