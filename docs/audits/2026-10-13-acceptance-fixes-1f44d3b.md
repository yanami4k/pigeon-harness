# 产品体验一批的验收修改（决策 451–455 与两处修正）

基线 1f44d3b，分支 worktree-product-build。本文只记事实：改了什么、怎么验的、还剩什么。

## 改动

### `/resume` 会话列表在矮窗口里只剩提示行

- 现象：窗口不高时，`/resume` 不带会话号弹出的列表只显示提示行，列表项看不到。
- 成因：全屏布局（决策 441）的根是 pi-tui 的 VStack，除消息区外各块按自身高度排；总高超过窗口时，VStack 按各块高度加权压缩（缺省 `shrink` 为 1），最高的一块被压得最多。会话选择器（提示行带上下空行，再加列表）被压到只剩前三行。用本机两份真实会话放进模拟终端复现：12 行高时与看到的一致，24 行以上正常。设置面板（`/config`）同理。
- 改法：会话选择器、设置面板与输入框在布局里标为不压缩（`src/tui/shell.ts` 的 `keep`），窗口装不下时先压消息区、标题、状态行与状态栏；审批框照常可压缩（它可能很高，按 [r] 写理由时输入框必须留在屏幕上）。列表的可见行数每次画时按当前窗口高度现取（选择器为窗口高度减 8 行，设置面板再减 5 行说明与提示），变了即保留选中项重建列表，超出的随选中项滚动；两处的提示行去掉上下空行。设置面板的选中项 pi-tui 0.84.4 没有公开的取法，重建时读它的内部序号（`selectedIndex`，取不到即第一项；升级 pi-tui 时须核对）。
- 用例：
  - `continue-flags.test.ts`：16 行与 12 行窗口打开 `/resume`（12 行时往下选到第 4 项、回车照常进）；12 个会话时 40 行打开、缩到 14 行（输入框两道边框都在、选中项不变、往下选到底照常进）。
  - `config-panel.test.ts`：16 行窗口打开 `/config`（提示行、选中项、说明与末行按键提示都在，翻到最后一项仍可见）；打开后缩到 15 行；组件层"可见项数随高度变、选中项保留"。
  - `session-panel.test.ts`：24 行窗口里面板来了很高的审批块，按 r 写理由时理由看得见、回车照常作答。

### 回退写回与 `.worktreeinclude` 复制拦 `.git` 段

- 两处原先靠"快照树与 `git ls-files` 的结果里不会有 `.git`"这一前提。现在与写文件工具用同一个判断 `insideGitMetadata`（`src/tools/paths.ts`），任一路径段为 `.git` 即不写：会话回退的写回（`src/orchestration/rewind-restore.ts`，列为"版本库元数据（.git）不碰"）、回退规划（`src/application/rewind.ts`，与 `.pigeon` 段同样跳过）、`.worktreeinclude` 的清单与复制（`src/orchestration/worktree.ts`）。
- `insideGitMetadata` 同时收紧：段尾的点与空格去掉再比（Windows 会丢掉它们），`GIT~1` 一类 8.3 短名也算。写文件工具与容器执行端随之一并收紧。
- 用例：`paths.test.ts` 列举算与不算的写法；`rewind-restore.test.ts` 四种写法的路径都不写、目录都不建；`worktree.test.ts` 被忽略又被列出的 `vendor/git~1/config` 不复制。

### 451 欢迎头

- `src/tui/welcome.ts`：鸽子（四分块字符 11 列 × 5 行）在左，右边 `Pigeon v版本`（加粗）、模型（453）、当前目录（主目录缩写为 `~`），与鸽子纵向居中；上下各一行空行。并排的条件是名字版本与模型都放得下、目录至少留 16 列（目录过长只截目录）；否则只留文字，各行按宽度截断（截断写 `...`）。鸽子不带任何样式。
- 欢迎头是消息区的第一项（`MessageFlow.setHeader`），随消息滚动；`clear()`（会话回退、切换分支）之后仍放回最上方。版本取包根 `package.json`（`pigeonVersion` 由 `src/cli/index.ts` 挪到 `src/application/harness-ref.ts`，`pigeon --version` 照用）；目录取终端界面启动时的工作区根。

### 452 收尾行

- 措辞在 `src/application/format.ts` 的 `workEndLine` 与 `formatElapsed`：`done`、`interrupted`、`error · 用时 · 原因首行`、`stopped: output limit`（停止原因为 length）、`stopped: looping` 与 `stopped: turn limit` 等上限、`stopped`（熔断）、`ended`（未知）；上限与叫停先于"被打断"判断。用时不到一分钟写秒，不到一小时写分秒，再长写时分。
- 实时（`src/tui/shell.ts`）：空闲时人发出消息、或程序通知叫醒 agent 时记下开始时刻；每次运行结束只记下结果（含收尾钩子拦下后接着跑的各轮）；真正空闲（收尾钩子与 `afterTurn` 都跑完、排队的输入与通知都没有接着开跑）时按最后一次运行的结果落一行。刚收尾就由通知接着跑的（换进工作树后自动续一轮、worker 的结果送达等）算同一次工作，开始时刻不变；排队的人的输入或命令发出之前先落上一次的收尾行。被打转检测等叫停的，按叫停原因写（与回看同一写法）。`run()` 自身抛异常时为 `error` 加异常文字。原先的终态摘要（`== run: … | stop: … | 分类：… ==`）删除。
- 轮次结束不再落 `-- turn: … --`（`projectRuntimeEvent`，主会话、worker 会话与面板会话共用）。面板会话的实时消息区没有收尾行，轮内出错时写一行 `error · 原因首行`（`turnErrors` 选项）；worker 会话的出错照旧由 worker 收尾的结果行写明。
- 回看历史（`src/application/history.ts`）：每个运行收尾条目一行，用时取该运行开始条目的 `startedAt` 与收尾条目的 `endedAt`，种类取收尾条目的 `ending`、`stopReason`、`errorMessage`；历史行种类 `marker` 改为 `end`。
- 用例：`format.test.ts` 的用时与各档措辞；`history.test.ts` 的出错带原因、到轮数上限、被打断、续跑后仍截断；`cancel.test.ts` 的实时各档、"用时从发出消息算到工作结束"（可控时钟，`done · 1m 23s`）与打转叫停写 `stopped: looping`、下一次 Esc 打断写 `interrupted`；`after-turn.test.ts` 的"收尾后由通知续一轮只落一行、用时从发出消息算起、下一条输入的回显在收尾行之后"；`session-panel.test.ts` 的面板会话轮内出错写一行、主会话的投影不写；`shell.test.ts`、`approval.test.ts`、`orchestration-ui.test.ts`、`tui/history.test.ts` 改为断言收尾行、断言没有轮次标记与终态行。

### 453 模型名

- `src/tui/welcome.ts` 的 `modelLabelOf`：取运行面的模型信息（`RuntimeBundle.modelInfo`），写作"模型 id · 服务商"；身份只有启动参数的占位标签（custom）时为空，不显示。`src/tui/main.ts` 把它交给状态栏与欢迎头，原先的 `${flags.provider}/${flags.modelId}` 不再用。

### 454 弱化样式

- `src/tui/style.ts` 的 `secondary`（SGR 2/22，与思维块原用的同一种）。用到：思维块（原 `dimLine` 删除）、状态行、状态栏、输入框补全列表的说明与滚动提示、会话选择器的提示行与滚动提示、设置面板的提示行与说明与按键提示、欢迎头的模型与目录、收尾行。
- 用例：`welcome.test.ts` 断言状态栏整段、状态行与收尾行写给终端的内容带暗色。

### 455 补齐给模型看的英文

- `src/state/runaway-config.ts` 的 `TRUNCATION_CONTINUE_PROMPT`、`TRUNCATION_RESUME_PROMPT` 改为英文；原来的两句中文并入 `PREVIOUS_TRUNCATION_RESUME_PROMPTS`，回看历史时照样认作续跑提示。
- 静态扫描：对 `src/`（不含测试与夹具）里带中文的字符串按流向逐条判断是否进模型上下文。只给模型看的改为英文：
  - `src/tui/approval.ts`：审批面板关闭、未装配、并发防御三种取消交给模型的拒绝理由（`cancelReasonForModel`），面板与消息区照旧显示中文；
  - `src/state/json-schema-check.ts`：脚本输出格式校验的各条报错（经纠正提示交给 worker 的模型）；
  - `src/execution/script-snapshot.ts`：脚本运行号不合法（经 orchestrate 的工具结果）；
  - `src/pi-runtime/adapter.ts`：治理判定异常时的阻断理由外壳（被包进去的底层报错照旧）。
- 系统提示、开工状态块、工具说明与参数说明、worker 通知、脚本通知、打转提醒、钩子补的上下文包装、各工具自身的返回文字已是英文。

## 验证

- 变异：撤掉选择器与设置面板的不压缩（各自的矮窗口用例变红）；撤掉回退写回与工作树复制的 `.git` 段判断（两条用例变红）；欢迎头加在末尾、清空后不放回、不记工作开始时刻（各自变红）；面板视图的审批框改回不压缩、通知续跑不算同一次工作、不记叫停原因、面板会话不写轮内出错、窗口变矮不重算选择器行数、设置面板不重算或不保留选中项（各自变红）。
- 独立复查一轮（只看本批 5 个提交）：报出面板里高审批块把写理由的输入框顶出屏幕、通知续跑落两行收尾、打转叫停实时写成 interrupted、面板会话看不到轮内出错原因、列表打开后窗口变矮不重算，均已修正并补用例；其余核查项（其他视图的布局、收尾行在排队、取消、异常与钩子续跑下的生命周期、历史行种类的消费方、欢迎头的缓存与退出打印、各宽度下的欢迎头、主目录缩写、`.git` 判断的误伤面、取消理由与扣住消息面板的比较、模型名在续接与重读后的取值）未发现问题。
- 本机（单进程）：`src/application`、`src/tui`、`src/orchestration`、`src/cli`、`src/state` 与相关文件 232 个测试文件，1113 条通过、3 条失败：`checkpoints-async.test.ts` 的"保留修改时间的同长度覆盖"与 `spawn-worker-headless.test.ts` 的"撞上时间上限"在基线 1f44d3b 的临时检出上同样失败（本机时序，pigeon-verify 上基线是通过的），`script-acceptance.test.ts` 的"脚本卡住监控"单独重跑通过。复查修正之后终端界面全部用例通过；biome、tsc、依赖检查干净。全量 verify:full 交 pigeon-verify 跑。

## 尚待确认与已知限制

- 人和模型共用、仍为中文的报错（扫描所得，待定口径：改英文、或像 `src/tui/worktree-switch.ts` 那样中英分开传）：
  - `src/application/named-worktree.ts`：工作树名字不合法、仓库还没有提交、不在 git 仓库里、目录已存在但不是本仓库工作树，以及起点说明（`HEAD（没有远端默认分支）`、`HEAD（取远端超时/失败）`）；经 `enter_worktree` 的工具结果进模型，`pigeon --worktree` 时给人看。
  - `src/orchestration/worktree.ts`、`src/execution/workdir-snapshot.ts`、`src/execution/worker-overlay.ts` 的 `git … 失败：…` 与 `.worktreeinclude` 复制失败、起点提交不合法；经 `spawn_worker`、`enter_worktree`、`take_worker`、`orchestrate` 的失败结果进模型。
  - worker 失败原因原样透传给派出方：`EMPTY_REPLY_ERROR`（`src/pi-runtime/adapter.ts`）、流式重复检测出错（`src/pi-runtime/repetition-guard.ts`）、`run()` 互斥与已释放的报错（`src/pi-runtime/adapter.ts`）；经 worker 通知、`wait_workers`、`worker_status` 进模型，同一文字也写进会话记录与收尾行。
  - `src/pi-runtime/complete.ts` 的"模型请求以 … 收尾"（`web_fetch` 内容提炼出错时）；`src/application/web-tools.ts` 的搜索后端缺 key（`/reload` 之后 key 没了的边缘情况）。
  - `src/application/script-naming.ts` 的点名关键词"脚本编排"本身出现在 orchestrate 的工具说明里（判定看人的输入里有没有这四个字），是否豁免待定。
- 鸽子用的 `▀ ▄ █` 属东亚宽度"歧义"字符，把歧义字符按两格宽显示的终端里会错位（Windows Terminal 缺省按一格）。
- worker 会话与面板会话的实时消息区不落收尾行（只有主会话的工作有"开始"的概念）；面板会话只在轮内出错时写一行原因；回看它们的历史时每次运行一行。
- 主会话里轮内出错后被自动重试并成功的（例如服务方拒收图片后换占位重试），原先在轮次标记里留有痕迹，现在消息区不再提示（会话记录照常记下）。
- 钩子以 continue:false 停下的运行，收尾行写 `interrupted`（实时与回看相同），原因在上方另一行钩子提示里。
- 窗口极矮（设置面板约 8 行以下）时，列表、输入框与面板本身合计仍放不下，超出的部分在屏幕外。
- 状态栏与欢迎头的模型名在启动时取定，`/reload` 之后不重取（模型身份来自启动参数与接入模块，进程内不变）。
- 回看历史时按"每次运行"算用时，实时按"整次工作"算；收尾钩子拦下后接着跑的一轮、通知续跑的一轮在回看里各自单独一行。
