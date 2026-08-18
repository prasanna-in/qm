const MAX_TRACKED = 500;
const MAX_TITLE_LENGTH = 50;

export interface AgentContextEntity {
  type?: string;
  value?: string;
  team_id?: string;
}

interface AgentThreadContext {
  channel_id?: string;
  thread_ts?: string;
  team_id?: string;
  enterprise_id?: string;
}

export interface AssistantThreadEvent {
  assistant_thread?: {
    channel_id?: string;
    thread_ts?: string;
    context?: AgentThreadContext;
  };
}

export interface AppContextChangedEvent {
  user?: string;
  context?: { entities?: AgentContextEntity[] };
}

export interface AgentPaneClient {
  assistant?: {
    threads?: {
      setStatus?(args: { channel_id: string; thread_ts: string; status: string }): Promise<unknown>;
      setTitle?(args: { channel_id: string; thread_ts: string; title: string }): Promise<unknown>;
    };
  };
}

export interface AgentPane {
  noteThreadStarted(event: AssistantThreadEvent): void;
  noteThreadContextChanged(event: AssistantThreadEvent): void;
  noteAppContextChanged(event: AppContextChangedEvent): void;
  isAgentThread(channel: string | undefined, threadTs: string | undefined): boolean;
  contextNote(args: {
    channel?: string;
    threadTs?: string;
    userId?: string;
    messageContext?: { entities?: AgentContextEntity[] };
  }): string | undefined;
  setStatus(client: AgentPaneClient, channel: string, threadTs: string, status: string): Promise<void>;
  maybeSetTitle(client: AgentPaneClient, channel: string, threadTs: string, text: string): Promise<void>;
  enabled(): boolean;
}

export function threadTitleFrom(text: string): string | undefined {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length <= MAX_TITLE_LENGTH ? collapsed : `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

export function describeContextEntities(entities: AgentContextEntity[] | undefined): string | undefined {
  const parts: string[] = [];
  for (const e of entities ?? []) {
    if (!e?.value) continue;
    const kind = (e.type ?? "").split("/").pop() ?? "";
    if (kind === "channel_id") parts.push(`<#${e.value}>`);
    else if (kind === "thread_ts") parts.push(`a thread (ts ${e.value})`);
    else if (kind === "message_ts") parts.push(`a message (ts ${e.value})`);
    else parts.push(kind ? `${kind.replace(/_id$/, "").replace(/_/g, " ")} ${e.value}` : e.value);
  }
  if (!parts.length) return undefined;
  return `The user currently has ${parts.join(", in ")} open in Slack.`;
}

function describeThreadContext(ctx: AgentThreadContext | undefined): string | undefined {
  if (!ctx?.channel_id) return undefined;
  const target = ctx.thread_ts ? `a thread (ts ${ctx.thread_ts}) in <#${ctx.channel_id}>` : `<#${ctx.channel_id}>`;
  return `The user currently has ${target} open in Slack.`;
}

export function createAgentPane(): AgentPane {
  const threads = new Map<string, { context?: AgentThreadContext; titled?: boolean }>();
  const userContexts = new Map<string, AgentContextEntity[]>();
  let apiDisabled = false;
  let warned = false;

  const key = (channel: string | undefined, threadTs: string | undefined): string | undefined =>
    channel && threadTs ? `${channel}:${threadTs}` : undefined;

  const remember = (k: string, patch: { context?: AgentThreadContext; titled?: boolean }): void => {
    const prior = threads.get(k);
    if (prior) threads.delete(k);
    threads.set(k, { ...prior, ...patch });
    if (threads.size > MAX_TRACKED) {
      const oldest = threads.keys().next().value;
      if (oldest !== undefined) threads.delete(oldest);
    }
  };

  const featureUnavailable = (msg: string): boolean =>
    /missing_scope|not_allowed_token_type|unknown_method|method_not_supported|feature_not_enabled|invalid_arguments|not_authed|paid_teams_only|paid.*required/i.test(
      msg,
    );

  const call = async (label: string, fn: (() => Promise<unknown>) | undefined): Promise<boolean> => {
    if (apiDisabled || !fn) return false;
    try {
      await fn();
      return true;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (featureUnavailable(msg)) {
        apiDisabled = true;
        if (!warned) {
          warned = true;
          console.warn(
            `[slack-plugin] agent-pane API unavailable (${label}: ${msg}) — install predates the agent_view manifest, ` +
              "or the workspace plan doesn't include AI apps. Conversations keep working without status/titles.",
          );
        }
        return false;
      }
      console.error(`[slack-plugin] agent-pane ${label} failed: ${msg}`);
      return false;
    }
  };

  return {
    noteThreadStarted(event) {
      const t = event.assistant_thread;
      const k = key(t?.channel_id, t?.thread_ts);
      if (!k) return;
      remember(k, t?.context ? { context: t.context } : {});
    },
    noteThreadContextChanged(event) {
      const t = event.assistant_thread;
      const k = key(t?.channel_id, t?.thread_ts);
      if (!k) return;
      remember(k, { context: t?.context ?? {} });
    },
    noteAppContextChanged(event) {
      if (!event.user) return;
      userContexts.set(event.user, event.context?.entities ?? []);
      if (userContexts.size > MAX_TRACKED) {
        const oldest = userContexts.keys().next().value;
        if (oldest !== undefined) userContexts.delete(oldest);
      }
    },
    isAgentThread(channel, threadTs) {
      const k = key(channel, threadTs);
      return k !== undefined && threads.has(k);
    },
    contextNote({ channel, threadTs, userId, messageContext }) {
      const fromMessage = describeContextEntities(messageContext?.entities);
      if (fromMessage) return fromMessage;
      const k = key(channel, threadTs);
      const fromThread = k ? describeThreadContext(threads.get(k)?.context) : undefined;
      if (fromThread) return fromThread;
      return userId ? describeContextEntities(userContexts.get(userId)) : undefined;
    },
    async setStatus(client, channel, threadTs, status) {
      const setStatus = client.assistant?.threads?.setStatus;
      await call(
        "setStatus",
        setStatus ? () => setStatus({ channel_id: channel, thread_ts: threadTs, status }) : undefined,
      );
    },
    async maybeSetTitle(client, channel, threadTs, text) {
      const k = key(channel, threadTs);
      if (!k) return;
      const entry = threads.get(k);
      if (!entry || entry.titled) return;
      const title = threadTitleFrom(text);
      if (!title) return;
      remember(k, { titled: true });
      const setTitle = client.assistant?.threads?.setTitle;
      const ok = await call(
        "setTitle",
        setTitle ? () => setTitle({ channel_id: channel, thread_ts: threadTs, title }) : undefined,
      );
      if (!ok && !apiDisabled && threads.has(k)) remember(k, { titled: false });
    },
    enabled() {
      return !apiDisabled;
    },
  };
}
