<p align="center"><img src="docs/assets/pigeon.png" width="120" alt="Pigeon"></p>

# Pigeon

**轻量、注重成本，面向个人长期使用的终端 coding-agent harness。**

Pigeon 是个人开发、面向个人使用的项目。它复用 pi 的 agent 运行时，不需要独立后端、托管账号或额外的常驻服务；安装包约 3 MB，安装 tarball、配置自己的模型 key 就能工作，会话、记忆和设置都留在本机。

在模型成本上，Pigeon 用少量推送记忆保存稳定偏好，用按需检索代替反复回放整段历史，并按缓存重写代价裁剪旧工具结果，目标是尽量减少不必要的上下文与模型开销。功能重点包括模型自主分派子代理、Docker 沙箱、长任务运行控制，以及可检查的结果交付。

[快速上手](#快速上手) · [配置文档](docs/configuration.md) · [行为规格](docs/spec/README.md)

## 快速上手

环境要求：

- 支持 Windows、Linux、macOS
- Node.js `>=22.19.0 <25`
- 使用工作树与沙箱交付工作流时需要 `git`
- Docker 可选，只有沙箱会话需要

从 [GitHub Releases](https://github.com/yanami4k/pigeon-harness/releases) 下载 `pigeon-harness-0.0.1.tgz`，然后安装：

```sh
npm install -g pigeon-harness-0.0.1.tgz
cd your-project
pigeon
```


首次使用：

1. 输入 `/login`，选择服务商并粘贴 API key。
2. 输入 `/model`，选择型号。
3. 直接描述任务，例如：

> 修复刷新令牌时的竞态，补一条回归测试，不要改公开 API。

也可以在启动时指定服务商和型号：

```sh
pigeon --provider deepseek --model deepseek-v4-flash
```

## 模型自己决定怎样分派子任务

Pigeon 的子 agent 采用派生自己的方案。模型可以调用 `spawn_agent`，按当前任务决定派生方式：

- **上下文**：默认从空白对话开始，也可以继承派出方截至当前的对话。
- **执行方式**：默认后台执行，派出方继续工作；需要立即拿到结果时改为前台等待。
- **运行配置**：选择 agent 类型、名字和型号；子 agent 还能在深度与并发上限内继续派生。
- **工作区**：默认共用当前目录，需要隔离时使用临时 git 工作树。

后台子 agent 完成后，把最后一段回复全文作为消息交回。派出方可以用 `send_message` 补充指令，或让已经停下的子 agent 接着工作；所有传话都记入收件方会话。

agent 之间的消息带有明确的信任标记：**它来自另一个 agent，不是用户，也不携带用户授权。** 子 agent 继承派出方开始时的审批模式与放权，之后取得的放权只作用于它自己。

需要取回代码时，`take_changes` 把工作树中的改动按文件三方合并到调用方目录。冲突、删除和受保护路径分别列出，不会被静默盖掉；完整取回后起点前移，下一次只处理之后的新改动。

终端界面可以查看和接管子 agent，但分派本身由模型完成，不要求人先画任务图。

## Docker 沙箱：执行、状态与交付分开

Pigeon 的沙箱不是简单地给命令套一层 `docker run`，而是把一次工作分成三个阶段。

### 1. 把工作送进容器

默认把当前未提交的改动拍成快照，通过 git bundle 送进新容器；也可以用 `--sandbox-from-head` 只从最新提交开始。文件工具和命令经容器执行端运行，会话记录与程序状态仍留在宿主治理根。

容器使用非 root 用户，可断网，并限制内存、进程数与 CPU。所有项目和沙箱可以共享一个包管理器下载缓存卷；断网时仍能使用缓存里已有的包，但不缓存装好的依赖目录。

### 2. 在明确的资源与网络边界内执行

```sh
pigeon --sandbox
pigeon --sandbox --sandbox-network off
pigeon --sandbox --sandbox-approval prompt
```

沙箱默认联网并全部放行。处理不信任的仓库或敏感代码时，可以断网并改回逐条审批；沙箱联网时仍可能把代码或数据发送给外部服务，不能把“用了容器”等同于“不会外泄”。

### 3. 把结果作为本地分支交回

容器里的改动先提交，再通过 git bundle 取回宿主，成为 `pigeon/sandbox-<会话号>` 分支。当前分支、工作目录和未提交改动都不动，也不自动推送。

会话中可以用 `/deliver` 手动交回，结束时再自动交回一次。交回失败会保留容器，不让改动随容器删除而丢失。

无人值守任务使用同一个入口：

```sh
pigeon run "调查构建失败并修复" --sandbox --sandbox-network off --json
```

`pigeon run` 的最后一行 JSON 提供会话号、状态、用量与耗时等机器可读字段；退出码区分完成、取消、达到上限、打转和启动失败。

## 长任务的上下文与运行控制

### 上下文裁剪考虑缓存代价

Pigeon 不只按上下文长度做决定，裁剪分四个方面：

- **裁什么**：只替换较早的工具结果；用户消息、模型回复和会话文件里的原文不动，最近若干轮、被中断的调用以及没有成功落盘的截断输出受保护。
- **什么时候成批裁**：在压缩、模型或工具集变化、超过缓存保留时长等时机，可以一次清理全部候选结果。
- **什么时候需要算账**：其他请求只考虑过期读取与空结果，达到批量下限后，按下面的净收益选择起点：

```text
预期后续轮数 × 裁掉的 token ≥（缓存重写价 / 命中价 − 1）× 需要重写的 token
```

- **裁后怎样找回**：命令输出先落盘，占位文字说明原来的内容、裁剪原因和找回方式；每次裁剪先写会话记录，续接时按记录重放。这样不会为了缩短几百个 token 就破坏后面整段缓存。

### 打转、重复与截断

- **工具轮次打转**：比较整轮工具调用及其结果，也能识别两轮交替循环；先提醒模型换路，再继续警告，最后中止，而不是第一轮重复就误杀。
- **流式重复**：在正文和思考流出时检测重复周期与近似段落，命中后截断并交给续跑流程。
- **输出上限截断**：普通截断保留已写内容，从断点继续；因重复而截断的内容不继续沿用，避免接着复制。
- **请求无响应**：空闲 60 秒中止；尚未流出内容时自动重试一次，已有内容则保留并报错，调用方主动中止不重试。

这些机制记录进会话，可通过 `trace` 和 `replay` 检查实际发生过什么。

## 记忆：推送稳定事实&检索历史细节

Pigeon 不把所有历史都塞进上下文，而是分成“推送”和“检索”两条通道：经常要遵守的少量事实始终在场，体量更大的历史经历按需取回。

### 推送：让偏好与项目事实始终在场

- **记什么**：主要记录使用者的偏好、纠正，以及代码之外的项目信息；代码里已经能看到的事实不重复记录，代码现状以代码为准，`AGENTS.md` 等人写说明优先于学到的记忆。
- **存在哪**：项目级 `.pigeon/state/memory.md` 与用户级 `~/.pigeon/state/memory.md`，两层分开。
- **怎样推送**：会话开始时把两层记忆整份放进开工状态块；文件之后发生外部变化时，再以整节追加。
- **谁能写**：有人对话时，agent 可以用 `update_memory` 新增、改写或删除条目，用户也能用 `/memory` 查看和编辑；刚写入的内容从下一次会话开始推送。无人值守的 `pigeon run` 只推送已有记忆，不允许 agent 写入。

### 检索：需要时回查历史会话

- **怎么检索**：`search_sessions` 用 BM25 检索本项目的旧会话，默认同时覆盖对话与工具输出；旧工具输出会标明来源和“可能已过时”。
- **怎样返回**：按会话归并后只返回一两个命中片段，不用 LLM 再写摘要；命中只是线索，结论再用 `read_session_entry` 按条目号回查原文，`list_sessions` 则按时间或改动文件浏览会话。
- **搜哪些范围**：默认排除当前会话所属的会话树；显式使用 `scope: "current"` 时，只搜当前会话最近一次压缩点之前的内容。
- **怎样避免重复扫描**：可搜文本与词频表按会话文件缓存，不必每次重扫全部历史。

推送解决“以后都要记得”，检索解决“这次需要查证”；压缩归档则补足当前会话里刚被摘要替换的原文，三者不是同一套机制的重复包装。

## 会话记录与检查

每个会话保存为一份 JSONL，交互会话和 `pigeon run` 使用同一种记录。

- `/resume` 续接，`/fork` 从较早节点另开路径，`/rewind` 分别或同时回退代码与对话。
- 自动压缩把本次被替换的条目保存为归档，并在摘要中留下可读的 `pigeon://` 路径。
- `pigeon trace` 汇总运行、工具、审批、重试与配置；`pigeon replay` 逐条查看记录，不重新执行工具。

```sh
pigeon session list
pigeon trace <会话号> --with-content
pigeon replay <运行号> --with-content
```

这些离线检查不需要模型凭据。

## 模型接入与扩展

Pigeon 随包提供 Anthropic、OpenAI、OpenAI 兼容和 Google 四类线路。`/login` 使用只允许当前账户读取的凭据文件，环境变量优先；`pigeon run` 只认环境变量。`/model` 切换型号，`/effort` 只提供当前型号支持的推理档位。

自定义服务商写在用户层配置中，代理认标准环境变量；高级接入可使用 `--stream-fn`。项目说明读取 `AGENTS.md`，另有按需加载的 Skills、命令 Hooks 和 MCP。详细配置见[配置文档](docs/configuration.md)。

## 配置

Pigeon 的配置按三层合并，后一层覆盖前一层：

| 层级 | 文件 | 用途 |
|---|---|---|
| 用户级 | `~/.pigeon/settings.json` | 个人常用设置，跨项目生效 |
| 项目共享 | `.pigeon/settings.json` | 随项目共享，可提交 |
| 项目个人 | `.pigeon/settings.local.json` | 只用于当前机器上的这个项目，不提交 |

优先级为“项目个人 > 项目共享 > 用户级”。手动修改文件后执行 `/reload` 生效。

终端界面里的 `/config` 可以修改常用开关、枚举、数字、短字符串和键位；保存后写入用户级配置并当场生效。设置按 `model`、`web`、`context`、`tools`、`guards & hooks`、`workspace`、`interface` 等组展示，当前值、缺省值和被其他层覆盖的情况都能直接看到。

配置按节组织，例如 `model` / `modelInfo` 管模型与元数据，`sandbox` 管镜像和资源上限，`memory` 管两层记忆上限，`sessionSearch` 管历史检索，`agents` 管子代理并发与深度，`web` / `mcp` / `hooks` 管外部能力。完整键表见[配置文档](docs/configuration.md)。

### 常用配置

这里展示用户常用配置；结构复杂的 MCP、Hooks、权限规则、自定义服务商和 `modelInfo` 请直接查[配置文档](docs/configuration.md)。

| 配置键 | 缺省值 | 作用 |
|---|---:|---|
| `thinking.level` | 按模型 | 推理档位；写 `off` 关闭思考 |
| `modelRequest.maxRetries` | `4` | 连接失败、408、429 与 5xx 的重试次数，`0` 为不重试 |
| `agents.maxConcurrent` | `20` | 一个会话连同下层子代理同时在跑的上限 |
| `agents.maxDepth` | `3` | 子代理最多向下的层数 |
| `agents.runWaitMinutes` | `10` | `pigeon run` 干等子代理的上限，`0` 为不限 |
| `memory.projectLimitChars` | `4000` | 项目级学到的记忆上限，按字符计 |
| `memory.userLimitChars` | `4000` | 用户级学到的记忆上限，按字符计 |
| `sessionSearch.enabled` | `true` | 是否注册历史会话检索工具 |
| `sandbox.memory` | Docker 主机内存的一半 | 容器内存上限，可写 `4g`、`512m` 或 `0` |
| `sandbox.pids` | `4096` | 容器进程数上限，`0` 为不限 |
| `sandbox.cpus` | `0` | 容器 CPU 上限，`0` 为不限 |
| `worktree.baseRef` | `"fresh"` | 新工作树从远端默认分支或当前 HEAD 开始 |
| `web.enabled` | `true` | 是否提供联网工具 |
| `web.search.maxResults` | `5` | 每次联网搜索的缺省结果数 |
| `loopGuard.enabled` | `true` | 工具轮次打转检测总开关 |
| `loopGuard.remindAt` / `warnAt` / `stopAt` | `5 / 10 / 20` | 第几轮提醒、再次警告与中止 |
| `truncationContinuation.maxConsecutive` / `maxPerRun` | `2 / 5` | 连续与单次运行内最多续写次数 |
| `repetitionGuard.enabled` / `mode` | `true / "abort"` | 流式重复检测；也可改为只记录 |
| `tools.grep.maxResults` | `200` | 单次 grep 最多返回的匹配数 |
| `tools.glob.maxResults` | `100` | 单次 glob 最多返回的文件数 |

这些键都可以在 `/config` 中修改；表中没有列出的嵌套配置或自由文本字段，直接编辑对应层的 `settings.json`。

### `contextPrune`：上下文裁剪

裁剪默认开启，通常不需要配置。价格比与缓存保留时长优先按当前模型的价格信息和缓存规则推断；确定不了价格比时按 `50` 从严处理。所有参数都放在 `contextPrune` 一节，例如把最近 8 轮设为保护区：

```json
{
  "contextPrune": {
    "protectTurns": 8
  }
}
```

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `enabled` | `true` | 总开关；关闭后不再新裁，已有记录仍重放 |
| `protectTurns` | `5` | 最近多少轮的工具结果不裁 |
| `horizonTurns` | `20` | 公式中的 N，即预期后续轮数的保守下限；越大越容易通过净收益判断 |
| `minBatchTokens` | `10000` | 其他请求中一次至少裁掉的 token 数；调大更保守 |
| `minResultTokens` | `500` | 免费时机里“较大旧结果”的候选下限 |
| `priceRatio` | 按模型信息 | 直接覆盖“缓存重写价 / 命中价”，一般不用手填 |
| `writeMultiplier` | 按模型信息 | 用未命中价推算重写价时使用的写缓存倍率；`priceRatio` 的直接覆盖优先 |
| `retentionSeconds` | 按缓存规则 | 空闲多少秒后按免费时机裁剪 |
| `onCompaction` / `onIdle` / `staleReads` | 均为 `true` | 分别控制压缩前裁剪、空闲裁剪和过时读取候选 |
| `maxImageBytes` | `8388608` | 上下文中未裁图片的 base64 总量上限，即 8 MiB |

只有在已经确认当前模型真实价格时，才需要显式覆盖价格比和缓存保留时长：

```json
{
  "contextPrune": {
    "priceRatio": 10,
    "retentionSeconds": 300
  }
}
```

## 审批与配置边界

- `ask` 对需要批准的动作逐条询问，`bypass` 不再询问；`Shift+Tab` 只改变当前会话。
- `bypass` 和 `--yolo` 让命令以当前账户权限执行，只应用于可信任务或适当的隔离环境。
- 服务商地址与自定义服务商声明只认用户层配置，不从克隆来的项目设置中读取。
- 会执行命令或授予权限的配置，在使用前须经过内容确认。

## Pigeon 与 pi 的关系

Pigeon 复用 `@earendil-works/pi-agent-core`、`pi-ai` 和 `pi-tui` 提供的 agent 运行时、模型接入与终端基础部件，三者都钉在 **0.84.4**（精确版本，不带范围），不声称自研 agent 运行时。

本项目的工作集中在终端 harness 与应用层：模型驱动的子代理分派、执行与审批边界、Docker 沙箱交付、上下文与运行控制，以及围绕这些过程形成的会话记录和终端工作流。

## 已知限制

- 0.0.1 不支持 Bedrock，也不支持订阅账号登录。
- 沙箱会话不提供会话面板、子 agent、MCP、`/login`、`/logout`、`/model`、`/resume`、`/new`、`/clear`、`/fork`、`/take`、`/worktrees`、`/panel`、`enter_worktree` 与文件检查点。
- 在非 git 目录中，面板派出的会话共用项目目录，不会获得相互隔离的工作树。
- 工作树与沙箱交回不应用 `.gitattributes` 过滤器。使用 LFS 或加密过滤器的仓库，合并或推送交回分支前请先阅读[配置文档](docs/configuration.md)中的交回说明。

## 文档

- [配置文档](docs/configuration.md)：设置、自定义服务商、代理、沙箱、钩子、记忆与安全细节
- [行为规格](docs/spec/README.md)：带测试引用的编号行为规则
- [CLI 规格](docs/spec/cli.md)：命令行参数、JSON 输出与退出码
- [测试说明](docs/testing.md)：测试分档与验证命令

## 许可

[MIT](LICENSE)
