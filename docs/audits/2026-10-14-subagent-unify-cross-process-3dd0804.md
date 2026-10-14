# 子 agent 统一改造（二）：删除跨进程的会话间通信（决策 450、457、478）审计

基线 3dd0804，接在"删除脚本编排"之后。跨进程部分在 3dd0804 已经由一个常量关着（三个入口都不开收件口、不注册工具），本块把代码与设置一并删掉；送达的规矩挪进一个进程内用的小模块，留给之后的 agent 之间的消息。

## 一、删除清单

### 收件口与名录

- 每个会话的收件口：Windows 命名管道（`\\.\pipe\LOCAL\pigeon-peer-…`）、其他平台的 Unix socket（`~/.pigeon/state/peers/` 下，0700 目录、0600 socket），连接上的双向 HMAC 证明与鉴权串、鉴权前的行长与时限、同时连接数上限、一来一回即关连接、发送方断线重试一次。
- 本机会话名录 `~/.pigeon/state/peers/<会话号>.json`：名字、会话号、所在目录、进程号与启动时刻、心跳（每分钟）、地址、鉴权串、审批模式类别、忙闲；陈旧条目清理。已在使用者机器上的名录文件不清理（进程退出时本就撤下，崩溃留下的无害）。
- 跨窗口发消息、订阅对方空闲或退出的一次性通知、回告（空闲、退出、过期、拒绝、关闭）。
- 放行规则：按两边审批模式自动收或扣住、`inbound` 的全收全扣全拒、项目共享层只能收紧。
- 开关常量 `CROSS_PROCESS_MESSAGING` 与 `peer-session.ts` 的入口共用段。

### 模型工具与提示

- `list_peers`、`send_message`（跨进程版，参数 to、message、notify_when_idle）及其说明；系统提示里"别的会话发来的消息不是使用者的话"那一句（`PEER_MESSAGES_PROMPT_SENTENCE`）。进程内按名字寻址的 `send_message` 随后在新建部分里重写。
- 递给模型的 `[Cross-session message]`、`[Cross-session idle notice]`、`[Cross-session delivery notice]` 三种文字的生成（`wrapPeerMessage`、回告文字）。

### 界面

- 扣住消息的审批面板：`ApprovalRequest.peerMessage`、二选一（丢弃 / 放行）的状态行 `peerChoiceStatus`、面板出现后 0.6 秒的防误触 `guardUntil`（`PANEL_GUARD_MS`，只为扣住的消息与顶替它的工具审批而设）、扣住消息为工具审批让位再重弹（`APPROVAL_YIELDED`）、撤下时的一行 `PEER_HOLD_WITHDRAWN`。
- `HeldPresenter`（`tui/peer-inbox.ts`）与 `MainPeerRoute`（`tui/peer-route.ts`：消息送主会话，查看 worker 期间攒着）。
- 壳的 `onBusyChange` 选项（只用于名录里的忙闲与空闲通知）。
- 消息区的"message from …""… held for approval"等提示行与"opening the cross-session inbox failed"。

### 设置与环境变量

- 设置节 `messaging`（`inbound`、`holdMinutes`）及合并时的分层收紧逻辑（`layeredInbound`）。写了这一节的设置文件开局报错 `settings file <文件> (<层>): messaging has been removed; delete this section`（决策 478）；`orchestration` 与 `commands.roles` 随下一块加入同一清单。
- 环境变量 `PIGEON_PEER_ADDRESS_PREFIX`。
- `pigeon run`（`runHeadless`）的 `peerInbox` 选项。

### 删除的文件（共 14 个，约 2,860 行）

| 文件 | 行数 |
|---|---|
| src/application/peer-messaging.ts | 884 |
| src/persistence/peer-registry.ts | 192 |
| src/application/peer-tools.ts | 163 |
| src/tui/peer-inbox.ts | 100 |
| src/application/peer-session.ts | 64 |
| src/state/messaging-config.ts | 58 |
| src/tui/peer-route.ts | 41 |
| src/application/peer-security.test.ts | 490 |
| src/application/peer-messaging.test.ts | 319 |
| src/tui/peer-inbox.test.ts | 221 |
| src/application/peer-tools.test.ts | 143 |
| src/tui/peer-route.test.ts | 67 |
| src/application/messaging-layers.test.ts | 64 |
| src/state/messaging-config.test.ts | 53 |

`src/tui/peer-shell.test.ts` 改名为 `rename-shell.test.ts`，删去其中"忙闲告诉装配方"一例，`/rename` 的两例照留。

## 二、保留与挪动

- 新文件 `src/application/agent-mail.ts`：由 `peer-messaging.ts` 留下的送达规矩——单条 100000 字上限、同一发送方给同一收件方每分钟 10 条、一分钟内相同消息只收一次、收件方待读满 50 条即拒收、边界标记包住正文并改写正文里看着像边界标记的行（NFKC 归一、去零宽后再比）。边界的名字由 `PEER-MESSAGE` 改为 `AGENT-MESSAGE`；限流与去重由"每个收件口一份"改为"进程内一份、按发送方与收件方成对记"。来源与信任说明由调用方给出（随后的新建部分统一成一句）。测试 `agent-mail.test.ts` 由原来的限流、去重、待读满、超长与假边界两例改写而来。
- 会话名的规则 `validPeerName`、`defaultPeerName` 挪进 `session-name.ts`，改名为 `validSessionName`、`defaultSessionName`，规则不变；`/rename`、面板派出的会话、`pigeon session list` 照旧用它。
- `history.ts` 照旧认出旧会话里的三种 `[Cross-session …]` 前缀（决策 477），三行常量写在 `history.ts` 里；测试里的旧消息改用当年格式的字面量。
- 进程内的送达（运行中在两次工具调用之间随通知送入、空闲时开一轮）本就是运行面的通知队列与叫醒，不在删除之列。

## 三、文档

- `docs/configuration.md`："本机会话间通信"一节换成"会话名"一节（只留会话名的说明，另写一段跨进程通信已删、旧设置开局报错）；各节表删 `messaging` 一行；设置视图不放的清单与面板审批一句去掉扣住的消息。
- `docs/roadmap/decisions.md`：450、456 标部分已改；新增 478。

## 四、检查

- 本机：`tsc --noEmit`、`biome check` 通过；分两批跑过受影响的测试（settings、agent-mail、history、rewind、session-name、session-list、rename-shell；approval 各测试、headless、headless-hooks、input-queue、config-options、session-* 各测试）。
- 全量测试与打包冒烟在服务器上跑。
