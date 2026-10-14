# 子 agent 统一改造（一）：删除脚本编排（决策 457、477）审计

基线 3dd0804。本块只删脚本编排；worker 编排器内部为脚本留的字段（派出请求与派出、收尾条目上的 `script` 标记、续接时按它跳过补递）随 worker 重度管理一起在下一块删，本块不动。

## 一、删除清单

### 斜杠命令与按键

- `/orchestrate <task> [budget …]`、`/orchestrate resume <run ID> [budget …]`、`/orchestrate stop [run ID]`、`/orchestrate drop <run ID>`：命令表一行、分发、用法文字（`application/script-commands.ts`）。
- 运行中输入的特例：`/orchestrate <任务>` 原先与普通输入一样排队、不回显交给模型的包装（`shell.ts` 的 `isOrchestrateTask`、`submitInput`）。现在运行中的斜杠命令一律按命令表判定。
- 树形视图里选中 worker 按 `X` 停止整个脚本。
- 审批面板 `[s]`（本次脚本内同类都允许）：键位动作 `pigeon.approval.scriptKind`、面板的键与回显、`ApprovalRequest.script`、`ApprovalDecision.scope: "script-kind"`、审批块里的"脚本收回"来源行。

### 模型工具与提示

- `orchestrate` 工具（参数 name、phases、script、args、resume_run）及工具说明、参数说明、返回文字（`script-tool.ts`、`script-texts.ts`）。
- 点名判定：人输入里的 `script orchestration` 关键词、`budget` 额度解析、旧中文关键词（`script-naming.ts`）；`pigeon run` 的任务描述算点名、写金额时的提示。
- 给脚本派出的 worker 附加的输出格式说明与改正提示（`schemaAppendix`、`schemaCorrection`）与 JSON Schema 校验（`state/json-schema-check.ts`）。
- worker 不能拿到的工具清单里的 `orchestrate`（`orchestration/roles.ts`）。

### 运行器与容器

- 脚本运行器（`script-runner.ts`：分批派出、接力、阶段、续跑指纹、结束汇总、卡住监控、额度）、宿主绑定（`script-host.ts`：收回、价格、容器启动）、审批包装（`script-approvals.ts`）、调用指纹（`orchestration/script-fingerprint.ts`）。
- 脚本容器（`execution/script-sandbox.ts`）与主目录快照引用（`execution/script-snapshot.ts`，`refs/pigeon/scripts/<运行号>`）。
- `WorkerNotices.hold()`（脚本结束前算作还有未交回的结果）。
- 按环境注册里的 docker 检查：只为 `orchestrate` 服务，连同 `executableOnPath` 删除；开局不再查 PATH。

### 设置

- `orchestration.script.modelDecides`、`orchestration.script.budget`、`orchestration.script.stallMinutes`，以及合并检查里"额度只收 token"的报错。`orchestration` 其余键随下一块删除并改为开局报错（Q4），本块里写了 `orchestration.script` 的设置文件按未知键报错。

### 界面

- 树形视图的脚本与阶段两层（`OrchestrationScriptNode`、`OrchestrationPhaseNode`、树行种类 `script`、`phase`）。
- 输入时"script orchestration not enabled: …"的报错行。
- 脚本 `log` 行、开跑计划行。

### 删除的文件（共 20 个，约 4,650 行）

| 文件 | 行数 |
|---|---|
| src/application/script-runner.ts | 1035 |
| src/application/script-fixtures.ts | 342 |
| src/application/script-host.ts | 284 |
| src/application/script-texts.ts | 201 |
| src/application/script-tool.ts | 154 |
| src/application/script-naming.ts | 124 |
| src/application/script-approvals.ts | 109 |
| src/application/script-commands.ts | 78 |
| src/execution/script-sandbox.ts | 193 |
| src/execution/script-snapshot.ts | 65 |
| src/orchestration/script-fingerprint.ts | 38 |
| src/state/json-schema-check.ts | 132 |
| src/application/script-wiring.test.ts | 443 |
| src/tui/script-ui.test.ts | 371 |
| src/application/script-runner.test.ts | 367 |
| src/application/script-resume.test.ts | 215 |
| src/application/script-acceptance.test.ts | 167 |
| src/application/script-approvals.test.ts | 125 |
| src/execution/script-sandbox.test.ts | 112 |
| src/application/script-docker.test.ts | 95 |

另删的测试：`take-worker-tool.test.ts` 里"脚本整批收回按受保护路径请示"、`review-fixes.test.ts` 里"运行中 /orchestrate"、`settings.test.ts` 里"脚本的缺省额度"三条；`tool-environment.test.ts` 去掉缺 docker 一例与 `orchestrate` 的断言；`orchestration-ui.test.ts` 去掉脚本与阶段两层的断言。

## 二、保留的（决策 477）

- `application/history.ts` 照旧认出旧会话里的 `[Script notice] `、`[脚本通知] ` 前缀（两行常量，显示成程序行，不当成人说的话），以及 `/orchestrate` 交给模型的三种包装（决策 475 之后与之前的英文开头、决策 428 之前的中文原文），回看历史、回退列表与续接列表的首条输入照旧还原成 `/orchestrate <任务>`。原先这些常量从已删的模块导入，现写在 `history.ts` 里。测试 `history.test.ts`、`rewind.test.ts` 里的包装改为本地常量生成。
- 已在使用者仓库里的 `refs/pigeon/scripts/<运行号>` 引用不清理（只占引用，不影响检出；要删用 `git update-ref -d`）。

## 三、其他改动

- `tui/hooks-stop.test.ts` 原先借 `submitInput` 提交，改为经输入框提交（回显与否不影响断言）。
- `git-head-record.test.ts` 用到的建临时仓库的两个函数原在脚本测试夹具里，挪进该测试文件。
- 注释与文档里"脚本编排"的提法删掉：`settings-reload.ts`、`worktree-cleanup.ts`、`tui/main.ts`、`worktree-switch.ts`、`approval.ts`。

## 四、文档

- `docs/configuration.md`：设置快照、各节表的 `orchestration` 说明、按环境注册（去掉 docker 一句）、快照、worker 工具清单、explorer、工作树清理（脚本派出的一条）、`.worktreeinclude`、审批 `[s]`、树形视图、给模型的文字、脚本编排的点名与额度（整条删）、键位表、`/reload`、受保护路径。
- `docs/roadmap/ROADMAP.md`：3.9 标题与交付表"脚本编排"一行加删除标注。
- `docs/roadmap/decisions.md`：309–314、475 标已退役；294、301、303、359 标部分已改；新增 477。

## 五、检查

- 本机：`tsc --noEmit`、`biome check`、`dependency-cruiser` 通过；受影响的测试分两批跑过（history、rewind、tool-environment、git-head-record、take-worker-tool、hooks-stop、keybindings；orchestration-ui、review-fixes、settings、input-queue、orchestration-wiring、approval 各测试、headless），另跑了 `src/tui` 全部测试。
- 全量测试与打包冒烟在服务器上跑。

## 六、独立审查

对提交 5a72de4 另派审查（只读，在提交的快照上跑 tsc 与相关测试）。没有发现正确性问题：旧会话的三种 `/orchestrate` 包装与两种通知前缀与 3dd0804 的原文逐字一致，模块常量没有先用后定义，运行中输入斜杠命令一律按命令表判定（`/orchestrate` 现在是未知命令），旧设置里绑了 `pigeon.approval.scriptKind` 的只提示一行、不挡开局；没有 CR 换行。

指出的残留与处理（另一提交）：

- `RuntimeDeps.env`（只为查 docker 的 PATH）已无人读：删掉，`tool-environment.test.ts` 里为它建的临时目录一并删掉。上文"开局不再查 PATH"至此才完全属实。
- `submitNow` 的 `echo` 参数、`WorkerNotices` 内部 `#deliver` 的 `prefix` 参数已无人用：删掉。
- `previous-workers.ts` 文件头引用了已删的 `script-host.ts`、`approval.ts` 有一句注释仍提"同类都允许"：改掉（上文第三节说 `approval.ts` 的注释已清，此前漏了这一句）。
- `ROADMAP.md`：第 4 节标题、M11 标题补上删除标注，交付表"脚本编排"一行改成与相邻行相同的〔…〕写法。
- 写了 `orchestration.script` 的设置文件在本提交之后按"未知键"报错：下一块把整个 `orchestration` 列进已删的节（决策 478），报错改为写明已删、请删掉。
- worker 编排器内部的脚本残留（审批请求上经展开带出的 `script: { runId }`、只剩脚本用过的 `subscribe` 的 `eventsOnly` 选项）留给下一块随编排器一起删。
