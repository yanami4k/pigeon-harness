# 子 agent 与会话的统一改造 · ⑨：跨工作区的工作清单（基线 17df283）

457 剩下的最后一项：会话面板列一份跨工作区、跨重启的工作清单（用户级会话索引）。细化记为决策 485。

## 一、改动

| 文件 | 内容 |
| --- | --- |
| `src/persistence/session-index.ts` | 用户级清单 `~/.pigeon/state/session-index.json`：加入（已在的更新治理根与工作区，加入时刻不变）、删出、在不在、列出（会话文件按治理根与会话号现找，已不在的剔除、不为此改写文件）。原子写（`writeFileAtomic`），读改写在独占锁里（`acquireExclusiveLock`，锁被占着稍等重试）。文件畸形按空清单 |
| `src/tui/work-list.ts` | 面板的数据源：会话池里开着的，加上清单里本进程没开的（不是当前会话、不在会话池里）。本进程没开的卡片写 idle、摘要取会话记录最后一条回复、首条输入同 `/resume` 列表的取法；别的项目的标目录；会话锁在别的活进程手里的标 `open elsewhere`。发话先开起来再发；偷看取会话记录最近几句；停下不做事；去掉先删出清单再释放；取回回一句它没开着。打开面板时重读 |
| `src/application/session-holder.ts` | 只查不取的"会话文件是不是正被别的进程开着"（界面层按依赖规则不直接用会话锁模块） |
| `src/tui/main-pool.ts` | 会话核带所属项目的治理根与设置快照（别的项目的会话用它自己项目的）；子 agent 的类型、上限、打转检测、取回起点引用都按会话所属项目；面板里新派的会话开在当前会话所在的项目；派出的会话开好即进清单；清单里的会话释放时工作树留着；`/take` 别的仓库的会话拒绝 |
| `src/tui/main.ts` | 进清单：派出的、从主视图离开的（壳在主视图打开面板时告知）、退到面板的。打开清单里没开的会话（`openListed`）：别的进程开着即不开；别的项目先读它的设置（没确认过的条目在界面里确认），读不成或开不成写明原因不开；按它自己的治理根与工作区续接，收进会话池，再照 484 进入。`/reload` 与 `/config`：当前会话所在项目照原来的确认流程，别的项目各自重读（新的未确认条目在界面里确认，确认即记下），面板里那些项目的会话空闲时重建。`/memory`、`/worktrees`、`/fork`、`/resume`、子 agent 会话目录、设置面板都跟着当前会话所在的项目。退出时当前会话在清单里即工作树留着 |
| `src/tui/shell.ts` | 打开面板时：从主视图打开即告知装配方（当前会话进清单），重读清单。会话记录的根（历史、花费、续接列表、续接视图里改名）跟着当前会话所在的项目。`open elsewhere` 卡片进入整屏只读历史视图（标题行写名字与 `open elsewhere`、Esc 回面板，发话回一行，斜杠命令回主视图执行） |
| `src/tui/modal.ts`、`src/approvals/queue.ts`、`src/application/session-settings.ts` | 界面里确认别的项目的设置：放在审批的位置，列出与启动时确认同样的条目（同一句开头、同一个条目写法），`a` 信任、`s` 这次不用，答完收成一行结论；与审批走同一个排队，一次只问一件 |
| `src/application/session-pool.ts`、`src/tui/session-panel.ts` | 卡片加"本进程没开""别的进程开着""目录""所属项目"；名字后弱化标 `open elsewhere` 与目录；数据源可选 `refresh` |
| 测试 | `session-index.test.ts`、`work-list.test.ts`、`work-list-shell.test.ts` |
| 文档 | `docs/configuration.md` 会话面板一节（工作清单、派出位置、跨仓库取回、退出时的工作树）与斜杠命令一节；决策 485 与索引行；443、445、326、340、448、331 标部分已改 |

## 二、与启动时确认共用的代码、确认记在哪

- 打开别的工作区的会话读它的设置走 `openSessionSettings`（`src/application/session-settings.ts`），确认方式用它的 `interactive`，只是 `ask` 换成界面里的确认区（`askTrustPanel`）：要确认哪些条目（`pendingTrustEntries`：信任目录、指纹比对）、信任时记下（`recordTrustedEntries`）、这次不用时把条目从快照里去掉（`withoutTrustEntries`）都是启动时的同一套。界面里列的每一条用 `describeTrustEntry`，开头一句与启动时同一个常量（`TRUST_PROMPT_HEADER`）。
- `/reload` 重读别的项目时走 `planSettingsReload` 与 `applySettingsReload`（与当前项目的 `/reload` 同一套），确认同样用界面里的确认区，信任时 `recordTrustedEntries`。
- 确认记在用户级的 `~/.pigeon/state/config-trust.json`（按项目规范化路径与条目键记指纹），与启动时的确认同一处、效果相同：之后在那个项目里启动 Pigeon 不再问。

## 三、工程上的取舍

- 清单文件畸形按空清单（是程序状态，下次写入即重写），不像确认记录那样响亮失败：清单坏了不该挡住开面板。
- 本进程没开的卡片在打开面板时读一次（读会话记录取名字、首条输入与最后一条回复），之后不随会话记录变化刷新；重开面板即重读。
- 卡片上的目录只标在不属于当前会话所在项目的会话上（写它的工作区，`~` 缩写）。
- 别的项目的设置快照按项目缓存，同一项目的会话共用；`/reload` 重读别的项目时，确认即记下（不等那些会话重建完），重建在各自空闲时进行。
- 别的项目的会话用它自己项目的子 agent 类型；打转检测、子 agent 上限按它自己项目的设置。键位、设置面板、← 开面板与收尾钩子上限跟着当前会话所在项目的设置。
- 打开清单里的会话沿用当前会话的审批模式（同 469 的派出）。

## 四、已知限制

- 仍是进程内版：别的进程开着的会话只能看历史，不能在这里接着干。
- `main.ts` 里打开清单里的会话、重读别的项目的设置、退出时保留工作树这几段没有单元测试（入口不可单测）；拆出的数据源、索引与界面部分有测试。

## 五、检查

- 本机：`tsc --noEmit`、整仓 `biome check`、`dependency-cruiser`、`pigeon-paths-boundary`；`src/tui` 全部测试分三批、`session-pool`、`session-index`、`approvals` 跑过。
