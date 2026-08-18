import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentPane,
  describeContextEntities,
  threadTitleFrom,
  type AgentPaneClient,
} from "../src/slack/agent-pane.ts";
import { registerSlackEvents } from "../src/slack/events.ts";
import { createDeduper } from "../src/slack/lib.ts";
import type { TurnHandler } from "../src/slack/turn-handler.ts";

const THREAD = { channel_id: "D111", thread_ts: "100.1" };

function fakeApp() {
  const events = new Map<string, (args: any) => Promise<void>>();
  const messages: Array<(args: any) => Promise<void>> = [];
  return {
    app: {
      event: (name: string, h: (args: any) => Promise<void>) => void events.set(name, h),
      message: (h: (args: any) => Promise<void>) => void messages.push(h),
    },
    fire: (name: string, event: unknown, client: unknown = {}) =>
      events.get(name)!({ event, body: {}, client, context: {} }),
    hasEvent: (name: string) => events.has(name),
    im: (message: Record<string, unknown>, client: unknown = {}) =>
      messages[0]!({ message: { channel_type: "im", ...message }, body: {}, client, context: {} }),
  };
}

function fakeClient() {
  const calls: Array<{ method: string; args: any }> = [];
  const client: AgentPaneClient & Record<string, any> = {
    assistant: {
      threads: {
        setStatus: async (args: any) => void calls.push({ method: "setStatus", args }),
        setTitle: async (args: any) => void calls.push({ method: "setTitle", args }),
      },
    },
  };
  return { client, calls };
}

function register(pane: ReturnType<typeof createAgentPane> | undefined) {
  const dispatched: any[] = [];
  const app = fakeApp();
  const handler = {
    dispatch: async (_key: string, inc: any) => void dispatched.push(inc),
    handleReactionEvent: async () => {},
    botHasStakeInThread: async () => false,
  } as unknown as TurnHandler;
  registerSlackEvents(app.app, {
    handler,
    mirror: { mirrorMessageEvent: async () => {}, pushSurfaceEvents: async () => {} } as any,
    directory: { syncForUnseenGroup: () => {}, forceDirectorySync: async () => {} } as any,
    ids: { botUserId: "UBOT", ownBotId: "BBOT" } as any,
    deduper: createDeduper(),
    ...(pane ? { agentPane: pane } : {}),
  });
  return { app, dispatched };
}

test("agent thread messages get a working status, a title, and still dispatch as normal DM turns", async () => {
  const pane = createAgentPane();
  const { app, dispatched } = register(pane);
  const { client, calls } = fakeClient();

  await app.fire("assistant_thread_started", { assistant_thread: { ...THREAD, context: { channel_id: "C42" } } });
  assert.equal(pane.isAgentThread("D111", "100.1"), true);

  await app.im({ channel: "D111", user: "U1", text: "summarize this please", ts: "100.2", thread_ts: "100.1" }, client);

  assert.equal(dispatched.length, 1);
  const inc = dispatched[0];
  assert.equal(inc.kind, "dm");
  assert.equal(inc.threadTs, "100.1");
  assert.match(inc.contextNote, /<#C42>/);

  const statuses = calls.filter((c) => c.method === "setStatus").map((c) => c.args.status);
  assert.deepEqual(statuses, ["thinking…", ""]);
  const titles = calls.filter((c) => c.method === "setTitle");
  assert.equal(titles.length, 1);
  assert.deepEqual(titles[0]!.args, { channel_id: "D111", thread_ts: "100.1", title: "summarize this please" });

  // A second message in the same thread does not re-title.
  await app.im({ channel: "D111", user: "U1", text: "and shorter", ts: "100.3", thread_ts: "100.1" }, client);
  assert.equal(calls.filter((c) => c.method === "setTitle").length, 1);
});

test("the status indicator clears even when dispatch throws", async () => {
  const pane = createAgentPane();
  const app = fakeApp();
  const { client, calls } = fakeClient();
  registerSlackEvents(app.app, {
    handler: {
      dispatch: async () => {
        throw new Error("boom");
      },
      handleReactionEvent: async () => {},
      botHasStakeInThread: async () => false,
    } as unknown as TurnHandler,
    mirror: { mirrorMessageEvent: async () => {}, pushSurfaceEvents: async () => {} } as any,
    directory: { syncForUnseenGroup: () => {}, forceDirectorySync: async () => {} } as any,
    ids: { botUserId: "UBOT", ownBotId: "BBOT" } as any,
    deduper: createDeduper(),
    agentPane: pane,
  });
  await app.fire("assistant_thread_started", { assistant_thread: THREAD });
  await assert.rejects(app.im({ channel: "D111", user: "U1", text: "hi", ts: "1.2", thread_ts: "100.1" }, client));
  const statuses = calls.filter((c) => c.method === "setStatus").map((c) => c.args.status);
  assert.deepEqual(statuses, ["thinking…", ""]);
});

test("context precedence: the message's own app_context beats the saved thread context", async () => {
  const pane = createAgentPane();
  const { app, dispatched } = register(pane);
  await app.fire("assistant_thread_started", { assistant_thread: { ...THREAD, context: { channel_id: "C42" } } });
  await app.im({
    channel: "D111",
    user: "U1",
    text: "hi",
    ts: "100.2",
    thread_ts: "100.1",
    app_context: { entities: [{ type: "slack#/types/channel_id", value: "C99" }] },
  });
  assert.match(dispatched[0].contextNote, /<#C99>/);
});

test("assistant_thread_context_changed and app_context_changed update what the pane reports", async () => {
  const pane = createAgentPane();
  const { app, dispatched } = register(pane);
  await app.fire("assistant_thread_started", { assistant_thread: { ...THREAD, context: { channel_id: "C42" } } });
  await app.fire("assistant_thread_context_changed", {
    assistant_thread: { ...THREAD, context: { channel_id: "C43" } },
  });
  await app.im({ channel: "D111", user: "U1", text: "hi", ts: "100.2", thread_ts: "100.1" });
  assert.match(dispatched[0].contextNote, /<#C43>/);

  // With no thread context, fall back to the user's latest app_context_changed.
  await app.fire("assistant_thread_context_changed", { assistant_thread: { ...THREAD, context: {} } });
  await app.fire("app_context_changed", {
    user: "U1",
    context: { entities: [{ type: "slack#/types/channel_id", value: "C77" }] },
  });
  await app.im({ channel: "D111", user: "U1", text: "hi again", ts: "100.3", thread_ts: "100.1" });
  assert.match(dispatched[1].contextNote, /<#C77>/);
});

test("plain DM messages outside an agent thread carry no pane behavior", async () => {
  const pane = createAgentPane();
  const { app, dispatched } = register(pane);
  const { client, calls } = fakeClient();
  await app.im({ channel: "D111", user: "U1", text: "hello", ts: "1.1" }, client);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].contextNote, undefined);
  assert.equal(calls.length, 0);
});

test("without an agentPane the agent events are not registered and DMs dispatch as before", async () => {
  const { app, dispatched } = register(undefined);
  assert.equal(app.hasEvent("assistant_thread_started"), false);
  assert.equal(app.hasEvent("app_context_changed"), false);
  await app.im({ channel: "D111", user: "U1", text: "hello", ts: "1.1" });
  assert.equal(dispatched.length, 1);
});

test("feature detection: a missing_scope failure disables pane API calls without failing the turn", async () => {
  const pane = createAgentPane();
  const { app, dispatched } = register(pane);
  let attempts = 0;
  const client = {
    assistant: {
      threads: {
        setStatus: async () => {
          attempts++;
          throw new Error("An API error occurred: missing_scope");
        },
        setTitle: async () => {
          attempts++;
          throw new Error("An API error occurred: missing_scope");
        },
      },
    },
  };
  await app.fire("assistant_thread_started", { assistant_thread: THREAD });
  await app.im({ channel: "D111", user: "U1", text: "hi", ts: "100.2", thread_ts: "100.1" }, client);
  await Promise.resolve();
  assert.equal(dispatched.length, 1);
  assert.equal(pane.enabled(), false);
  const seen = attempts;
  await app.im({ channel: "D111", user: "U1", text: "again", ts: "100.3", thread_ts: "100.1" }, client);
  assert.equal(attempts, seen);
});

test("a client without assistant methods (old @slack/web-api) is a no-op", async () => {
  const pane = createAgentPane();
  const { app, dispatched } = register(pane);
  await app.fire("assistant_thread_started", { assistant_thread: THREAD });
  await app.im({ channel: "D111", user: "U1", text: "hi", ts: "100.2", thread_ts: "100.1" }, {});
  assert.equal(dispatched.length, 1);
  assert.equal(pane.enabled(), true);
});

test("threadTitleFrom collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(threadTitleFrom("  hello\n  world "), "hello world");
  assert.equal(threadTitleFrom("   "), undefined);
  const long = "x".repeat(80);
  const title = threadTitleFrom(long)!;
  assert.equal(title.length, 50);
  assert.ok(title.endsWith("…"));
});

test("describeContextEntities renders channels, threads, and unknown entity types", () => {
  assert.equal(describeContextEntities([]), undefined);
  assert.equal(
    describeContextEntities([
      { type: "slack#/types/thread_ts", value: "12.34" },
      { type: "slack#/types/channel_id", value: "C1" },
    ]),
    "The user currently has a thread (ts 12.34), in <#C1> open in Slack.",
  );
  assert.match(describeContextEntities([{ type: "slack#/types/canvas_id", value: "F1" }])!, /canvas F1/);
});
