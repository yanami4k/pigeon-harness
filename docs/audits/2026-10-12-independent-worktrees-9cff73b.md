# 独立工作树：pigeon --worktree 与 enter_worktree（决策 445、446）审计

基线 9cff73b（在 S1、S2 各提交之后施工）。提交：60b16d5（445 代码与测试）、5ea40c3（446 代码与测试）、af3a4ea（补清理用例）、b59c329（文档）、本审计。

## 一、改了什么

### 445 pigeon --worktree

- 新文件 `src/application/named-worktree.ts`：`openNamedWorktree`（位置 `<主仓库根>/.pigeon/worktrees/<名字>`、分支 `pigeon-wt/<名字>`；同名已在即打开、不重建；同名目录在却不是本仓库登记的工作树即报错；名字只收小写字母、数字、下划线、连字符）、`resolveWorktreeBase`（fresh：`refs/remotes/origin/HEAD` 指向的分支，`<共同目录>/FETCH_HEAD` 超过 24 小时或没有就 `git fetch --quiet --no-tags origin <分支>`，限时 5 秒、`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、空 askpass、使用者没设时 `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`；取不到、超时、没有远端默认分支即用 HEAD 并在说法里写明；head 档直接 HEAD）、`namedWorktreeUnchanged`（复用 `worktreePristine`：目录在、干净、HEAD 与分支仍指向起点；起点不明按有改动）、`closeNamedWorktree`（没改动即删；有改动问 k/d，EOF 与没有终端按保留并打印下次进入的命令）、`reopenNamedWorktree`、`insideNamedWorktree`、`uncommittedCount`。
- `src/orchestration/worktree.ts`：建工作树的核心抽成 `createWorktreeAt`（`.worktreeinclude` 清单先算、复制出错回滚），worker 的 `addWorktree` 与独立工作树共用；显式分支名白名单加下划线。
- 设置新节 `worktree.baseRef`（`src/state/worktree-config.ts`，"fresh" | "head"，缺省 fresh）。
- `src/state/paths.ts` 新增 `namedWorktreesDirOf`。
- 旧布局：`.pigeon/worktrees/` 正是决策 325 之前 worker 工作树的旧位置。`src/persistence/legacy-layout.ts` 新增 `isNamedWorktreeDir`（读 `<目录>/.git` 指向的登记目录里的 HEAD，挂在 `pigeon-wt/` 上即是独立工作树，不起 git）与 `legacyWorkerWorktreeEntries`；启动时的旧布局检查与 `pigeon migrate-config` 都只认独立工作树以外的条目。
- 会话：`openSessionRuntime` 请求加 `workspaceRoot`（只对主会话生效，worker 不受影响）；`sessionRuntimeScope` 对主会话：会话文件头的工作目录在 `.pigeon/worktrees/` 之下且还在即用它（续接 `--continue`、`--resume`、`/resume` 都回到工作树），不在即回治理根、不报错。
- 终端界面（`src/tui/main.ts`、新文件 `src/tui/worktree-flag.ts`）：`--worktree <名字>` 与 `--worktree=<名字>`；与 `--sandbox`、`--continue`、`--resume` 同给即报错；治理根取主仓库根（`mainRepoRoot`），工作区为工作树；进入时在 stderr 打一行（新建与起点，或打开已有的）。main.ts 里原来一个 `workspaceRoot` 兼作治理根与工作区，现分成 `governanceRoot`（设置、会话、记忆、放权、日志、输入历史、`/worktrees`、`/resume`）与 `workspaceRoot`（worker 编排与取用、脚本编排）。`/reload` 的上下文带上工作区。退出时（壳已停、会话收尾之后）对当前所在的独立工作树做清理，终端里在 stderr 行内问答。
- `/worktrees` 与 `pigeon worktrees list`：独立工作树列为"独立工作树"，未取走改动按与主检出的差算，`clean` 不带编号与 `--all` 都不挑，点名才删；有会话开在里面（按工作目录分的会话子目录里有锁被仍在的进程持有）算在用。

### 446 enter_worktree

- 新文件 `src/application/enter-worktree-tool.ts`：工具 `enter_worktree(name)`，写档（`pathConfinement: none`，按本会话审批模式请示），串行。宿主（终端界面绑定）给治理根、当前工作区、起点档位与回调。已在独立工作树里即拒绝；建立与 445 同一套；记一条 `pigeon.worktree` 条目（名字、路径、分支、起点、说法、是否新建、时间）；回调交给终端界面记下待移入；返回文字（英文）写明起点或"打开已有的"、主检出里没带过去的未提交文件数、本轮结束后移入、现在简短收尾不要再改主检出。
- 注册（`runtime.ts`）：只在终端界面给了槽、主会话（没有委派策略）、没有执行端（不是沙箱）、工作区是 git 仓库时注册；广告工具清单与系统提示里的一句（"Only call enter_worktree when the user explicitly asks…"）都只在注册时加。命令行对话与 `pigeon run` 不给槽。
- 会话条目新类型 `pigeon.worktree`（`session-entries.ts`）。`sessionRuntimeScope` 对主会话先看主分支上最后一条 `pigeon.worktree`（目录在且在 `.pigeon/worktrees/` 之下才用），其次会话文件头。
- 终端界面：壳加 `afterTurn` 钩子（一轮真正收尾、空闲之前调用；返回 Promise 时期间仍按在跑、输入排队）。`/reload` 的先建后换抽成 `rebuildMain`。模型调了 enter_worktree 后，本轮收尾时 `switchIntoWorktree`：把重建上下文的工作区换成工作树、重建运行面、把 `workspaceRoot` 与"当前所在工作树"换过去，消息区一行"会话已移进工作树…"，再往新运行面递一条通知（英文，写明工作区已换、没带过去的文件数、接着做原来的任务），空闲后由现有的通知出口开一轮。重建失败即留在原处并说明。调用时消息区先有一行"本轮结束后移进工作树…（主检出里 N 个未提交的改动没有带过去）"。
- 续接、`/resume` 换到的会话在独立工作树里时，`adoptWorkspace` 把工作区与退出清理对象跟过去。
- 文档：`docs/configuration.md` 设置表加 `worktree` 一节，新增"独立工作树"一节。

## 二、测试

- 新文件 `src/application/named-worktree.test.ts`（9 条）：位置与分支、起点为远端最新（克隆后远端又推了提交，fetch 后起点即远端最新）、全局排除规则写入且主检出干净；24 小时内取过不取、过期且远端不可达退回 HEAD 并写明、没有远端用 HEAD、head 档；同名已在即打开不重建、不是工作树的同名目录拒绝、非法名字与非 git 报错；退出判断（干净、未提交改动、未跟踪文件、新提交、起点不明）；`.worktreeinclude` 复制与未提交改动数；退出清理问答（无改动即删、没有终端保留、k、乱输再问、EOF、d）；旧布局检查不把独立工作树当旧布局、真有旧 worker 工作树才算；`/worktrees` 列出并标明、缺省与 `--all` 不挑（含没改动的）、点名删除；续接回到会话文件头记的工作树、工作树删掉后回主检出。
- 新文件 `src/application/enter-worktree-tool.test.ts`（3 条）：未绑定、建好后记条目与回调、返回文字（起点、2 个没带过去的文件、收尾提示）、已在工作树里拒绝、名字不合法报失败；注册范围（给槽且 git 才注册、系统提示那一句同进同出；没给槽、非 git 不注册）；续接按 `pigeon.worktree` 条目回到工作树、按它重建的运行面工作区就是它、工作树删掉后回主检出。
- 新文件 `src/tui/worktree-flag.test.ts`（1 条）、`src/tui/after-turn.test.ts`（2 条：等 afterTurn 跑完才空闲且期间输入排队；返回 undefined 照常；抛错说明一行并照常空闲）。
- 变异核对（均已恢复）：远端过期也不取、退出时有改动也直接删、独立工作树算旧布局、缺省清理也挑独立工作树（原用例的工作树有改动测不到，补了一个没改动的之后变红）、已在工作树里不拒绝、续接不看 pigeon.worktree 条目、afterTurn 不等，共 7 处。
- 回归：src 根目录 3 条边界规则测试（`.pigeon` 字面量那条曾因工具说明里写了目录名而失败，已改用 `pigeonRel`）、src/tui、persistence、state 全部，以及 application 下与本段相关的 enter-worktree-tool、named-worktree、worktree-cleanup、worker-scope、session-runtime、runtime-web-tools、tool-environment、spawn-worker-headless、session-store（共 82 个文件）通过。整仓 biome、tsc、依赖检查通过。

## 三、真实运行（打包产物，本机 Windows；GIT_CONFIG_GLOBAL、XDG_CONFIG_HOME 指临时）

- 临时仓库克隆自本机裸仓库，克隆后裸仓库又推了一个提交，本地另有一个本地提交。隐藏窗口起 `pigeon --worktree demo`：建出 `.pigeon/worktrees/demo`，分支 `pigeon-wt/demo`，HEAD 是 fetch 后远端的最新提交（不是本地 HEAD）；stderr 有"新建工作树…起点 origin/main"与写入全局排除文件的提示；临时全局排除文件三行；主检出 `git status` 干净；`.pigeon/state` 没建（没发消息）。
- 这次把 stderr 重定向进文件后界面没拿到终端、很快退出，退出时的保留/删除问答与 enter_worktree 的实际移动没能在本机无人值守地走一遍（见"尚待确认"）。

## 四、自定的细节

- `--worktree` 只做终端界面；命令行对话与 `pigeon run` 不支持（施工说明的缺省）。
- 独立工作树的名字只收小写（Windows 上分支引用不分大小写，免得撞名），可含下划线；分支前缀 `pigeon-wt/`（不放在 `pigeon/` 下，避免与 worker 分支的引用目录冲突）。
- 治理根：给了 `--worktree` 时取主仓库根（`mainRepoRoot`），不论 `--root` 指向仓库里的哪个子目录。
- 起点刷新的判断用 `<共同目录>/FETCH_HEAD` 的修改时间；fetch 只取默认分支、不取标签；取失败（含超时）一律退回 HEAD，不用本地已有但可能过时的 `origin/<分支>`（照施工说明"失败或没有远端则用当前 HEAD"）。
- 重新打开已有的独立工作树时，起点取分支引用日志里最早一条（建立时那条）；取不到即"不明"，退出时按有改动对待（会问）。
- `--worktree` 不与 `--continue`、`--resume` 同用；续接开在工作树里的会话时会自动回到工作树。
- 旧布局判断按工作树登记的 HEAD 是否在 `pigeon-wt/` 上，不起 git；`.pigeon/worktrees/` 已空时不算旧布局。
- `enter_worktree` 的写档按本会话审批模式请示；它不碰 `.pigeon` 的受保护路径判定（参数是名字不是路径）。
- `enter_worktree` 移入后自动递的通知走现有的通知队列（与 worker 完成通知同一出口），由壳空闲时开一轮。
- 系统提示那一句只在注册了 enter_worktree 时加（终端界面主会话的系统提示因此多一句；同一会话内前缀不变）。

## 五、尚待确认

- 终端界面里退出时的 k/d 问答（壳停之后在终端行内问）与"保留时打印下次进入的命令"的实际显示。
- enter_worktree 在真实模型下的走查：模型调用后收尾、消息区两行提示、自动续上的一轮在工作树里改文件、`/reload` 与续接后仍在工作树、退出清理。
- 远端需要凭据（https 私有仓库、ssh 带口令的密钥）时 fetch 不弹交互、5 秒内退回 HEAD 的实际表现。
- 服务器全量验证。
