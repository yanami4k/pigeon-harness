# 测试规矩

写测试、改测试按这份来（决策 370）。框架是 Vitest（决策 369），怎么写见下一节。

## 测试原则

1. 测行为和契约：输入、输出、能观察到的副作用——落盘的东西、发出去的请求、退出码、屏幕上那几行关键输出。不测实现细节，也不为覆盖率去碰私有结构。
   文案只测关键片段：某个参数名在、某条约束在、某个数值算对了。不整段逐字比对。期望值能由产品常量或模板函数算出来的，就用那个，别在测试里再抄一遍原文。
   已经定稿的原文（产品代码里标了"定稿原文"的那几段）每段最多留一处逐字检查，放在该工具自己的单元测试里；别处只测片段。
2. 一个行为只在一层测。逻辑在单元层；装配层（装配根、运行面）一条冒烟，能证明接上了就够；端到端只走关键路径。下层已经断言过的，上层不要重复。
3. 变异验证只做四处：安全、数据完整、计费、隔离。把判定删掉，看对应用例是不是就该失败；确认后还原，并核对文件与原来逐字相同。别的判定不这么测，太费时间。
4. 测试的行数不超过它测的产品代码行数。超了先看有没有重复的层，或者同一个情形被测了好几遍。
5. 真容器用例只测容器才有的事：挂载、权限、网络隔离、超时杀进程、镜像里的工具链。跟容器无关的逻辑，用替身执行端在单元层测。没有 Docker 或镜像就跳过，并把原因写出来。
6. 单个测试文件跑过 10 秒要说明理由，并挪进慢档。先设法减重：共用夹具、缩小规模、把逻辑挪到单元层。减不下来再加进 `scripts/test-tiers.mjs`，在清单里写理由。怎么量见最后一节。

还有几条：

- 删掉的功能不留"它已经不存在了"的测试。读旧数据的兼容是现行行为（旧会话、旧结果行要能照常读出来），照常测。
- 等异步条件用轮询加上限，比如 `until`。上限只决定真失败时多久报出来，取宽一点（十几秒），别拿它去卡时序。
- 测试失败不能把进程挂住：子进程、定时器、终端、连接都在 `finally`、`onTestFinished` 或 `afterAll` 里收掉。

## 写法（Vitest）

- 引入按需写，例如 `import { afterAll, beforeAll, describe, it, test, vi } from "vitest"`。断言用 `node:assert/strict` 或 Vitest 的 `expect` 都行，同一个文件里统一用一种。迁移之前的测试一律是 `node:assert/strict`，迁移时没改写。
- 按平台或环境跳过，用 `test.skipIf(条件)(名称, fn)`，`describe.skipIf` 同理。条件写成"原因字符串或 false"，例如 `process.platform === "win32" ? "Windows 上没有 /bin/sh" : false`，这样原因留在代码里。运行中才知道要跳过的，在测试里调 `t.skip("原因")`：它会立即中止这个测试，原因出现在报告里。
- 运行中补一句说明，比如某一种后端本机没有、这一项没测到：`await t.annotate("…")`。
- 打桩用 `vi.spyOn(对象, "方法").mockImplementation(…)`，用完 `mockRestore()`。
- 组内并发用 `describe.concurrent(名称, fn)`，同时跑的上限见 `vitest.config.ts` 的 `maxConcurrency`。
- 超时：配置里单个测试和钩子的上限都是 10 分钟（node:test 原本不限时）。要更紧的，在测试上给 `{ timeout }`。
- 编译方式这条容易踩：Vitest 经 Vite 转译测试文件与被测代码，产品运行时由 Node 原生剥类型，两者处理语法的方式不一样（Vite 能转译 Node 剥类型不支持的写法）。类型与语法以 `npm run check`（tsc，`erasableSyntaxOnly`）为准。测试通过不等于产品能在 Node 下原样跑起来。
- 隔离：每个 worker 是独立子进程（forks 池），同一个 worker 里先后跑的测试文件之间不隔离，共用模块缓存和进程状态（比每个文件隔离快约三成；不做第三方依赖预打包，原因见 `vitest.config.ts` 的注释）。所以新写的测试别依赖进程级全局状态——环境变量、当前目录、模块级单例、全局打桩都不行；要用就在测试里改，在 `finally` 或 `afterAll` 里还原。怀疑某个失败是串扰（单独跑能过、一起跑才挂），设 `PIGEON_TEST_ISOLATE=1 npm run test:slow` 切回每个文件隔离复查，或者加 `--sequence.shuffle.files` 打乱文件顺序看能不能复现。

## 快档与慢档

测试分两档，划分写在 `scripts/test-tiers.mjs` 的清单里。用清单不用命名约定，是因为每一项旁边写得下理由，文件也不用改名；清单里某一项匹配不到文件时，跑测试的脚本会直接报错，清单不会悄悄失效。

- 慢档：清单里列出的、单独跑超过 10 秒的测试文件（测的是 `src/execution`、`src/cli` 这些地方的代码）。跑批器已经移出仓库，慢档里不再有它的测试。
- 快档：其余全部。

| 命令 | 跑什么 |
|---|---|
| `npm run test` | 快档 |
| `npm run test:slow` | 慢档 |
| `npm run verify` | lint + check + 快档 + deps（开发中快速检查用） |
| `npm run verify:full` | lint + check + 规格引用覆盖率检查（`--require`） + 第三方许可汇总校验 + 锁文件源检查 + 快档与慢档 + deps（交付与合并前必跑） |

规格引用覆盖率的门禁在 `scripts/spec-refs.mjs --require`：按区比对 `scripts/spec-coverage-baseline.json`，未引用的规则比基线多一条就失败。新增规则要带一条测试引用——标题里写规则号，或者测试上一行写 `// spec: AREA-NNN`；确实没法用测试覆盖的，写进 `scripts/spec-coverage-exempt.json` 并说明理由。补完引用运行 `node scripts/spec-refs.mjs --update-baseline` 重写基线。

老规则按"触碰即补"办：改动落到哪个区，就把这次涉及的规则补上测试引用（没有对应测试的补一条），同时把该区基线调低；不单独立项整批补齐（决策 576）。

依赖变动后先跑 `node scripts/third-party-licenses.mjs --write` 重新生成汇总，再跑 `verify:full`。

交付与合并前必须跑 `npm run verify:full`，不管改了哪个目录——慢档里的文件也会跑到其他目录的代码。`npm run verify` 只用于开发中的快速检查，顶不上交付前那一遍。

CI（`.github/workflows/ci.yml`）在推送 main 和每个 PR 时跑 `npm run verify:full`。本地合并后直推 main 的话，CI 是在推送之后才跑，所以合并前那一次全量验证得交付者自己跑。

测试步的并发数（Vitest 的 worker 数）用环境变量 `TEST_CONCURRENCY` 给，例如 `TEST_CONCURRENCY=6 npm run verify:full`。

只跑某几个测试文件：`npm run test -- <文件或 glob…>`。给了文件就只跑这些，不分档，例如 `npm run test -- src/tui/status-bar.test.ts`。其余以 `-` 开头的参数原样交给 `vitest run`，例如按名称筛选用 `npm run test -- -t 审批`。

真容器用例要有装好 Docker 和所需镜像的机器，没有就照常跳过。

## 覆盖率与基准

- `npm run coverage`：两档全部测试带 v8 覆盖率跑一遍，报告写到 `coverage/`（不入库）。不进 verify。
- `npm run bench`：跑 `src/**/*.bench.ts` 的基准，守住这一轮的性能改动不退回。不进 verify，单独跑；比前后数字要在同一台机器上、负载相近时跑。

## 量具

- `node scripts/test-timing.mjs [--concurrency N] [--out 结果.json] [文件或 glob…]`：跑一次 Vitest（JSON 报告），记每个测试文件的墙钟、测试项数和每个测试的耗时，打印最慢的文件。要判断某个文件是否超过 10 秒，在有 Docker 的机器上用 `--concurrency 1` 单独量。
- `node scripts/test-coverage.mjs [--concurrency N] [--module 路径前缀…] [文件或 glob…]`：逐文件跑 Vitest 的 v8 覆盖率，算出每个文件独有覆盖的产品代码行，以及指定模块的行覆盖率。独有行为为 0 只是"删了也不影响覆盖"的候选——同样的行可能在断言不同的行为，删或合并之前要逐条确认它测的行为别处已经测过。
