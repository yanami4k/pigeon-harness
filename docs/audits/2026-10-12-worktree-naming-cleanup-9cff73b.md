# 工作树：分支名带会话号、清理、.worktreeinclude（决策 447、448、449）审计

基线 9cff73b。提交：f018069（代码与测试）、d7d16e2（文档）、本审计。

## 一、改了什么

### 447 分支名带会话号

- `src/orchestration/worktree.ts`：`worktreeBranchFor(sessionId, name)` 给出 `pigeon/<会话号后 8 位，小写>-<名字>`（新增 `branchTailFor`）。会话号取的是 worker 自己的会话号（工作树目录名 `<会话号>-<名字>` 用的同一个），后 8 位是 ULID 的随机部分。
- 起点快照的引用随分支同名：`workerStartRefFor(tail)` 收分支名去掉 `pigeon/` 的部分；`application/workers.ts` 的起点提供者按 `branchTailFor(sessionId, name)` 取引用，并行派出的同名 worker 不再共用一个临时引用。
- `deleteBranch` 接受新旧两种分支（`pigeon/<会话号后 8 位>-<名字>` 与旧的 `pigeon/<名字>`），连同对应起点引用删除。
- `addWorktree` 新增可选 `branch`（显式分支名，按白名单校验）：`/fork` 显式给 `pigeon/fork-<会话号后 8 位>`，与原来一致。
- `spawn_worker` 派出本身失败时（还没有分支）不再在失败文字里写一个推算的分支名：`SPAWN_WORKER_TEXTS.failed` 的 `branch` 改为可选，派出失败的三处不给。
- `take_worker` 的参数说明改为 "its branch is pigeon/<session suffix>-<name>"。

### 448 清理

- 编排器（`src/orchestration/workers.ts`）：
  - 工作区提供者加可选的 `pristine`（工作树在、没有未提交改动与未跟踪文件、HEAD 仍是起点提交）与 `remove`（`removeWorktreeAndBranch`）。git 工作树提供者实现两者。
  - 收尾时没有改动即删工作树与分支：结果里 `changedFiles` 与过大文件清单都空、且核对 `pristine` 为真。等审批停下的（可补批续做）与脚本编排派出的不在这里删。删掉的在结果与状态里标 `worktreeRemoved: "unchanged"`。
  - 新增 `discardWorkspace(sessionId, "taken" | "unchanged")`：取回之后删（taken），或核对确无改动再删（unchanged，脚本整次收尾用）。在跑的、没有工作树的不动；之前运行找回的 worker 同样可删。删除失败进内部故障清单、返回 false。
  - 续做（`resume`）：因无改动删掉的按起点重建同一路径与分支；因完整取回删掉的拒绝续做并说明。
- 取回（`take-worker-tool.ts`，工具与 `/take` 共用）：完整取回（无冲突、无因过大留下的文件、叠加没有出错）后调 `discardWorkspace(…, "taken")`，返回文字末尾补一句；工作树已不在时按原因说明（本进程删的写明原因，原因不明的列出可能）。工具说明末尾补一句完整取回后删除。
- 脚本编排（`script-runner.ts`）：整次运行正常结束且收回做完之后，完整收回的按 taken 删，其余调用按 unchanged 核对后删（有改动的留着）。收回被拒、没有可收回的、运行没有正常结束时不清理（可能续跑或重新收回）。
- 完成通知与 `/workers`：没有改动而删掉的，不再提示取用，改为说明工作树与分支已删。
- 列出与删除（新文件 `src/application/worktree-cleanup.ts`）：
  - 列出 `.pigeon/state/worktrees/` 下 git 登记的工作树、没有工作树的 `pigeon/` 分支、该目录下 git 不认的残留目录。每项：所属会话（读 worker 会话文件头的派出方会话号）、在用（worker 会话的锁被仍在的进程持有）、未取走的改动、占用大小、旧命名标记。
  - 未取走的改动：起点取分支引用日志里最早的一条（`-b` 建分支时那条即起点；没有引用日志时退回工作树当前 HEAD），`git diff --name-only <起点>` 加未跟踪未忽略的文件，再逐个与主工作目录的同名文件比内容，不同的才算。只剩分支的看分支 tip 是否已不同于起点（"分支上有新提交"）。
  - 删除：不带参数只挑没有未取走改动且不在用的；`--all` 挑全部不在用的；编号或名字点名。在用的一律不删。工作树连分支删，只剩分支的删分支并 prune 登记，残留目录直接删。
  - 终端界面 `/worktrees`（命令表新增，运行中可用，沙箱与非 git 工作区不提供）：`/worktrees` 列出；`/worktrees clean [编号…] [--all]` 列出将删的各项（有未取走改动的写"删除后丢失"）并要求 `/worktrees confirm`；确认时再核一遍在用。
  - 命令行 `pigeon worktrees list|clean [编号或名字…] [--all] [--yes]`：在终端里问一次 `[y/N]`；没有终端且没带 `--yes` 时只列出不删。
- `src/persistence/session-lock.ts` 新增 `sessionFileHolder`（只读判断会话文件的锁是否被仍在的进程持有）。
- `src/orchestration/worktree.ts` 新增 `removeWorktreeAndBranch`、`pruneWorktrees`、`listBranches`、`branchCreationCommit`、`filesChangedSince`、`branchMovedSince`、`worktreePristine`。

### 449 .worktreeinclude

- `addWorktree` 建好工作树后调 `copyWorktreeIncludes(来源, 工作树)`：来源缺省为仓库根（可经 `includeSource` 指定）。`git ls-files --others --ignored --exclude-from=.worktreeinclude` 列出匹配规则的未跟踪文件，再经 `git check-ignore --stdin` 留下真被忽略的；`.pigeon` 下的不复制；只复制普通文件、目标已存在不覆盖。没有 `.worktreeinclude` 即不做。worker、脚本编排、`/fork` 都经 `addWorktree`，一并生效。

### 文档

- `docs/configuration.md`"worker 与续接"一节：分支命名、自动删除的两种情况与保留的情况、脚本编排的清理时机、`/worktrees` 与 `pigeon worktrees` 的列出与删除、`.worktreeinclude`。

## 二、测试

- 新增 `src/orchestration/workers-worktree-removal.test.ts`（8 条，真实 git 仓库 + 真实工作树提供者）：两个会话先后派同名 worker 都派得出、分支各带会话号（已复现缺陷的回归用例）；收尾无改动即删、状态与结果标明、续做按起点重建且再无改动再删；续做中途写了文件的重建工作树保留；有未提交改动的、有新提交的保留；等审批停下的保留；脚本派出的收尾不删、discardWorkspace(unchanged) 只删无改动的；取回后 discardWorkspace(taken) 删且之后拒绝续做；在跑的不删。
- 新增 `src/application/worktree-cleanup.test.ts`（5 条）：列出三类条目与各项事实；挑选规则；终端界面的二次确认与作罢；命令行无终端不删、确认被拒不删、--yes 删；非 git 不提供。
- `src/orchestration/worktree.test.ts` 改写并新增：新命名、两个会话同名都建得起来（显式给同名分支仍由 git 拒绝）、显式分支名校验、新旧两种起点引用随分支删除、`removeWorktreeAndBranch`（目录在、目录被手删、分支已不在、非 pigeon/ 分支）、`worktreePristine`、`.worktreeinclude` 两条（匹配且被忽略才复制，已跟踪/只匹配/只忽略/.pigeon 下的不复制、不覆盖；没有文件不复制、指定来源目录）。
- `take-worker-tool.test.ts` 新增 2 条：完整取回后请编排器删、有冲突不删、删不成不补那句、已知原因的工作树已删照实说明；真实编排器上完整取回后工作树与分支都不在、再取说明已取回。
- `script-runner.test.ts`：接力与收回一条补断言（完整收回的 3 个删、有冲突的 1 个留）；新增 1 条（没列进收回清单的无改动 worker 删、有改动没收回的留、收回的删）。
- `spawn-worker-tool.test.ts` 新增 1 条：无改动删掉的 worker，完成通知与 wait_workers 结果末行说明已删、不提示取用。
- 改动的既有用例（只为反映新口径）：
  - `worktree.test.ts` 原"同名分支由 git 响亮拒绝"一条改为两个会话同名都建得起来（决策 447 正是要改掉这一行为）；分支名与起点引用断言改新格式。
  - `take-worker-tool.test.ts`：工具说明末尾多一句、参数说明改分支格式、工作树已删的文字改为列出可能原因；gc 一条的分支名改按新格式取。
  - `spawn-worker-headless.test.ts`：比对模型看到的文字前去掉分支名里随会话变的 8 位（格式另有专门用例）；"总数上限"一条的 worker 没有改动，完成通知末行由起点一行改为已删一行，并补断言分支已删；"治理根与工作区根分开"一条原断言治理根下留着 1 个 `-fix` 工作树，改为工作树建在治理根下（派出记录的路径）且完整取回后 0 个、分支已删。
  - `workers-e2e.test.ts`：分支名断言改新格式。
  - `tui/input-queue.test.ts`：运行中可用的命令清单加 `worktrees`。
- 变异核对（改回后对应用例变红，均已用 git 恢复）：分支名不带会话号、.worktreeinclude 不核对是否被忽略、pristine 不看新提交、等审批停下的也删、以无改动为由删时不核对、有冲突也删、脚本收回一律按 taken、缺省清理连有改动的一起挑，共 8 处。
- 本机：上述新文件与受影响的 38 个既有测试文件（worker、编排、脚本、取回、分叉、迁移、命令表、终端界面编排等）通过，唯 `checkpoints-async.test.ts` 的"保留修改时间的同长度覆盖"一条失败；该条在基线 9cff73b 上同样失败（已在本工作树 stash 改动后单独复核），与本段无关。tsc 无错误，biome 通过。

## 三、真实运行（打包产物，本机 Windows，DeepSeek）

- 临时仓库（`.gitignore` 与 `.worktreeinclude` 都写 `.env`，`.env` 未跟踪）里 `pigeon run` 让模型派一个 implementer 读 `.env` 并原样报出、不改文件：worker 报出了 `.env` 的内容（复制生效）；收尾后 `.pigeon/state/worktrees/` 为空、`git branch` 里没有 `pigeon/<8 位>-env-reader`，分支在派出结果里为 `pigeon/11xnpkt0-env-reader`。这一次的 wait_workers 结果末行仍是起点一行（打包早于补上 wait_workers 那一句的改动；之后已补，单元测试覆盖）。
- 同一仓库手工造一个 `pigeon/<8 位>-kept` 工作树（有改动）与旧分支 `pigeon/legacy-x`：`pigeon worktrees list` 列出两项（有改动的写"未取走的改动 1 个文件"、旧分支标"旧命名""工作树已不在"）；`clean` 无终端时只列出不删；`clean --yes` 只删旧分支；`clean --all --yes` 写明"删除后丢失"并删掉，之后 `git branch`、`git worktree list` 只剩 main。

## 四、自定的细节

- 分支名里的会话号后 8 位取小写（ULID 为大写的 Crockford Base32，小写化一一对应），与 worker 名的小写风格一致；工作树目录名仍用原样的会话号。
- `/fork` 的分支名保持 `pigeon/fork-<会话号后 8 位>`（名字里已有会话号），不套新规则以免出现两段会话号。
- "收尾时没有改动"按工作树核对：没有未提交改动、没有未跟踪文件、HEAD 仍是起点提交（worker 自己提交过也算有改动）。失败、取消、撞上限的 worker 只要没有改动同样删（没有可丢的东西）；等审批停下的不删，因为补批续做要回到原工作树。
- 续做因无改动删掉的 worker：按原起点重建同一路径与分支，不拒绝（没有改动，重建与原样一致）。
- 脚本编排的 worker 收尾时不删，整次收回之后再清理（接力的下游从上游的工作树拍起点，收回要读各 worker 的工作树，续跑复用要求工作树还在）。
- 列出的范围：只列 `.pigeon/state/worktrees/` 下的工作树与 `pigeon/` 前缀的分支；`--worktree` 的独立工作树（S3）另行处理。
- 删除命令缺省只删没有未取走改动的；有改动的须点名或 `--all`。终端界面用 `/worktrees confirm` 作二次确认（照 `/reload confirm` 的做法），命令行没有终端时须 `--yes`。
- "在用"按 worker 会话文件的锁判断（锁被仍在的进程持有，含本进程）。只读判断，不取锁。
- 删除失败（如 Windows 上文件被占用）只记内部故障，不影响收尾、取回的结果与文字。

- 只剩分支的条目判断旧命名：分支名去掉 `pigeon/` 之后不是"8 位小写字母数字加连字符"开头的算旧命名；恰好 8 个字母的旧名字（如 `reviewer-1`）会被误标为新命名，只影响"（旧命名）"标注，不影响删除。

## 五、尚待确认

- 终端界面里 `/worktrees`、`/worktrees clean`、`/worktrees confirm` 的人工走查（单元测试覆盖了命令面，未在真实终端界面里按键走过）。
- Windows 上工作树里有被占用的文件时自动删除失败的表现（只记内部故障、工作树留着；未实测）。
- 服务器全量验证：第二次 TB 比较跑完之后补做。
