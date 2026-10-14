# 子 agent 与会话的统一改造 · 第一段④：派子 agent、类型、通讯录与消息（基线 3dd0804）

本块照决策 457 建子 agent，施工中的细化记为决策 480。前面三块已删掉 worker 重度管理、脚本编排与跨进程通信；本块在留下的进程内送达规矩（`agent-mail.ts`）与会话装配路径（`openSessionRuntime`）上新建。界面（子 agent 面板等）在⑤，`pigeon run` 等子 agent 在⑥。

## 一、新增

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `src/application/subagents.ts` | 795 | 通讯录与子 agent 的总账（`AgentHub`）：会话登记、派出（名字、类型、上限、层数）、后台与前台、完成交回、续聊、叫停、续接认回、释放；信任说明与传话的包装 |
| `src/application/agent-tools.ts` | 215 | 四件工具 `spawn_agent`、`send_message`、`list_agents`、`stop_agent` 的说明、参数与注册 |
| `src/application/agent-types.ts` | 213 | 内置 `general`、`explore` 与 `.pigeon/agents/`、`~/.pigeon/agents/` 下自定义类型的读取 |
| `src/application/subagent-runtime.ts` | 311 | 子 agent 运行面的装配（`createSubagentOpener`）：会话文件位置与文件头、共用审批模式、放权种子、MCP 沿用、类型的工具范围与附加提示、带上下文起步、临时工作树、SubagentStart/SubagentStop、打转叫停、续接重开；续接时读回子 agent（`restoredAgentsOf`） |
| `src/application/agent-worktree.ts` | 96 | 临时工作树：派出方工作目录快照作起点、建在 `.pigeon/state/worktrees`、释放时没有改动即删 |
| `src/state/agents-config.ts` | 33 | 设置的 `agents` 一节（`maxConcurrent`、`maxDepth`、`runWaitMinutes`）与缺省值 |
| 测试 | 825 | `subagents.test.ts`（总账，假运行面）、`agent-types.test.ts`、`subagent-runtime.test.ts`（真装配、假模型：前台 explore、临时工作树、带上下文与花费与续接、钩子）、`tui/approval-subagent.test.ts` |

## 二、改动

- 运行面（`runtime.ts`）：③留下的 worker 委派策略 `toolPolicy` 换成子 agent 的工具范围 `toolScope`（`allow` 列表、`readOnly` 只留读档与联网档）——系统提示只介绍范围里的工具，注册表与广告给模型的清单按它收窄；新增 `agents`（四件工具，绑着本会话或本子 agent）与 `storeSessionsDir`（本会话文件所在的会话根）；审批模式恒取模式单元（子 agent 与派出方共用一个）。记忆写入、`enter_worktree`、任务清单由入口决定给不给，运行面里不再按委派策略关掉。文件里剩下的 worker 说法一并改掉。
- 会话装配（`session-runtime.ts`）：`agents` 与 `subagent`（会话根、文件头来历、附加系统提示、工具范围、放权种子）两个选项；子 agent 续接时从它自己的会话根读记录与放权；子 agent 不打快照。
- 会话记录：新条目 `pigeon.agent-message`（from、to、kind、text、sentAt）；文件头 metadata 新增 `agent` 一段（name、type、path、topSessionId、`inheritedEntries`）；会话视图认 `agent` 一段，带上下文起步的复制段与分支会话一样跳过；trace 与 replay 显示传话一行（`agent <kind> | <from> -> <to> | <正文开头>`）。`state/paths.ts` 新增 `subagentSessionsDir`、`projectAgentsDir`、`userAgentsDir`。
- 设置：`agents` 一节，`/config` 新增 agents 一组三项。
- 审批：请求多一个 `subagent.path`；来源行 `source: sub-agent <路径>`（所属会话是面板里的会话时加 `| session <名字>`）；答完的一行前标 `[<面板会话> › <路径>]`；`[a]`、`[d]` 与 exec、网站两种放权的说明在子 agent 的请求里写 `for this sub-agent`（`grantTargetOf`）。
- 花费（`session-cost.ts`）：续接累计与运行中的子会话花费都连同所属会话名下的子 agent 会话；子 agent 会多次接着干，按条目只计新增的部分；状态栏在子 agent 状态有变时重算。
- 终端界面：`main.ts` 建通讯录（沙箱与 `--no-subagents` 不建），当前会话登记（`/resume` 换会话时换登记，换不成退回原登记），运行面与 `/reload` 的重建都带上工具接口；续接时认回子 agent；`/config` 改值、`/reload`、`/resume`、`enter_worktree` 在当前会话有子 agent 在跑时不做（用上③留下的 `busy` 钩子）；退出时先停下并释放子 agent。`main-pool.ts` 让面板里的会话同样登记、能派子 agent，审批写明所属会话与路径，会话停下时它派出的一并停下。
- 文档：`docs/configuration.md` 新增"子 agent"一节，各节表加 `agents`，钩子事件表写明 SubagentStart/SubagentStop 的时机与 matcher，会话面板一节补子 agent 的审批与停下；决策 480 与索引行；443、450 标部分已改。

## 三、工程上的取舍（协调会话已同意的两条在前）

- 同时在跑的上限按所属会话连同它下面各层计，同 Claude Code 的"一个会话里"。
- 放权的作用范围：子 agent 与派出方共用审批模式单元（Shift+Tab 对它们同样生效）；派出那一刻派出方已有的会话放权复制一份给子 agent 作种子；之后在子 agent 的审批里给的放权只记在这个子 agent 自己的会话存储里——不往上给派出方，也不给兄弟或它派出的下层（下层派出时复制的是它当时已有的）。审批块的按键说明写 `for this sub-agent`，让人看得出这次放权只对哪个子 agent 有效。
- 临时工作树的"无改动即删"放在子 agent 被释放时（换会话、关掉面板里的会话、退出），不在每次停下时：干完的子 agent 还可能被叫回来接着干，删了它的工作目录就接不上。每次交回时只在有改动时附位置与分支。干到一半被打断的一律保留。
- 带上下文起步复制派出方截到最后一条助手消息之前的对话（那条里有正在执行的派出调用，复制过去会留下没有结果的工具调用）；派出方的开工状态块消息随之带过去。复制段写进子 agent 自己的会话文件，续接时照样还原；文件头记条数，会话视图、trace 与花费跳过。
- 类型文件里 `tools` 列了没注册的名字一律忽略（不报错、不提示），照"界面不加提醒"。读不成或缺必填项的文件开局报一行，属于报错。
- 前台派出的那次调用被中断时子 agent 一并停下（不转后台）。
- MCP：子 agent 沿用派出方的连接（`startMcpSession` 的 reuse，按引用计数），不为每个子 agent 另起一份服务。
- 会话名与子 agent 名同在一本通讯录：按名字找时子 agent 优先；子 agent 起名时避开已有的会话名。

## 四、留给后面几块

- ⑤：子 agent 面板（输入框下方、一次一层、(+N)、路径、回车进入、x 停与清、结束行保留约 30 秒）、面板卡片的等审批标记、Ctrl+C 与 `/exit` 在有子 agent 在跑时的英文确认、续接后已中断的显示。使用者在子 agent 里亲手打字（不附信任说明）随⑤的"进入子 agent"一起做；总账里叫停（`stop`）与去掉一行（`remove`）的接口已备好。
- ⑥：`pigeon run` 的子 agent（headless 入口还没登记通讯录）与干等上限 `runWaitMinutes`。
- 第二段（不在本块）：所有会话一样、跨工作区的工作清单与全局会话索引、面板 Ctrl+X 两下的语义。本块的通讯录按会话号登记，没有假设"主会话"特殊，不挡这些。

## 五、检查

- 本机：`tsc --noEmit`、整仓 `biome check`、`dependency-cruiser`、`pigeon-paths-boundary` 测试通过；快档按目录分批跑完，除基线上同样失败的三条 Windows 环境问题（`checkpoints-async` 保留修改时间的覆盖、`container-host` 假 docker 文件清单、`container-round-trips` 符号链接）外全过。
- 本机（Windows、无 Docker）跳过的容器类测试本块没有动到执行端，照常交服务器全量。

## 六、独立审查

对提交 e823ecf 另派审查（只读，在提交的快照上跑 tsc 与新测试，另写探针复现）。会话列表不收 subagents 文件夹、复制段条数与文件开头一致、花费不重不漏、子 agent 释放时不关派出方的 MCP 连接、终端界面的登记与换会话、审批的路由、文字都核对过；没有 CR 换行。指出的问题与处理（另一提交）：

- 叫停落在 SubagentStart 或 SubagentStop 跑着的时候不生效（探针复现）：两个钩子之后各再看一次是否已被叫停，叫停了即不开跑。
- 开不成的子 agent 还挂着那次打开，之后的消息说"已送达"却丢了（探针复现）：开不成即撤掉那次打开；发消息时既没有运行面、也开不了的如实说找不到它；续接认回的下次收到消息再重开。
- 续接认回的嵌套子 agent，派出它的那个还没重开时开不了（探针复现）：派出方的样子取不到时按所属会话的开（续接的工作目录、模型照旧）；派出时指定的模型记进文件头，续接沿用。
- 子 agent 的临时工作树能被 `/worktrees` 当作不在用删掉：`/worktrees` 改为先看在用锁（本进程与别的进程持有的都算）；续接重开、回到原来那个临时工作树的同样持有在用锁。
- 续接的子 agent 丢了派出时带过去的放权：续接时把派出方当时的放权与它自己会话里给的合起来（按放权号去重）。种子不落盘，带的是续接那一刻派出方的。
- 并发上限只在派出时查：叫回停着的子 agent（发消息、后台作业结束、派出方收到下层的结果）同样查；发消息撞上限即如实说、不排队；后台作业的通知与发给派出方的结果先留着，有子 agent 停下空出位置即按先后接着干。
- `explore` 拿得到 `spawn_agent`，能派出通用的子 agent 绕过只读：只读范围里不注册 `spawn_agent`。
- 叫停在等审批的子 agent 要等人答完：叫停改为只发中止请求、不等它真停下（`stop_agent` 立刻回话）；释放一批子 agent（换会话、关掉面板里的会话、退出）等这一轮收尾至多 5 秒，到时照样释放。审批本身没有撤回，挂着的那条要人答掉（文档写明）。
- 一轮刚收尾、状态先改成空闲再查临时工作树，期间到的消息会另起一次：改为收尾做完才改状态，收尾后有排着的即接着干。
- 运行面重建时审批说法与工作区外读写的规则按当时的审批模式（469 的共用单元带来的）：写进 480，469 标部分已改。
- 带上下文起步的子 agent 读不到派出方的命令输出：子 agent 能读派出方一路往上的会话的输出。
- `remove` 不释放运行面、留下下层：改为连同下层一起去掉并释放，还有在跑的不去。关掉之后不再派新的。
- 状态栏的花费每次通讯录有变都读一遍子 agent 的会话文件：合并成半秒一次。
- 传话条目没有所属的 Run，trace 里都排到最后：条目带上收件方当时在跑的 Run，trace 里挂到那个 Run 下；空闲时收到的照旧列在会话级条目里。
- 关系说法：会话给孙辈发消息被说成"别的会话的"：按上下层说（上面的、下面的、同一会话里的、别的会话的）。
- 续接认回时改了名的路径末段跟着改；临时工作树建不成时不留起点引用与半成品；`settings.ts` 里放错位置的注释挪回去。
- 文档：临时工作树里的子 agent 另起 MCP（同一工作目录的才沿用）、花费计入的时机、SubagentStop 只在一轮正常干完时触发、`/worktrees` 与在用锁的说法改准；457 说的"第一下停下面板里的会话时子 agent 继续跑完"在 480 里写明留给第二段。
- 记下不改：没有测到"续接认回的嵌套子 agent 重开"的端到端情形（按代码核对、并有总账的单元测试覆盖认回与重开）；`agent-worktree` 的 git 操作是同步的，与原 worker 一样。
