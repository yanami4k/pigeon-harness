# /config 设置面板（决策 442）审计

基线 9cff73b，分支 worktree-product-build。

## 一、改了什么

- 新文件 `src/application/config-options.ts`：六项选项（`thinking.level`、`web.enabled`、`loopGuard.enabled`、`modelRequest.maxRetries`、`contextPrune.enabled`、`truncationContinuation.enabled`），各带可选值（含 `default` = 不写）与缺省说明。`configView` 给出每项的生效值（取会话快照，没写即"缺省值（缺省）"）、用户级写的值、覆盖它的更高层（项目共享或项目个人，读三层文件判断）。`setUserConfig` 只写用户级 `~/.pigeon/settings.json`：读原文件（不是合法 JSON 或顶层不是对象即拒绝）、只改这一个键（`default` 删键，节空了删节）、按设置校验规则核对整份文件后原子写入；文件或目录不存在即新建。`parseConfigAssignment` 解析 `选项=值`。
- 新文件 `src/tui/config-panel.ts`：pi-tui 的 `SettingsList` 包一层，放在布局里（会话选择器与输入框之间），标签为"中文名（选项名）"，说明里写生效值与覆盖情况；光标 `> `，提示行里的 `·` 换成 `|`。改动后按最新读数重建列表、选中项不变。
- `src/tui/shell.ts`：新选项 `config`（`view`、`set`）；`/config` 不带参数打开面板，`/config 选项=值` 直接改；改动后写一行"已写进 …：选项 = 值"，被项目覆盖的另写提醒，随后走装配方给的 `reload`（与 `/reload` 同一条重建路径，重建期间与运行同样占住输入），完成后刷新面板；没有 `reload` 时写"下次启动时生效"。面板开着时按键归它。
- `src/tui/command-table.ts`、`commands.ts`：登记 `/config`（运行中不可用，理由"改设置后重建运行面"）与分派。`src/tui/main.ts`：`config` 取本会话当前的设置快照（`/reload` 之后即新的）与 `setUserConfig`。
- 文档：`docs/configuration.md` "终端界面"一节加"设置面板 `/config`"。

## 二、测试

- 新文件 `src/application/config-options.test.ts`（3 条）：清单六项；没写为缺省、用户级的值、项目共享层与项目个人层覆盖时标明哪一层（真实三层文件经 `loadSettings`）；写用户级保留其余内容、`default` 删键与空节、非法值与未知选项拒绝、坏 JSON 不写且原样不动；文件不存在时新建；`选项=值` 解析。
- 新文件 `src/tui/config-panel.test.ts`（3 条）：`/config` 打开面板（标签、无 `·` 与 `→`）、方向键加 Enter 轮换值即写入并调用重建、面板刷新出新的生效值、Esc 关；`/config 选项=值` 直接改、被项目覆盖的提醒、非法值如实报错且不重建、格式不对给用法；运行中 `/config` 被拒。
- 既有用例的改动：`src/tui/input-queue.test.ts` 的"运行中不可用"清单加 `config`（新命令）。

## 三、验证

- 变异核对（均已恢复，7 处全部变红）：覆盖判断不看项目个人层、`default` 之后留下空节、改动覆盖整份文件、任意字符串都收、改完不重建、提示行留着 `·`、被项目覆盖不提醒。
- 回归（一个 vitest 进程）：src 根 3 条边界测试、src/tui、src/state、src/persistence 全部与 config-options、settings-reload、session-settings，87 个文件 421 条通过、2 条跳过（边界测试曾拦下面板标题里的 `.pigeon` 字面量，已改用路径模块）。整仓 `npx biome check .` 无问题、`tsc` 通过、`npm run deps` 无违规。
- 真实运行（打包产物，临时 HOME 等）：用户级设置写了 `web.enabled=false` 与 `modelRequest.maxRetries=2`，隐藏窗口起终端界面 10 秒后仍在运行。面板的按键与显示需要人看（第五节）。

## 四、自定的细节

- 六项与施工说明的缺省清单一致；`thinking.level` 的"缺省"按模型（会推理的 high，其余 off），`modelRequest.maxRetries` 面板里给 0、1、2、4、6、8，`/config` 可写 0 到 999 的整数。
- 面板显示"用户级写的值"作为当前值（轮换改的就是它），生效值写在说明里；`--thinking` 等启动参数优先于设置这件事没有在面板里标出。
- "被项目设置覆盖"按项目共享层与项目个人层是否写了这个键判断（不看值是否相同）。
- 写入走 `/reload` 的重建；有 worker 在跑时重建按 `/reload` 的口径被拒，文件已写，下次 `/reload` 或启动生效（文档写明）。
- 用户级设置文件不是合法 JSON 时一律不改（不覆盖使用者手写的内容）。

## 五、尚待确认

- 面板的观感与按键（需要人看）；六项清单是否合适。

## 六、审查修正（9f06914 之后）

### 改了什么

- 改值的时机：主运行中、上一次改动的重建还没完（第二次 Enter）、或有 worker 在跑（含排队）时一律不改，说明原因，不写文件。worker 的判断与 `/reload` 同一口径，由入口给出（`config.busy`），在写文件之前查——之前是先写文件、重建被拒，文件与运行面不一致。上文"四、自定的细节"里"有 worker 在跑时文件已写、下次生效"的做法作废。
- 按键：设置面板开着时编排的按键入口不响应（↓ 不再进 worker 面板，回车改的是面板里选中的那一项），只留切换树形视图的键；切到主视图以外的视图即关面板；审批挂着（含写拒绝理由）时面板不收键。面板开着时不从排队里发出输入与通知，关面板时排空一次。
- 读设置出错：`config.view()` 抛错（某层设置文件坏了）时在消息区说明"读不了设置：…"，面板不打开（已开着的关掉），界面照常可用；写入后的覆盖提醒与面板刷新同样不抛。
- 思考档位加 `max`（`runtime-events` 的 `ThinkingLevelSchema` 有 `max`，配置文档第 113 行也列了它）。
- 被 git 跟踪的 `settings.local.json` 写了某项时，面板按"项目共享设置"标（`configView` 用 `localSettingsTracked`，与键位、450 的 `messaging.inbound` 同一认定）。
- 建议项：值没变不重写（返回"已经是 …，没有改"，不重建）；文件不存在时设成 `default` 不新建 `{}`；用户级设置文件是符号链接、是目录或只读时不写并说明（不把链接换成普通文件、不改权限、目录不再报 EISDIR）；标签只放中文名，选项名移到说明开头（pi-tui 标签列最宽 36 列）；生效值不含启动参数，面板说明与文档写明。改前比对修改时间没有做（见尚待确认）。面板说明的生效值标注"不含启动参数"。

### 测试

- `src/tui/config-panel.test.ts` 加 5 条（共 8 条）：重建未完时第二次 Enter 不改、不并发重建，有 worker 在跑时不写；读设置出错如实说明、之后照常发消息；有 worker 在跑时面板开着 ↓ 与回车改面板的项、不进 worker 面板；写拒绝理由时 r、理由文字与回车不改设置，切树形视图即关面板（再按回车不改）；面板开着时排队的输入不发、关面板即发。值没变不重建并入原第二条。
- `src/application/config-options.test.ts` 加 4 条（共 7 条，符号链接一条在 Windows 上跳过）：清单含 `max`；值没变不重写（修改时间不变）、文件不存在时设 `default` 不新建；只读文件不改；符号链接不改且仍是链接；被跟踪的 local 层按共享层标；带 BOM 的用户级设置照常读改；`1000`、`True`、`a=b` 拒绝。
- 既有用例的改动：第一条的标签断言由"思考档位（thinking.level）"改为分别看中文名与说明里的"thinking.level："（标签缩短）；测试里的假 `set` 照新约定在值没变时返回 `undefined`。

### 验证

- 变异核对（均已恢复，13 处里 12 处变红）：不查运行与重建中、不查 worker、`view()` 抛错不接、↓ 进 worker 面板、审批挂着时面板收键、离开主视图不关面板、面板开着时排空队列、关面板不排空、去掉 `max`、被跟踪的 local 层仍标个人层、值没变照写、只读照写。保持绿的一处是"文件不存在时设 `default` 不新建"的单独判断：后面的"值没变不写"已覆盖它（空文件里该键也是没写），这行多余，已删掉。
- 回归（一个 vitest 进程）：src 根 3 条边界测试、src/tui、src/cli、src/state、src/persistence、src/pi-runtime 全部与 format、config-options、migrate-config、session-settings、settings-reload、search，141 个文件 773 条通过、4 条跳过；面板说明加"不含启动参数"后另跑 `config-panel.test.ts` 与 `input-queue.test.ts` 14 条通过。整仓 `npx biome check .` 无问题、`tsc` 通过、`npm run deps` 无违规。
- 真实运行（打包产物，临时 HOME 等）：用户级设置写 `thinking.level=max` 与 `web.enabled=false`，隐藏窗口起终端界面 10 秒后仍在运行。面板里的按键与重建需要人操作，未做。

### 尚待确认（补充）

- 写入前没有比对文件修改时间：面板开着期间别处改了用户级设置，按 Enter 时读的是最新文件（读、改、原子写在同一次调用里），但面板上显示的旧值要等刷新才更新。
- 面板的生效值不含启动参数（`--thinking`、`--no-web` 等）：照实写在说明里，没有把启动参数合进来。
