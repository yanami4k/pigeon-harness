# 忽略规则改写全局排除文件、程序状态目录首次写时才建（决策 444，含 445 加的工作树一行）审计

基线 9cff73b（在 S1 各提交之后施工）。提交：8e81ca7（代码与测试）、e5008a3（补去重用例）、82034d9（文档）、本审计。

## 一、改了什么

- 新文件 `src/persistence/global-ignore.ts`：
  - `globalExcludesFile`：`core.excludesFile`（只读全局层）为绝对路径或以 `~` 开头时用它；否则 `$XDG_CONFIG_HOME/git/ignore`；未设 XDG 时 `~/.config/git/ignore`。
  - `ensureGlobalIgnoreRules`：不在 git 工作树里即不做；用 `git check-ignore --no-index --stdin` 探测 `.pigeon/state/probe`、`.pigeon/settings.local.json`、`.pigeon/worktrees/probe` 是否已被忽略；缺的规则（`**/.pigeon/state/`、`**/.pigeon/settings.local.json`、`**/.pigeon/worktrees/`）追加进全局排除文件，文件里已有的行不重复，原文件没有末尾换行时先补换行。写入后经提示口给一行（写进了哪个文件、哪几行）；出错只提示一行、不抛。git 调用关掉 fsmonitor、限时 10 秒。
  - `ensureGlobalIgnoreRulesOnce`：同一进程同一目录只做一次。
- `src/persistence/settings.ts`：
  - `ensureProjectStateDir` 不再写 `.pigeon/.gitignore`：建 `.pigeon/state/`，再调 `ensureGlobalIgnoreRulesOnce`。
  - 新增 `ensureLocalSettingsIgnored`（写个人设置之前：建 `.pigeon/`、确保规则）与 `ensureStateDirOf`（给 `.pigeon/state/` 之下的路径，找到所属根再按上面准备；用户级 `~/.pigeon/state/` 不动）。
  - 删掉 `ensurePigeonGitignore`；`src/state/paths.ts` 删掉 `PIGEON_GITIGNORE_LINES`。`projectPigeonGitignorePath` 与 `PIGEON_GITIGNORE_REL` 保留（快照仍认得旧文件）。
- 启动不再建目录：`openSessionSettings`（终端界面、命令行对话、`pigeon resume`、`pigeon run` 都经它）去掉 `ensureProjectStateDir`。
- 第一次真写程序状态的入口：
  - 会话文件：`pi-runtime/session-store.ts` 的写者选项加 `beforeCreate`（新建会话文件之前调用一次，抛错不挡建文件），`application/session-store.ts` 透传，`runtime.ts` 给出 `ensureProjectStateDir(治理根, 存储告警口)`。终端界面与命令行对话推迟建会话文件（决策 432），因此在第一条消息时才建目录；`pigeon run`、worker、分支会话建会话时即建。
  - 个人设置：`grants-config.ts`（`/grants save`）改调 `ensureLocalSettingsIgnored`。
  - 迁移：`migrate-config.ts` 四处改为 `ensureProjectStateDir` / `ensureLocalSettingsIgnored`，每次迁移确保的是全局规则。
  - 可能在第一条消息之前发生的写入：输入历史（`prompt-history.ts`）、检索缓存（`session-search-cache.ts`）、学到的记忆（`learned-store.ts` 的 `writeMemoryFile`）调 `ensureStateDirOf`。
  - 其余写入点（命令输出落盘、后台作业记录、worker 工作树、检查点等）都发生在会话文件已建之后，未另加调用（盘点见下）。
- 原"`.pigeon/.gitignore` 缺行时提示一行"去掉，改为写进全局排除文件时提示一行。
- 测试总装（新文件 `scripts/vitest-git-env.mjs`，`vitest.config.ts` 的 `setupFiles`）：每个测试进程开跑前把 `GIT_CONFIG_GLOBAL` 指向一份临时副本（照抄真实的全局配置以保住提交身份等，只去掉 `core.excludesFile`），`XDG_CONFIG_HOME` 指向临时目录；测试起的子进程继承。
- 文档：`docs/configuration.md` 程序状态目录一节（启动不建、首次写时建、全局排除文件的位置与三行、非 git 不写、写不进只提示）与迁移一节。

### 写入点盘点（启动时与首次使用时）

- 启动时无条件写项目目录的只有 `ensureProjectStateDir`（经 `openSessionSettings`），已去掉。
- 启动时的其他动作：用户级配置确认记录（`~/.pigeon/state/config-trust.json`，不在项目里）；续接已有会话时取锁（会话文件本就在）；后台作业的崩溃清理只读、只删；终端界面日志目录只在 `PI_DEBUG_REDRAW=1` 或单行超宽崩溃时由 pi-tui 写（不是启动即建）；输入历史启动只读。
- 首次使用时：会话文件（第一条消息）、命令输出落盘、后台作业记录、检索缓存（`/search` 与检索工具）、学到的记忆（`update_memory`、`/memory edit`）、worker 工作树、个人设置（`/grants save`、`/revoke`）、迁移命令。

## 二、测试

- 新增 `src/persistence/global-ignore.test.ts`（8 条，全局配置、XDG 目录与家目录一律指到临时目录）：三行都缺时写进 XDG 位置并提示一行、之后 .pigeon 的程序状态被忽略、项目共享设置照常可提交、没有碰家目录；已有的行不重复、没有末尾换行先补换行、项目自己已忽略的不写（旧仓库的 .pigeon/.gitignore 只缺工作树一行）；非 git 不写；全局排除文件的四种取法；core.excludesFile 指向的文件写进去且 git 认得；写不进只提示不抛；同一进程同一目录只做一次、ensureProjectStateDir 与 ensureStateDirOf（用户级目录不动、不在 .pigeon/state 下的不动）；规则已在文件里却不生效时再调不重复写。
- `src/tui/main-reload.test.ts` 新增 2 条：git 仓库里打开终端界面的会话、不发消息就释放，前后都没有 .pigeon、全局排除文件不变；第一条消息建会话文件时才建 .pigeon/state/、三行进全局排除文件、不写 .pigeon/.gitignore、git status 不列 .pigeon。
- 改动的既有用例（只为反映新口径）：`settings.test.ts` 原"第一次建状态目录时写入 .pigeon/.gitignore 两行、缺行提示"改为"建 .pigeon/state/、不写 .gitignore、已有的原样不动"；`grants-config.test.ts` 原断言写下 .pigeon/.gitignore，改为断言不写；`migrate-config.test.ts` 两处原断言 .pigeon/.gitignore 的内容，改为断言不写、全局排除文件（临时位置，另核在临时目录里）里有对应规则。
- 测试总装：`scripts/vitest-git-env.mjs` 让所有测试进程的 GIT_CONFIG_GLOBAL 与 XDG_CONFIG_HOME 指到临时位置。本段开工前记下本机 `~/.config/git/ignore` 与 `~/.gitconfig` 的哈希，全部回归与真实运行之后核对一致。
- 变异核对（改回后对应用例变红，均已恢复）：启动时仍建状态目录、建会话文件时不准备状态目录与规则、不看是否已被忽略、已有的行重复写（原用例没测到，补了"规则已在文件里却不生效"一条后变红）、非 git 也写，共 5 处。
- 本机回归：src/persistence、state、memory、cli（64 个文件）、src/application（111 个文件）、src/tui、orchestration、pi-runtime（68 个文件）全部通过，唯 `checkpoints-async.test.ts` 的"保留修改时间的同长度覆盖"一条失败（基线即失败，S1 审计已记）。整仓 biome、tsc、依赖检查通过。

## 三、真实运行（打包产物，本机 Windows；GIT_CONFIG_GLOBAL 指向临时副本、XDG_CONFIG_HOME 指向临时目录）

- 临时 git 仓库里在隐藏窗口起终端界面，10 秒后结束进程：起来期间与结束之后仓库里都没有 `.pigeon`，临时 XDG 下没有 `git/ignore`。
- 命令行对话空输入退出：没有 `.pigeon`。
- `pigeon run "Reply with the single word ok."`（DeepSeek 连通，1 轮完成）：`.pigeon/` 下只有 `state/sessions`，没有 `.gitignore`；临时 XDG 的 `git/ignore` 为三行规则；`git status --porcelain --untracked-files=all` 为空。
- 本机真实的 `~/.config/git/ignore` 与 `~/.gitconfig` 在本段开工前记下的哈希与结束时一致（未被测试与真实运行改动）。

## 四、自定的细节

- 是否已被忽略按规则判断（`check-ignore --no-index`），不看文件是否已被跟踪。
- 每个进程对每个目录只做一次检查（不论 `.pigeon/state/` 是否已存在）：已有 `.pigeon/state/` 却没被忽略的旧仓库，第一次写程序状态时也会补规则；旧仓库靠 `.pigeon/.gitignore` 已忽略 `state/` 与 `settings.local.json` 的，只补 `**/.pigeon/worktrees/` 一行。
- `core.excludesFile` 只读全局层（`git config --global`），不看仓库自己的配置；设为相对路径时退到 XDG 位置（此时 git 不读 XDG 文件，规则不生效，但文件里已有的行不重复写）。
- 写成功时提示一行；终端界面里经存储告警口进消息区，`pigeon run` 写标准错误。
- 用户级 `~/.pigeon/state/` 下的写入（用户级记忆等）不触发全局规则（家目录不是项目）。
- 输入历史、检索缓存、学到的记忆这三处的首写准备不带提示口（写进全局文件成功或失败都不提示）；它们之外的首写入口（会话文件）带提示。

## 五、尚待确认

- 终端界面里第一次写程序状态时那一行提示的显示效果（未在真实终端界面里看）。
- 服务器全量验证：第二次 TB 比较跑完之后补做。
