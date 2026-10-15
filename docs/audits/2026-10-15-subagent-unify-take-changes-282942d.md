# 子 agent 与会话的统一改造 · ⑩：模型取回改动的工具 take_changes（基线 282942d）

子 agent 用临时工作树干完，派出方只收到"改动在某路径、某分支"，没有拿回的手段。给模型加一件工具，与 `/take` 同一套三方叠回。细化记为决策 486。

## 一、改动

| 文件 | 内容 |
| --- | --- |
| `src/application/take-changes.ts` | `takeFromAgent`：认出子 agent 的临时工作树（不在、或落点就是它的工作树即报错），按起点（上次完整取回后前移的起点优先）三方叠进调用方的工作目录；完整取回即前移起点 |
| `src/application/agent-worktree.ts` | `agentWorktreeAt`：按子 agent 的会话号与名字认它的临时工作树——工作目录此刻在它自己的分支上，起点取起点快照引用，没有（派出时派出方没有未提交改动）取分支建立时的那一条（引用日志里最早的）；续接认回的同样认得。`closeAgentWorktree` 多认"完整取回之后再没有改动"为没有改动，删时连同取回起点引用 |
| `src/application/session-pool.ts` | 取回的说明按对方是什么写（session / sub-agent）；取回起点引用分 `refs/pigeon/panel/` 与 `refs/pigeon/agent/`；会话池可取回到给定的落点（`takeInto`） |
| `src/application/subagents.ts` | 通讯录的工具接口加 `take`：只认调用方直接派出的子 agent；在干活（在跑、收尾中）的拒绝；会话调用方找不到这个名字时再找面板里的会话；记下前移后的起点，释放时交给运行面。交回结果附工作树时补一句用 `take_changes` 拿回。续接认回的子 agent 记下它的工作目录 |
| `src/application/subagent-runtime.ts` | 子 agent 运行面给出自己的工作目录（它取自己子 agent 的落点）；释放时带上取回起点 |
| `src/application/agent-tools.ts` | 新工具 `take_changes`（参数 `name`），按写档注册（`pathConfinement: none`，同 `enter_worktree`） |
| `src/tui/main-pool.ts`、`src/tui/main.ts`、`src/application/headless-core.ts` | 会话登记给出工作目录（落点）；终端界面里会话的主 agent 能取面板里同一仓库、不在干活的会话（跨仓库、还在干活、没开着的写明拒绝）；面板会话的取回可指定落点 |
| 测试 | `subagent-runtime.test.ts`（前台派出在临时工作树里写新文件的子 agent → 取回、再取只取之后的、不认识的名字报错、完整取回后再没改的关掉即删；按写档注册）、`main-pool.test.ts`（取回到给定落点：跨仓库拒绝、落点就是它的工作树拒绝） |
| 文档 | `docs/configuration.md` 子 agent 一节（五件工具、审批、临时工作树）与 `/take` 那段（LFS、加密过滤）；决策 486 与索引行；480 标部分已改 |

## 二、工程上的取舍

- 审批：按写档注册，询问模式下照写文件的规则问；审批块只写工具名与 `name`（参数里没有路径，没有"整个目录放权"那一键）。子 agent 里调它的审批照 480 汇到所属会话、放权只对它自己有效。
- 只读类型不注册：靠 480 的只读范围（只留读档与联网档的工具）自然排除，不另写名单。
- 层数到上限、不能再派的子 agent 照样注册（它可能派过的子 agent 早于上限调整；没有可取的即报"不认识这个名字"）。
- 子 agent 的起点：起点快照引用只在派出方有未提交改动时才有（与 worker 同一份快照规则），没有时取分支引用日志里最早的一条；两样都读不到即按"没有工作树"报错，不猜。
- 会话主 agent 取面板会话：只在终端界面有（`pigeon run` 没有面板）；面板里本进程没开的会话（工作清单里的）按"不认识"处理，要先进入或发话开起来。
- 取回的说明行沿用 `/take` 的写法（`took N files: …`、`conflicts, not written: … (still in worktree …)`、`deleted in sub-agent, kept here: …`、`too large, not taken: …`），出错的以工具错误交回。

## 三、检查

- 本机：`tsc --noEmit`、整仓 `biome check`、`dependency-cruiser`、`pigeon-paths-boundary`；`src/tui` 全部测试分三批、`src/application` 里改到的测试逐个跑过。
