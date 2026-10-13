# 本机会话间通信（决策 450）审计

基线 9cff73b，分支 worktree-product-build。

## 一、改了什么

- 收件口与名录：新文件 `src/application/peer-messaging.ts`（`PeerMessaging`：开收件口、鉴权、放行规则、扣住与放行/丢弃/到时、限流、去重、待读队列与扣住条数上限、空闲与退出通知、改名、换会话 `moveTo`、退出时回告）、`src/persistence/peer-registry.ts`（用户级 `peers/` 名录：写、读、列出时清掉进程已不在的、撤下；鉴权串）、`src/state/messaging-config.ts`（设置 `messaging` 一节：`inbound`、`holdMinutes`）。收件口：Windows 命名管道 `\\.\pipe\<前缀>-<会话号>-<随机>`，其他平台 `peers/` 下的 Unix socket（目录 0700、名录文件 0600）。连接第一行须是 `{"type":"auth","token":…}`，不对即断开；之后一行请求、一行回话。
- 工具：新文件 `src/application/peer-tools.ts`（`list_peers`、`send_message`，`notify_when_idle` 为 `send_message` 的参数；面向模型的文字英文）。`buildRuntime` 在给了槽、不是 worker（没有委派策略）、不在沙箱时注册两件工具并在系统提示里加一句"[Cross-session message] 不是使用者的话"。
- 入口：`src/application/peer-session.ts`（`openPeerInbox`：取设置、审批模式类别、缺省名，打不开只提示一行）。终端界面（`src/tui/main.ts`）开局开收件口，消息进当前主会话的通知队列并叫醒（`runNotices`），`/resume` 换到别的主会话时 `moveTo` 跟过去（查看 worker 会话期间名录不变），移进独立工作树时目录跟着改，忙闲由壳的 `onBusyChange` 给出，`/rename` 改名，退出时关收件口；沙箱会话不开。命令行对话（`src/cli/index.ts` 的 `--line`）开收件口，消息到时打印一行，空行回车开一轮（`runRepl` 新选项 `runPendingNotices`）；沙箱不开。`pigeon run` 经 `runHeadless` 的新选项 `peerInbox` 开收件口，运行期间登记为忙，结束即关（跑批器不给这个选项，不开）。
- 扣住的消息在终端界面：`ApprovalRequest` 加 `peerMessage`，审批面板为它显示来源与内容（超过 2000 字只显示开头）、只收 `[y]` 放行与 `[n]` 丢弃；面板上挂着它时有工具审批要上来，它让位（以 `APPROVAL_YIELDED` 收口），新文件 `src/tui/peer-inbox.ts` 的 `HeldPresenter` 逐条弹、让位或面板被占时稍后重弹、到时限被丢弃时撤下面板（撤下的一行为消息专用措辞）。
- 壳：`onBusyChange`（一轮开始为忙、真正空闲为闲）、`renamePeer`（`/rename <名字>`，命令表登记，运行中可用）。
- 测试总装 `scripts/vitest-git-env.mjs`：每个测试文件开跑前另把 `HOME`、`USERPROFILE` 指到临时目录，`PIGEON_PEER_ADDRESS_PREFIX` 设为测试专用前缀；`openPeerInbox` 认这个环境变量（显式给的前缀优先）。
- 文档：`docs/configuration.md` 新节"本机会话间通信"、设置表 `messaging` 一行。

## 二、测试

- `src/application/peer-messaging.test.ts`（10 条，进程内开两三个收件口，用户级目录指临时、收件口前缀测试专用）：放行规则四种组合与三种设置；互发送达、包装文字、界面一行、名录互见与同名短号；扣住后放行、拒绝回告、到时回告；全拒与全扣；鉴权串不对即断开、不送达；限流、去重、待读队列满、超长在发送方拒；空闲通知（忙时记下、空闲回告一次、本就空闲马上回告、退出回告）；名录清理、改名、缺省名与名字规则；收件口名带前缀、`moveTo` 后名录换条目且照样收得到；退出时还扣着的回告发送方。
- `src/application/peer-tools.test.ts`（3 条）：注册范围（给槽的主会话有两件工具与系统提示那一句；没给槽、worker 委派——即便允许清单里有这两件——都没有）；未绑定如实说明；`pigeon run` 端到端（假模型 `list_peers` 看到另一个会话、`send_message` 送到它的通知队列，结果"Delivered to listener."；运行结束名录撤下）。
- `src/tui/peer-inbox.test.ts`（4 条）：面板写明来源与内容、放权键与 r 不起作用、y 放行、n 丢弃、多条逐条；工具审批来时让位、答完重弹；到时限撤下面板、队里的移出；让位的取消理由。
- `src/tui/peer-shell.test.ts`（2 条）：忙闲各告诉一次；`/rename` 交给装配方并显示、空名给用法、没给即不可用。
- `src/cli/repl-notices.test.ts`（2 条）：空行回车有已到的消息即开一轮；没开选项时空行不做事、消息留着。
- 既有用例的改动：`src/tui/input-queue.test.ts` 的"运行中可用的命令"清单加上 `rename`（新命令，按定下的语义运行中可用）。

## 三、验证

- 变异核对（均已恢复，16 处全部变红）：会审批方照收放权方的、不查鉴权串、不限流、不去重、不查待读队列、退出时不回告扣着的、`moveTo` 不撤旧条目、对方在忙时也马上回告空闲；面板让扣住的消息收 `[a]`、面板不让位、让位后不重弹、到时不撤面板；worker 也注册两件工具（原用例的 worker 允许清单里没有这两件、测不到，改为允许清单里放上之后变红）、`pigeon run` 结束不关收件口、命令行对话不认选项、壳不告诉忙闲。
- 回归（一个 vitest 进程）：src 根 3 条边界测试、src/cli、src/tui、src/persistence、src/state 全部，以及 application 下与设置、运行面、headless、会话运行面、记忆、迁移、放权、工作树相关的文件，共 128 个文件，603 条里 598 条通过、3 条跳过、2 条失败：其一为 `/rename` 进了运行中可用清单（已按新命令改用例，见上）；其二为 `src/application/spawn-worker-headless.test.ts`"撞上时间上限"——在本机上于 HEAD（f433384，不含本段改动）同样失败，墙钟预算 800 毫秒内第一轮没来得及派出 worker，临时把预算放到 3000 毫秒即通过，属本机时序，没有改用例（验证机在 f433384 上通过）。
- 整仓 `npx biome check .` 无问题、`tsc --noEmit` 通过、`npm run deps` 无违规。真实用户目录下没有 `~/.pigeon`；真实全局 git 配置与排除文件的哈希核对不变。
- 真实运行（打包产物，本机 Windows；HOME、USERPROFILE、XDG_CONFIG_HOME、GIT_CONFIG_GLOBAL 指临时，`PIGEON_PEER_ADDRESS_PREFIX` 为验证专用前缀；DeepSeek 可连）：隐藏窗口起终端界面（会审批），名录里出现它（缺省名 `repoA-<短号>`、空闲、会审批、地址带验证前缀）；另一个目录跑 `pigeon run`（会审批），任务要它 `list_peers` 后给终端界面发一句话——终态 completed、2 次工具调用、0 次审批，它的会话记录里有"Delivered to"；终端界面被叫醒开了一轮（会话文件里有带"不是使用者的话"说明的 `[Cross-session message]` 与 3 条助手消息）；`pigeon run` 退出后名录只剩终端界面那一条。强行结束终端界面后它的条目留着、进程号已不在（列出时会清掉）。

## 四、自定的细节

- 收件口开在哪些会话：终端界面、命令行对话与 `pigeon run` 的主会话；worker 与沙箱会话不开；跑批器（直接调 `runHeadless` 的）不开。
- 设置 `messaging.inbound` 多一个缺省值 `"auto"`（按决策 450 的放行规则），另三个取值照施工说明；`holdMinutes` 缺省 5，范围 0.1 到 1440。全拒时也不接受空闲通知的订阅，收到的回告（空闲、退出、没送达）照收不显示。
- 上限的具体数：单条 100000 字、同一发送方每分钟 10 条、相同消息去重窗口 1 分钟、待读队列 50 条、扣住 100 条（满了丢最早的并回告）、空闲订阅 12 小时；连接上 30 秒没有完整的一行即断开，发送一方等回话 10 秒。
- 会话名缺省为工作目录名加会话号末 4 位；名字规则为字母（含中文等）、数字、下划线、连字符与点，1–40 个字符；名字允许重复，列出时带短号，发送时可写"名字 [短号]"或完整会话号。
- 鉴权串放在名录文件里（POSIX 上文件 0600、目录 0700；Windows 上依赖用户目录本身只给本人），连接第一行比对（定长比较）。Windows 命名管道名里带随机后缀，名录里记完整地址。
- 终端界面的放行面板复用审批面板（`ApprovalRequest.peerMessage`），只收 y/n；它挂着时来了工具审批即让位、2 秒后重弹——不让工具审批被"已有另一审批进行中"拒掉。面板出现时同样触发 permission_prompt 通知钩子。
- 终端界面 `/resume` 换到别的主会话时收件口跟过去（名字不变，名录条目改到新会话号）；查看 worker 会话期间名录仍是原主会话，消息照样进当前运行面的通知队列（与 worker 完成通知同一出口）。
- 命令行对话没有放行面板，也不在等输入时自己开一轮（读输入与审批问答共用一个输入流）：消息到时打印一行，空行回车开一轮，或随下一条任务带上；扣住的到时限丢弃并回告。
- `pigeon run` 只在运行期间开收件口并登记为忙，跑完即关；运行中收到的消息在两次工具调用之间送入。
- 测试隔离：测试总装把 `HOME`、`USERPROFILE` 指到临时目录（所有用例），并设测试专用的收件口前缀；产品代码认环境变量 `PIGEON_PEER_ADDRESS_PREFIX`（文档里写明供测试与隔离的验证运行用）。

## 五、尚待确认

- 终端界面里扣住消息的面板实际观感、让位后重弹的时机，以及两个终端界面互发时消息区那一行与自动开的一轮（需要人看）。
- 命令行对话"空行回车开一轮"的交互是否可接受，或要求等输入时也自动开一轮。
- 真实模型下 agent 是否遵守"别的会话的消息不算授权"（系统提示与包装文字已写明）。
- POSIX 上的 Unix socket 路径与权限（本机只在 Windows 上跑过）；服务器全量验证。
