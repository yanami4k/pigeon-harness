# 会话文件等第一次真要落盘时才建（决策 432）审计

基线 c1ec2cc。提交：06ed9b1（决策）、48c83cb（代码与测试）、6188b78（文档）。

## 一、改了什么

- 写者（`src/pi-runtime/session-store.ts`）：新增选项 `deferCreate`。没有既有文件时不建文件、不取锁，核心挂一份暂存；`pigeon.hook` 条目在未建时进暂存，其余写入（消息、其他自定义条目、移出截断回复、压缩条目）先排进队列建文件并取锁、按原顺序补写暂存，再写自己。未建时读主分支给空数组、`filePath()` 为 undefined；新增 `fileDeferred()`。最后一个写者关闭时仍未建即丢弃暂存、不留文件。同进程再开的写者共用同一核心、随它的状态。建文件失败交给发起那次写入的写者的告警口（它没有时交给建核心的写者）。原有的打开与新建逻辑拆成 `openOrCreate`，不推迟时行为不变。
- 装配：`openSessionStore` 透传 `deferCreate`；`buildRuntime` 的 deps 与 `openSessionRuntime` 的请求加 `deferSessionFile`。终端界面新开会话（`src/tui/main.ts`，`--continue`、`--resume` 以外）与命令行对话（`src/cli/index.ts`）给出；`pigeon run`、worker、分支会话与 `/resume` 换绑不给。
- `/reload` 一律按续跑打开：`restoreContext` 遇到未建的文件按没有可还原的处理（0 条），不再报"续跑中止"；新旧写者共用同一推迟状态。
- `/fork`：未建时报"本会话还没有任何 Run，没有可分叉的位置"（与空会话同一句），不再报"会话存储打开失败"。
- 会话树（`session-family.ts`）：当前会话没有文件时按没有 Run 的主会话列出，不显示"读不到"；家谱里提到的其他会话没有文件照旧"读不到"。
- 读的一侧：`session-reader.ts` 新增 `sessionHasContent`（逐块读到文件头之后第一条非钩子运行记录为止，按块解码防多字节字符跨块；读不出的行与写了一半的末行按有内容算）。`listSessionSummaries`（`pigeon session list` 与 `/sessions`）跳过没有内容的会话；`hasSessionHistory` 对会话树以外的会话逐个看到第一个有内容的为止。
- 文档：`docs/configuration.md` 程序状态目录一节加会话文件何时建，按环境注册一节写明从没开始过对话的会话不算历史。

## 二、测试

- 新增 `src/pi-runtime/session-store-deferred.test.ts`（6 条）：未建时不建文件不取锁、读主分支为空；只有钩子运行记录时关闭不留文件与锁；第一条消息时建文件取锁、钩子运行记录按事件顺序补写在前，建后照常直接写；非钩子自定义条目同样触发；同进程第二个写者共用推迟状态；建文件失败报给触发写入的写者、不抛。
- 新增用例：`main-reload.test.ts` 两条（第一条消息前 /reload 不出错不建文件、发消息后只有一个文件且 1 个 Run；打开即释放不留文件与目录）；`fork-session.test.ts` 一条；`session-tree.test.ts` 一条（家谱与界面）；`session-reader.test.ts` 一条（含 120KB 中文钩子输出跨读块）；`session-list.test.ts` 一条；`tool-environment.test.ts` 一种环境（只有从没开始过对话的会话）。
- 改动的既有用例：`tool-environment.test.ts` 与 `session-search-switch.test.ts` 原以只有文件头的会话代表"有历史会话"，按新口径补一条用户消息，断言不变。
- 变异核对（改回后对应测试变红，均已恢复）：钩子运行记录也触发建文件、忽略推迟开关、暂存倒序补写、触发写入排在建文件之前、/reload 不认推迟、会话树不认当前会话、钩子运行记录算内容、历史判断不看内容、列表不过滤、/fork 不认推迟，共 10 处。
- 本机：受影响的 68 个测试文件分四批跑，除 `container-host.test.ts` 一条外全部通过；该条在基线 c1ec2cc 上同样失败（假 docker 拉起 node 报 Command not found），与本次改动无关。tsc 无错误（本工作树装有 photon）；biome 与依赖检查通过。

## 三、真实运行（打包产物，本机 Windows）

- 终端界面在临时 git 仓库启动、不发消息，8 秒内 `.pigeon` 下只有 `.gitignore`，没有会话文件与锁；结束进程后同样。改动前同样启动即有只带文件头的会话文件与锁。
- 命令行对话空输入退出：没有会话文件。
- 命令行对话发一句话：会话文件在这条消息时建出，含 Run 开始、状态、消息、重试与 Run 收尾条目，`pigeon session list` 列为 1 个 Run。这次模型请求本身在本机环境里连接失败（Connection error，重试 4 次），与本次改动无关。

## 四、尚待确认

- 服务器全量验证：第二次 TB 比较跑完之后补做。
- 配了会话开始钩子时的实际体验：钩子运行记录在第一条消息时补写进会话文件（单元测试已覆盖，未在真实钩子上跑过）。
- 沙箱会话在第一条消息之前 `/reload` 且改了沙箱配置时，提示"退出后用 pigeon resume <会话号> --sandbox 续跑"，此时会话文件尚未建，按提示续跑会找不到会话；未改。
