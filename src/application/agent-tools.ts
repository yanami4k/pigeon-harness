// 子 agent 与通讯录的四件工具（决策 457、480）：spawn_agent 派一个子 agent（缺省后台；可选前台、带上下文、临时工作树、
// 类型、名字、模型），send_message 按名字给本进程里的会话或子 agent 发消息（续聊子 agent 也用它），list_agents 列出
// 通讯录，stop_agent 停下自己派出的子 agent。工具背后是 AgentToolsHost（subagents.ts），绑着调用它的会话或子 agent。
// 层数到了上限的子 agent 不注册 spawn_agent；四件都免审批（权限继承派出方，子 agent 自己的工具调用照常审批）。
// 决策 486：take_changes 把自己派出的子 agent（会话的主 agent 另可取面板里同一仓库的会话）的改动取回自己的工作目录——
// 会写调用方的工作目录，按写档审批；只读的类型（explore）不注册（只读范围只留读档与联网档的工具）。
import { type TSchema, Type } from "typebox";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import type { AgentTypeCatalog } from "./agent-types.ts";
import type { AgentListing, AgentToolsHost } from "./subagents.ts";

export const SPAWN_AGENT_TOOL = "spawn_agent";
export const SEND_MESSAGE_TOOL = "send_message";
export const LIST_AGENTS_TOOL = "list_agents";
export const STOP_AGENT_TOOL = "stop_agent";
export const TAKE_CHANGES_TOOL = "take_changes";

export const AGENT_TOOL_NAMES: readonly string[] = [
  SPAWN_AGENT_TOOL,
  SEND_MESSAGE_TOOL,
  LIST_AGENTS_TOOL,
  STOP_AGENT_TOOL,
  TAKE_CHANGES_TOOL,
];

// spawn_agent 的说明：可用的类型逐个列出（说明供模型判断何时派）
export function spawnAgentDescription(catalog: AgentTypeCatalog): string {
  const types = catalog.types.map((type) => `- ${type.name}: ${type.description}`).join("\n");
  return [
    "Start a sub-agent: a separate agent with its own context that works on a task and reports back. " +
      "By default it starts with a blank context, so the task must say everything it needs to know; set inherit_context to start it with a copy of this conversation instead. " +
      "By default it runs in the background: you keep working, and its final reply arrives later as a message (don't wait or poll for it). " +
      "Set background to false when you need the result before you can go on; the call then returns the reply. " +
      "Set worktree to true to have it work in a temporary git worktree (git repositories only); a worktree with changes is kept and reported back, one without changes is removed. " +
      "Use send_message with its name to give it more instructions or continue it after it finishes, and stop_agent to stop it.",
    "",
    "Agent types:",
    types,
  ].join("\n");
}

export const SEND_MESSAGE_DESCRIPTION =
  "Send a message to another agent in this process by name: a sub-agent you started (to give it more instructions, or to continue it after it finished), the agent that started you, or another session's agent. " +
  "A running agent gets the message when its current turn ends; a sub-agent that has stopped starts working again. Replies come back as messages.";

export const LIST_AGENTS_DESCRIPTION =
  "List the agents in this process: sessions and sub-agents, with each sub-agent's type, state and the agent that started it.";

export const STOP_AGENT_DESCRIPTION =
  "Stop a running sub-agent you started (its own sub-agents stop too). It can be continued later with send_message.";

export const TAKE_CHANGES_DESCRIPTION =
  "Bring the changes a sub-agent you started made in its worktree into your own working directory: everything changed since it started (committed or not, new files included) is merged file by file. " +
  "Files that can't be merged cleanly are left in its worktree and listed; files it deleted are listed, not deleted here. " +
  "Call it after the sub-agent has finished; calling it again later takes only what changed since. " +
  "A session's main agent can also take a session from the session panel in the same repository by its name.";

export const TakeChangesParamsSchema = Type.Object({
  name: Type.String({
    description: "The name of the sub-agent (or panel session) to take changes from",
  }),
});

export const SpawnAgentParamsSchema = Type.Object({
  task: Type.String({
    description:
      "What the sub-agent should do. With a blank context this is all it knows, so include the needed background.",
  }),
  type: Type.Optional(Type.String({ description: "Agent type; default general" })),
  name: Type.Optional(
    Type.String({
      description:
        "A short name to address it by (letters, digits, - and _); default: type plus a number, like explore-1",
    })
  ),
  model: Type.Optional(
    Type.String({ description: "Model id for the sub-agent; default: its type's model, or yours" })
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Run in the background (default true); false waits for its reply" })
  ),
  inherit_context: Type.Optional(
    Type.Boolean({
      description:
        "Start with a copy of this conversation instead of a blank context (default false)",
    })
  ),
  worktree: Type.Optional(
    Type.Boolean({ description: "Work in a temporary git worktree (default false)" })
  ),
});

export const SendMessageParamsSchema = Type.Object({
  to: Type.String({ description: "The name of the agent to send to" }),
  message: Type.String({ description: "The message" }),
});

export const ListAgentsParamsSchema = Type.Object({});

export const StopAgentParamsSchema = Type.Object({
  name: Type.String({ description: "The name of the sub-agent to stop" }),
});

function reply(text: string): PigeonToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

export function renderAgentList(items: readonly AgentListing[]): string {
  if (items.length === 0) return "No agents.";
  return items
    .map((item) =>
      item.kind === "session"
        ? `${item.name}: session`
        : `${item.name}: ${item.type ?? "agent"}, ${item.state ?? "unknown"}, started by ${item.parent ?? "unknown"}`
    )
    .join("\n");
}

// 工具结果以 "Error:" 开头的按出错交回（上游转成错误结果）
function result(text: string): PigeonToolResult<undefined> {
  if (text.startsWith("Error: ")) throw new Error(text.slice("Error: ".length));
  return reply(text);
}

export function createAgentTools(host: AgentToolsHost): PigeonAgentTool<TSchema, undefined>[] {
  const tools: PigeonAgentTool<TSchema, undefined>[] = [];
  if (host.canSpawn()) {
    const spawn: PigeonAgentTool<typeof SpawnAgentParamsSchema, undefined> = {
      name: SPAWN_AGENT_TOOL,
      label: SPAWN_AGENT_TOOL,
      description: spawnAgentDescription(host.catalog()),
      parameters: SpawnAgentParamsSchema,
      executionMode: "parallel",
      async execute(_id, params, signal) {
        return result(
          await host.spawn({
            task: params.task,
            ...(params.type !== undefined ? { type: params.type } : {}),
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.model !== undefined ? { model: params.model } : {}),
            ...(params.background !== undefined ? { background: params.background } : {}),
            ...(params.inherit_context !== undefined
              ? { inheritContext: params.inherit_context }
              : {}),
            ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
            ...(signal !== undefined ? { signal } : {}),
          })
        );
      },
    };
    tools.push(spawn as unknown as PigeonAgentTool<TSchema, undefined>);
  }
  const send: PigeonAgentTool<typeof SendMessageParamsSchema, undefined> = {
    name: SEND_MESSAGE_TOOL,
    label: SEND_MESSAGE_TOOL,
    description: SEND_MESSAGE_DESCRIPTION,
    parameters: SendMessageParamsSchema,
    executionMode: "sequential",
    async execute(_id, params) {
      return result(host.send(params.to, params.message));
    },
  };
  const list: PigeonAgentTool<typeof ListAgentsParamsSchema, undefined> = {
    name: LIST_AGENTS_TOOL,
    label: LIST_AGENTS_TOOL,
    description: LIST_AGENTS_DESCRIPTION,
    parameters: ListAgentsParamsSchema,
    executionMode: "sequential",
    async execute() {
      return reply(renderAgentList(host.list()));
    },
  };
  const stop: PigeonAgentTool<typeof StopAgentParamsSchema, undefined> = {
    name: STOP_AGENT_TOOL,
    label: STOP_AGENT_TOOL,
    description: STOP_AGENT_DESCRIPTION,
    parameters: StopAgentParamsSchema,
    executionMode: "sequential",
    async execute(_id, params) {
      return result(await host.stop(params.name));
    },
  };
  const take: PigeonAgentTool<typeof TakeChangesParamsSchema, undefined> = {
    name: TAKE_CHANGES_TOOL,
    label: TAKE_CHANGES_TOOL,
    description: TAKE_CHANGES_DESCRIPTION,
    parameters: TakeChangesParamsSchema,
    executionMode: "sequential",
    async execute(_id, params) {
      return result(host.take(params.name));
    },
  };
  tools.push(
    send as unknown as PigeonAgentTool<TSchema, undefined>,
    list as unknown as PigeonAgentTool<TSchema, undefined>,
    stop as unknown as PigeonAgentTool<TSchema, undefined>,
    take as unknown as PigeonAgentTool<TSchema, undefined>
  );
  return tools;
}

export function agentToolRegistrations(host: AgentToolsHost): ToolRegistration[] {
  const base = {
    tier: "read" as const,
    pathConfinement: { kind: "none" as const },
  };
  return [
    ...(host.canSpawn()
      ? [
          {
            name: SPAWN_AGENT_TOOL,
            description: "start a sub-agent",
            parameters: SpawnAgentParamsSchema,
            executionMode: "parallel" as const,
            ...base,
          },
        ]
      : []),
    {
      name: SEND_MESSAGE_TOOL,
      description: "send a message to another agent",
      parameters: SendMessageParamsSchema,
      executionMode: "sequential" as const,
      ...base,
    },
    {
      name: LIST_AGENTS_TOOL,
      description: "list agents",
      parameters: ListAgentsParamsSchema,
      executionMode: "sequential" as const,
      ...base,
    },
    {
      name: STOP_AGENT_TOOL,
      description: "stop a sub-agent",
      parameters: StopAgentParamsSchema,
      executionMode: "sequential" as const,
      ...base,
    },
    // 决策 486：会写调用方的工作目录，按写档审批
    {
      name: TAKE_CHANGES_TOOL,
      description: "take a sub-agent's changes into your working directory",
      parameters: TakeChangesParamsSchema,
      executionMode: "sequential" as const,
      tier: "write" as const,
      pathConfinement: { kind: "none" as const },
    },
  ];
}
