# 子 agent 统一改造（三）：删除 worker 重度管理、树形视图与读旧 worker 记录的代码（决策 457、477–479）审计

基线 3dd0804，接在"删除跨进程的会话间通信"之后。本块只删不建：提交之后模型没有派生的工具，下一块新建子 agent。`/fork` 留作使用者的会话分支命令，从 worker 编排面上拆出来单独挂。

## 一、删除清单

### 模型工具

- `spawn_worker`（参数 role、task、name、attempts、label、tools、scopes）、`wait_workers`、`worker_status`、`message_worker`、`stop_worker`、`take_worker`，连同各自的说明、返回文字与"按环境注册"里非 git 工作区不注册这一组的判定。
- `update_tasks` 的 `worker_label` 参数（只为对上 worker 的标签）。
- worker 系统提示里交代作用范围的一句（`scopePromptSentence`）。

### 编排器与运行面

- 编排器 `orchestration/workers.ts`：派出、取消、状态、等待、发消息、补批续做、生命周期订阅与只读观察口；同时在跑的额度与排队、每次运行的派出数上限、层数、每个 worker 的轮数与墙钟上限、卡住监控、结构化交回（状态、错误类型、改动文件、≤2000 字摘要）、等待中借出空位、收尾即删工作树、续做时重建工作树。
- 角色 `orchestration/roles.ts`：explorer、implementer、tester 三份预设与已退役的三个角色值、角色的推理档位与模型接入覆盖、"不能交给 worker 的工具"清单、explorer 就地读派出方工作区。
- 同任务多份并行（`attempt-group.ts`）。
- worker 运行面工厂与 SubagentStart、SubagentStop 两个钩子的触发、嵌套时等下层 worker 的收尾（`application/workers.ts`）。无人值守的装配内核拆成 `application/detached-runtime.ts` 留给 `pigeon run` 与分叉续跑，只保留它们用到的部分。
- 派出槽与宿主绑定（`spawn-worker-host.ts`）、完成通知队列（`worker-notices.ts`）、取用（`take-worker-tool.ts`）。
- 治理里只为 worker 设的两条：自己工作树内写文件默认放行（决策 302）、工具作用范围（决策 360，`tools/tool-scope.ts`）。`run_command` 的角色命令清单（`allowlist`）与只按 PATH 找程序（`pathOnly`，连同 `windowsPathProgram`）。
- 审批的等待时限、撤回与补批：`ApprovalRequest.signal`、排队中撤回、面板撤下与"approval timed out"一行、交给模型的超时理由；`ApprovalRequest.worker` 与审批块里"source: worker …"、"(worker … only)"。
- `pigeon run` 里的派 worker、等 worker 全部结束（`drainWorkers`）、worker 的 token 计入本次上限、撞上限停掉在跑的 worker、保留作业按 worker 会话合计；`headless` 选项 `spawnWorkers`、`orchestration`。
- 退出时取消在跑的 worker 并等收尾（`tui-exit.ts` 的 `workers`、`workerGraceMs`）；换进工作树时"有 worker 在跑即不移"。

### 斜杠命令、启动参数与设置

- `/spawn`（含 `--name`、`--attempts`）、`/cancel`、`/workers`、`/agents`、`/stop`、`/approve`；命令表的 `inWorkerSession` 与"worker 会话里只放行几条命令"。`/take` 只取回会话面板里的会话，`session:`、`worker:` 前缀去掉。沙箱里的说明改为只说 `/take` 不可用。
- 启动参数 `--no-spawn-workers` 改名 `--no-subagents`（旧名不留；`scripts/bundle-smoke.mjs` 与 bench 跟着改），`--worker-concurrency`、`--worker-limit` 删除。
- 设置 `orchestration` 整节与 `commands.roles`：写了即开局报错，写明文件、哪一项已删、请删掉（决策 478；节内的键也支持）。任务清单开关搬到 `tools.taskList`（决策 479）。`loopGuard.exemptTools` 的缺省去掉 `wait_workers`。

### 界面

- 输入框下方的编排面板（含实时金额）、Ctrl+X 与 `/agents` 打开的整屏树形视图（运行中与会话树两种模式、会话树里的只读看历史与在此续接）、进入 worker 会话的视图与其中的 `/stop`、`/approve`；键位动作 `pigeon.tree`。主视图的 Ctrl+X 不再绑定。消息树（会话回退）原是树形视图的第三种模式，现为自己的整屏视图 `rewind`，Tab 不再切换。
- Notification 钩子的 `worker_approval` 类型。
- `/config`、`/reload`、`/resume`、换进工作树四处"有 worker 在跑即拒绝"的闸。
- 状态栏的 worker 实时花费合计；续接与运行中都不再把旧会话里 worker 子会话的用量计入本会话（复盘会话照旧计入）。

### 会话记录与读者（决策 477）

- 条目 `pigeon.worker`（派出与收尾）不再写；会话视图不再认它，读到即跳过（未知的自定义条目原本就跳过、不报警告）。`SessionView.children`、`orphanSettleds`、`worker`，会话摘要的 `worker`、`children`，`storeWorkerSpawned`，会话存储的 `childFamilySink` 与 `workerSpawnedEntry`、`workerSettledEntry` 一并删除。
- 会话文件头不再写 `metadata.pigeon.worker`；读文件头时也不再认它（schema 不封闭，旧头照样能读，按普通会话处理）。`StoreLineage.worker` 删除，只剩分支的来历。
- `pigeon trace` 不再列 "worker session:"、"spawned workers (N):" 与 "orphan worker settle"；`pigeon replay` 不再列 worker spawned/settled；`pigeon session list` 不再写 worker 父子后缀与派出数。
- 续接时找回之前运行的 worker、补递完成通知（`previous-workers.ts`）；`--resume <worker 会话号>` 回到 worker 工作树与委派策略（`worker-scope.ts`，其余部分改写为 `application/session-scope.ts`：分支会话回到工作树、开在独立工作树里的会话回到那里）。
- 会话树的拼装（`application/session-family.ts`）。
- 工作树清理里"起点优先取派出记录"一项：起点只取分支的引用日志。
- 命令输出虚拟路径的来源链不再在 worker 会话处截断（旧 worker 会话按父会话一路往上，与分支同一口径）。

### 迁移命令

- `pigeon migrate-config` 不再把旧 `.pigeon/orchestration.json` 并入设置：只把其中的 `taskList` 搬到 `tools.taskList`（目标里已有不同的值即停下说明），其余键不并入，每个没并入的键打印一行；什么都没带过来时只挪进备份，不碰设置文件。旧 `commands.json` 里的 `roles` 同样不并入并打印一行。原文照旧挪进用户级备份目录。

### 保留

- `history.ts` 认旧前缀 `[Worker notice] `、`[worker 通知] ` 的两行，只为回看时不当成人说的话（决策 477）。
- `SubagentStart`、`SubagentStop` 两个钩子事件的定义与文档保留，本提交里没有触发方；下一块接到子 agent 上。
- `execution/worker-overlay.ts`（三方叠回）留给会话面板的 `/take`；`orchestration/worktree.ts` 留给 `/fork`、工作树清理与下一块的临时工作树。
- `/worktrees`、`pigeon worktrees` 照旧列出与清理 `.pigeon/state/worktrees/` 下的工作树（含以前 worker 留下的）。
- 测试夹具 `spawnFixtureWorker` 与 `workerSpawned`、`workerSettled` 改为照旧格式写字面量（`pigeon.worker` 与 worker 文件头），专供"旧会话照样能读、这些记录被跳过"的测试。

### 删除的文件（共 61 个，17,081 行；其中非测试 22 个，7,375 行）

| 文件 | 行数 |
|---|---|
| src/application/attempt-group.test.ts | 155 |
| src/application/attempt-group.ts | 74 |
| src/application/explorer-in-place.test.ts | 125 |
| src/application/loop-guard-worker.test.ts | 156 |
| src/application/orchestration-tools.ts | 529 |
| src/application/orchestration-wiring.test.ts | 375 |
| src/application/previous-workers.test.ts | 382 |
| src/application/previous-workers.ts | 188 |
| src/application/runtime-web-tools.test.ts | 60 |
| src/application/session-family.ts | 262 |
| src/application/spawn-worker-headless.test.ts | 694 |
| src/application/spawn-worker-host.ts | 88 |
| src/application/spawn-worker-registration.test.ts | 59 |
| src/application/spawn-worker-scopes.test.ts | 120 |
| src/application/spawn-worker-tool.test.ts | 951 |
| src/application/spawn-worker-tool.ts | 887 |
| src/application/take-worker-tool.test.ts | 564 |
| src/application/take-worker-tool.ts | 345 |
| src/application/worker-model-override.test.ts | 67 |
| src/application/worker-notices.ts | 234 |
| src/application/worker-scope.test.ts | 127 |
| src/application/worker-scope.ts | 119 |
| src/application/worker-tools-runtime.test.ts | 132 |
| src/application/workers-approvals-e2e.test.ts | 202 |
| src/application/workers-commands.test.ts | 114 |
| src/application/workers-commands.ts | 187 |
| src/application/workers-compaction.test.ts | 86 |
| src/application/workers-e2e.test.ts | 168 |
| src/application/workers-mcp.test.ts | 135 |
| src/application/workers-output-limit.test.ts | 86 |
| src/application/workers-recovery-e2e.test.ts | 191 |
| src/application/workers-settings.test.ts | 81 |
| src/application/workers-start.test.ts | 138 |
| src/application/workers.ts | 957 |
| src/cli/spawn-worker-cli.test.ts | 322 |
| src/cli/trace-workers.test.ts | 222 |
| src/orchestration/orchestration-core.test.ts | 572 |
| src/orchestration/roles-mcp.test.ts | 18 |
| src/orchestration/roles-tools.test.ts | 160 |
| src/orchestration/roles.test.ts | 108 |
| src/orchestration/roles.ts | 288 |
| src/orchestration/worker-outcome.test.ts | 218 |
| src/orchestration/workers-worktree-removal.test.ts | 326 |
| src/orchestration/workers.test.ts | 600 |
| src/orchestration/workers.ts | 1689 |
| src/state/orchestration-config.ts | 77 |
| src/state/structured-result.test.ts | 30 |
| src/state/structured-result.ts | 41 |
| src/state/worker-workspace.test.ts | 77 |
| src/tools/tool-scope.test.ts | 159 |
| src/tools/tool-scope.ts | 240 |
| src/tui/orchestration-fixtures.ts | 239 |
| src/tui/orchestration-shell.test.ts | 280 |
| src/tui/orchestration-ui.test.ts | 723 |
| src/tui/session-tree.test.ts | 510 |
| src/tui/session-tree.ts | 134 |
| src/tui/worker-activity.ts | 151 |
| src/tui/worker-panel.ts | 242 |
| src/tui/worker-tree.ts | 180 |
| src/tui/workers-shell.test.ts | 213 |
| src/tui/workers-view.ts | 224 |

另删的测试用例（文件保留）：worker 续做取回裁剪、worker 推送记忆、worker 推理档位、移进工作树后 worker 从工作树开工、worker 写 .pigeon、tester 角色命令清单、worker 运行面检索排除、授权与 worker 两族的落盘口里 worker 一半、worker 通知的转义、"不是 git 仓库不注册派 worker 一组"与治理根分开时的派 worker 注册、排队中撤回、短名与角色允许清单、起点取派出记录、面板会话与 worker 同名、有 worker 在跑时的设置视图与换进工作树。改写的测试：状态栏的三条用量测试改为"旧 worker 不再计入"，会话列表测试改为"旧 worker 记录照常列出、不再带父子信息"，审批来源测试改用面板会话。

## 二、文档

- `docs/configuration.md`：各节表（`commands` 去掉 `roles`、删 `orchestration` 行、`tools` 加 `taskList`）、已删设置开局报错一句、示例、按环境注册、联网开关、后台作业、快照、程序状态目录、会话文件的建立时机；"worker 与续接"一节改写为"留下的工作树"（`/fork` 与旧 worker 的工作树、清理、`.worktreeinclude`）；终端界面里的标题行、状态行、审批来源、状态栏、审批模式、编排面板与树形视图（删）、设置视图、键位表（删 `pigeon.tree`）、会话回退、会话面板与 `/take`、会话检索、迁移、`/reload`、受保护路径、钩子事件表。
- `docs/roadmap/ROADMAP.md`：M5.5 标已退役，M11、3.9 与交付表两行补删除标注。
- `docs/roadmap/decisions.md`：040、069、262–265、268、271、276、292、297–304、344、345、360、377、447 标已退役；002、177、184、266、267、279、285、294、307、308、323、331、340、381、435、438、443、448、449 标部分已改；新增 479。

## 三、检查

- 本机：`tsc --noEmit`、`biome check`、`dependency-cruiser` 通过；改过的测试文件一起跑过，另按目录分批跑了快档全部目录。分批跑出的失败里，按旧行为断言的（worker 用量计入、worker 条目与来源链、旧配置迁移、豁免缺省、角色清单、命令放行表）都已改写；另有三条在本机失败：`checkpoints-async.test.ts` 的"保留修改时间的同长度覆盖"、`container-host.test.ts` 的假 docker 文件清单、`container-round-trips.test.ts` 的符号链接受保护路径——在基线 3dd0804 上同样失败，是本机（Windows）环境问题，与本块无关；`update-memory-tool.test.ts` 的两进程并发写一条偶发失败，单独重跑通过。
- 全量测试与打包冒烟在服务器上跑。

## 四、独立审查

对提交 f52210a 另派审查（只读，在提交的快照上跑 tsc 与相关测试）。没有发现正确性问题：`detached-runtime.ts` 与原 `workers.ts` 里无人值守的那一份逐项一致（MCP 启动与失败时关闭、就绪前的订阅、收尾等后台作业、续跑、释放）；`headless-core.ts` 的收尾循环、`shell.ts` 的按键路由与回退视图、`main.ts` 在 /reload 与 /resume 换绑后的 /fork、沙箱里的 /fork 与 /take、设置里已删的节与节内的键、迁移命令的计划与执行同一份结论，都核对过；旧会话（带 `pigeon.worker` 条目与 worker 文件头）在 trace、replay、会话列表、续接列表、检索、回退里打开无错无告警；没有 CR 换行。

两处有意的差别补记在这里：没有 MCP 时就绪前到来的中断现在让运行按中止交回（原来忽略；唯一这样调用的是已中止的信号，headless 本来就跳过）；`/take session:名字` 不再认前缀，按名字原样找（479）。

指出的问题与处理（另一提交）：

- 中：按会话号续接旧会话里的 worker 会话，会落到主检出里干活（原来回到它自己的工作树）。改为续接时文件头记的工作目录在 `.pigeon/state/worktrees/` 下且还在即回到那里，不在即回到治理根，与独立工作树里的会话同一规矩；`SessionRuntimeScope.parentSessionId` 已无人设，连同按它关掉快照与 enter_worktree 的两处判断删掉（分支会话本来就不设它，行为不变）。续接列表照旧不列这些会话，只有直接给会话号才会续接到。
- 设置：`orchestration` 一节里写了 `taskList` 的，开局报错句末注明它已搬到 `tools.taskList`（478 补写节内键与这一注的写法）。
- 文字：`pigeon.tree` 的说明改为会话面板里连按两下停下会话（名字沿用，免得写过键位的设置失效；文档的键位表补回这一行）；search_sessions 与 list_sessions 的说明、后台作业上限的报错、`/worktrees` 的在用原因与拒绝说明里去掉 worker。
- 死代码：`CommandInspection.program`、`loopGuardTargetOf` 删掉。`RuntimeDeps.toolPolicy` 及其分支、`WorktreeScope.liveWorkers`、设置重读与 /config 的 `busy` 钩子、`LOOP_GUARD_TEXTS.agentReason` 留给下一块（子 agent 的工具范围、临时工作树在用、子 agent 在跑时挡住 /config 与 /reload、子 agent 打转叫停的原因）改用或删掉。几个失去外部调用方的导出（`NoticeTarget`、`DrainTarget` 等）不动。
- 注释与测试名：`shell.ts` 文件头的编排面板与树形视图段落、`command-table.ts` 与 `shell.ts` 里的 `/cancel`、`task-list-tool.ts`、`config-options.ts`、`worktree-cleanup.ts`、`memory/session-search.ts`、`output-ancestors.test.ts` 里过时的说法改掉；`governance.ts` 文件头被连带删掉的说明补回；`hooks-view`、`sandbox-commands`、`system-prompt`、`enter-worktree-tool` 几个测试的名字与样例去掉 worker。
- 文档：决策 324、433 标部分已改；路线图里派 worker、take_worker 两行标部分已改，编排界面一行标已退役；配置文档的 `tools` 表补 `tools.taskList` 一行。
- 记下不改：`hasSessionHistory` 把续接的旧 worker 会话的父会话算作有历史，而检索时排除了它，检索工具可能注册了却搜不到东西，只在直接续接旧 worker 会话时出现。`pi-runtime/session-store.test.ts` 用 worker 文件头验写者原样写 metadata，下一块换成子 agent 的文件头。配置文档里 `SubagentStart`、`SubagentStop` 的触发时机下一块接上后才成立。
