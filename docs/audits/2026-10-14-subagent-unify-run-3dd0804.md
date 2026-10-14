# 子 agent 与会话的统一改造 · 第一段⑥：pigeon run 等子 agent（基线 3dd0804）

照决策 457 的 E 项：`pigeon run` 里主 agent 停下时还有子 agent 在跑，等它们干完、把结果交给主 agent 接着干；干等超过上限即停，撞上限照上限停。细化记为决策 481。子 agent 本身在④（决策 480）。

## 一、改动

| 文件 | 内容 |
| --- | --- |
| `src/application/headless-core.ts` | 新选项 `subagents`（与测试用的 `subagentWaitMs`）：开着时建通讯录、登记本次运行的会话（名字为缺省会话名）、子 agent 的装配用同一份设置快照与审批模式单元，没有审批通道；收尾循环在后台作业收完之后，主 agent 正常停下且有子 agent 在跑或有待递的结果时干等（有结果即只带通知再跑一轮）；连续干等超过上限即停掉剩下的并写一行；撞上限或外部中止即不再等；结束时先停下并释放子 agent 再跑 SessionEnd |
| `src/application/detached-runtime.ts` | 请求多 `agents`（四件工具）与 `approvalModeCell`（与子 agent 共用），透传给运行面 |
| `src/application/subagent-runtime.ts` | 装配的 `createApprovalHandler` 改为可缺省：不给即子 agent 没有审批通道 |
| `src/application/sandbox-session.ts` | `pigeon run --sandbox` 明确不开子 agent |
| `src/cli/index.ts` | `pigeon run` 按 `--no-subagents` 给 `subagents`（缺省开） |
| `src/application/headless-subagents.test.ts` | 新测试三例：等子 agent 交回后主 agent 再跑一轮；干等超过上限停掉剩下的、写一行、不等子 agent 的命令跑完；不开时四件工具都不注册 |
| 文档 | `docs/configuration.md` 子 agent 一节加 `pigeon run`；决策 481 与索引行 |

## 二、工程上的取舍

- 干等的计时从主 agent 每次停下算起（连续干等），主 agent 因子 agent 交回再跑一轮之后重新计；兜底每秒再看一次（撞墙钟上限的中止不经通讯录）。
- 超时的那一行写到标准错误输出：结果可能缺东西，属于要知道的事；`--json` 的结果一行不变。
- 轮数、token 上限与结果里的指标只计主 agent 的会话：子 agent 的用量不经主运行面的事件，计全要另读它们的会话，先按现有口径（决策 481 写明）。
- `/fork` 的分支续跑不给 `subagents`。

## 三、检查

- 本机：`tsc --noEmit`、整仓 `biome check`、`dependency-cruiser`、`pigeon-paths-boundary` 通过；`headless*`、`sandbox-session`、`cli` 目录的测试通过。本块没动执行端与容器路径（`sandbox-session.ts` 只加一个选项），容器类测试照常交服务器全量。

## 四、独立审查

对提交 a8ea50a 另派审查（只读，在 af4bace 的快照上跑 tsc 与相关测试，另写四个场景复现）。等待的机制（不漏叫醒、并发上限排着的先转为开跑再复查、计时随主 agent 每次停下重算）、结果的终态与 `--json`、收尾的先后（先停子 agent，再跑 SessionEnd、释放主运行面）、入口（`pigeon run` 缺省开、沙箱关、`/fork` 不给、没有审批通道时子 agent 一律拒）、文字与换行都核对过。指出的问题与处理（并在⑤的提交里）：

- 等子 agent 的时候撞到墙钟上限，终态报成 completed（复现）：等的时候被上限或外部中止打断、还有子 agent 在干活，按中止收尾，终态取撞上限的原因（`wall-clock-limit`）。加了测试。
- 干等超时后注销了会话：之后主 agent 再派的（Stop 钩子拦下再跑时）不再被等、也不受并发上限（复现）：超时改为停下这个会话下还在干活的子 agent（会话照旧登记），之后再派的照样等、照样受上限。
- 释放子 agent 时等运行面收尾没有上限：释放也限 5 秒，手上的工具调用等不到的不再等。
- 子 agent 开的后台作业不算还在干活：停着但作业还没收尾的子 agent 算在干活（作业结束会叫醒它），超时停下时一并停掉它的作业；`--json` 的保留作业连同子 agent 的一起列。
- 文字：超时那一行不到一分钟写秒；注释与审计里提跑批器的说法去掉（仓库里已没有跑批器）；文档去掉 `pigeon run` 没有的 token 上限与外部中止，写明 `runWaitMinutes: 0` 时卡住的子 agent 会一直等；决策 481 收短。
- 记下不改：外部中止的终态是 unknown、`pigeon run` 没有 Ctrl+C 的收尾，都早于本块，生产入口也没有中止来源。
