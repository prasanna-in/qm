import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAckEmoji, slackPluginConfigFromEnv } from "../src/slack/config.ts";
import { createAckEmojiPicker } from "../src/slack/ack-emoji.ts";
import { CURATED_ACK_EMOJI, DEFAULT_ACK_REACTIONS, createAckPresenter } from "../src/slack/presenters.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

test("parseAckEmoji: normalizes colons/case, splits on commas and spaces, drops junk, dedupes", () => {
  assert.deepEqual(parseAckEmoji(":custom_thinking:, CUSTOM_OK  custom_ok\n:+1:"), ["custom_thinking", "custom_ok", "+1"]);
  assert.deepEqual(parseAckEmoji("bad name!, :also bad:"), ["bad", "also"]);
  assert.deepEqual(parseAckEmoji(""), []);
  assert.deepEqual(parseAckEmoji(undefined), []);
  assert.deepEqual(parseAckEmoji(" , ::, !!"), []);
});

test("config: SLACK_ACK_EMOJI lands as ackEmoji; absent or empty leaves it unset", () => {
  const base = { SLACK_BOT_TOKEN: "xoxb", SLACK_APP_TOKEN: "xapp" };
  const withSet = slackPluginConfigFromEnv({ ...base, SLACK_ACK_EMOJI: ":custom_thinking:,custom_ok" });
  assert.deepEqual(withSet?.ackEmoji, ["custom_thinking", "custom_ok"]);
  assert.equal(slackPluginConfigFromEnv(base)?.ackEmoji, undefined);
  assert.equal(slackPluginConfigFromEnv({ ...base, SLACK_ACK_EMOJI: " :!!: " })?.ackEmoji, undefined);
});

function pickerFixture(opts?: { candidatesOverride?: readonly string[] }) {
  const core = {} as SlackCoreClient;
  const client = { emoji: { list: async () => ({ emoji: { custom_ok: "https://x/a.png" } }) } };
  return { picker: createAckEmojiPicker(core, opts), client };
}

test("ackPickCandidates: an org override fully replaces the stock candidate set", async () => {
  const { picker, client } = pickerFixture({ candidatesOverride: ["custom_thinking", "custom_ok"] });
  picker.refreshAckEmoji(client);
  await Promise.resolve();
  assert.deepEqual(picker.ackPickCandidates(client), ["custom_thinking", "custom_ok"]);
});

test("ackPickCandidates: without an override the curated + default sets remain", () => {
  const { picker, client } = pickerFixture();
  const candidates = picker.ackPickCandidates(client);
  for (const name of [...CURATED_ACK_EMOJI, ...DEFAULT_ACK_REACTIONS]) assert.ok(candidates.includes(name));
});

test("ack presenter: fallback reaction draws from the org set when provided", async () => {
  const added: string[] = [];
  const presenter = createAckPresenter({
    postAck: async () => {},
    addReaction: async (name) => {
      added.push(name);
    },
    removeReaction: async () => {},
    emojiCandidates: ["custom_thinking"],
    reactionDelayMs: 1,
  });
  await new Promise((r) => setTimeout(r, 20));
  await presenter.drain();
  assert.deepEqual(added, ["custom_thinking"]);
  await presenter.settle();
});
