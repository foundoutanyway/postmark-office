// doorstep-apex.test.mjs — the doorstep, the apex of apexes (POS-632 PR-6).
//
// The doorstep draws every line from a door's own read through the MCP
// dispatcher, so these drive it with a fake dispatcher answering in each
// door's real shape. They hold D1 (the bundle is a read away, untouched), D2
// (one line per item naming its door, at most 2,500 characters served), D3
// (its own cursor: the changed lines only, or nothing_new) and D4 (per
// handle), and the explain coverage of every key it can answer.
//
// Run: node --test test/doorstep-apex.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

process.env.WORLD_APEX = "1";
const { doorstepApex, DOORSTEP_BUDGET, decodeDoorstepCursor, DOORSTEP_TOOL } = await import("../src/doorstep-apex.mjs");
const { unexplained, TUTORIAL } = await import("../src/read-grammar.mjs");

const KEY = { handles: new Set(["wright"]) };
const T0 = Date.parse("2026-10-15T00:08:00Z");

function doors(over = {}) {
  const asked = [];
  const answers = {
    "household:needs-you": { stances_awaiting: { total: 55, rows: [] }, set_downs_awaiting: { rows: [] }, stakes_at_risk: { rows: [] }, key_asks: { rows: [] } },
    "household:doorstep": { handle: "wright", segments: ["mail"], mail: { total: 543 } },
    "world:": { you: { here: "the Quay Reach, the Town Centre" }, who: { active: [{ handle: "elowen" }, { handle: "little-bird" }], around_but_quiet: { count: 71 } },
      happening_here: [{ what: "Halloween in Postmark", kind: "event", phase: "underway" }] },
    "town:posts": { posts: [{ state: "open", terms: { title: "Read v2 feedback", reward: "5 stamps, once per household" } }, { state: "closed", terms: { title: "old" } }] },
    "town:calendar": { now: [{ title: "Halloween in Postmark", place: { name: "the Quay Reach" } }], coming: [] },
    "town:votes": { topics: [{ topic: "a", status: "open" }, { topic: "b", status: "closed" }] },
    "town:bulletin": { entries: [{ title: "Release notes — every bug its own card (2026-w42)" }] },
    ...over,
  };
  return {
    asked,
    ctx: {
      now: () => T0,
      call: async (tool, args) => { asked.push([tool, args]); return answers[`${tool}:${args.read ?? ""}`] ?? { error: "bounce", defect: "unknown" }; },
      unread: async () => Array.from({ length: 537 }, (_, i) => ({ id: i })),
      steps: async () => [{ kind: "quest", title: "Reach out", what: "Send a letter to 5 different residents. Resets daily. (0/5 today)" }, { kind: "paper", title: "x", what: "y" }],
    },
  };
}

test("bare: three parts, every line naming its door, within the budget as served", async () => {
  const { ctx, asked } = doors();
  const d = await doorstepApex({}, KEY, ctx);
  assert.equal(d.doorstep, "wright");
  for (const part of ["you", "here", "town"]) {
    assert.ok(d[part].length > 0, part);
    for (const it of d[part]) { assert.equal(typeof it.what, "string"); assert.match(it.from, /^(household|world|town)/); }
  }
  assert.deepEqual(d.you.map((i) => i.what), ["55 marks laid on your house's ground wait on your word", "537 unread letters", "Reach out: 0/5 today"]);
  assert.match(d.here[1].what, /2 residents active near you: elowen, little-bird \(71 more around, quiet\)/);
  assert.deepEqual(d.town.map((i) => i.from), ["town.posts", "town.calendar", "town.votes", "town.bulletin"]);
  assert.match(d.town[0].what, /Read v2 feedback — 5 stamps/);
  assert.ok(JSON.stringify(d, null, 1).length <= DOORSTEP_BUDGET, `served ${JSON.stringify(d, null, 1).length}`);
  assert.ok(asked.some(([t, a]) => t === "world" && a.read_shape === "v2"), "here is the v2 world read");
  assert.deepEqual(unexplained("doorstep", d, 1), []);
});

test("D3: the doorstep's cursor answers only the changed lines, or nothing_new", async () => {
  const first = await doorstepApex({}, KEY, doors().ctx);
  assert.ok(decodeDoorstepCursor(first.cursor));
  const same = await doorstepApex({ since: first.cursor }, KEY, doors().ctx);
  assert.equal(same.nothing_new, true);
  assert.deepEqual(unexplained("doorstep", same, 1), []);
  const moved = await doorstepApex({ since: first.cursor }, KEY, doors({ "town:votes": { topics: [] } , "household:needs-you": { stances_awaiting: { total: 56 } } }).ctx);
  assert.deepEqual(moved.you.map((i) => i.what), ["56 marks laid on your house's ground wait on your word"]);
  assert.deepEqual(moved.here, []);
  assert.deepEqual(moved.town, [], "a line that went away is not news; a line that is new or changed is");
  assert.equal((await doorstepApex({ since: "c1.1.2.3" }, KEY, doors().ctx)).code, 422, "the world's cursor is not the doorstep's");
});

test("D1: read: \"bundle\" is the morning bundle untouched; nothing else is read here, and nothing is done", async () => {
  const b = await doorstepApex({ read: "bundle" }, KEY, doors().ctx);
  assert.equal(b.read, "bundle");
  assert.deepEqual(b.bundle, { handle: "wright", segments: ["mail"], mail: { total: 543 } });
  assert.deepEqual(unexplained("doorstep", b, 1), []);
  assert.equal((await doorstepApex({ read: "mail" }, KEY, doors().ctx)).code, 422);
  assert.equal((await doorstepApex({ do: "send" }, KEY, doors().ctx)).code, 422);
  assert.equal((await doorstepApex({ explain: "town" }, KEY, doors().ctx)).explains, "town");
});

test("D4: per handle — a key with several names one, and a handle not on the key is refused", async () => {
  const two = { handles: new Set(["wright", "rei"]) };
  assert.equal((await doorstepApex({}, two, doors().ctx)).code, 422);
  assert.equal((await doorstepApex({ handle: "rei" }, two, doors().ctx)).doorstep, "rei");
  assert.equal((await doorstepApex({ handle: "kogane" }, two, doors().ctx)).code, 403);
});

test("a door that cannot answer drops its lines, and the world says so in one line", async () => {
  const d = await doorstepApex({}, KEY, doors({ "world:": { error: "bounce", defect: "the world store is down" }, "town:posts": { error: "bounce" } }).ctx);
  assert.match(d.here[0].what, /the world could not be read here \(the world store is down\)/);
  assert.ok(!d.town.some((i) => i.from === "town.posts"));
});

test("the doorstep is listed beside the three, and the tutorial starts there", async () => {
  const { toolList } = await import("../src/mcp.mjs");
  assert.ok(toolList().some((t) => t.name === "doorstep"));
  assert.equal(DOORSTEP_TOOL.inputSchema.additionalProperties, false);
  assert.match(TUTORIAL.split("\n")[1], /doorstep \{ \}.*Start here/);
});
