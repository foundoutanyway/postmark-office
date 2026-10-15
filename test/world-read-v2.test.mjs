// world-read-v2.test.mjs — the world read v2's sayings, pure (POS-632).
//
// The rig tests (test/world-read-shape.test.mjs) drive the whole read on a real
// world clone. These hold the rulings each block carries, on fixtures, so a
// flip of any one of them reds here by name:
//   G2 landmark = lifted AND weight ≥ 10 · G3 active = a public act in the last
//   12 hours · G5 only public acts, a say as the fact of it · G6 at most 8 active
//   · G8 the approved one-liner per act, grouped by intent · G7 happening_here.
//
// Run: node --test test/world-read-v2.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  viewBlock, whoBlock, canBlock, happeningBlock, eventsHere, happenedGlance, shapeV2, activeOf, actLine, inWords,
  LANDMARK_WEIGHT_FLOOR, ACTIVE_CAP, ACTIVE_WINDOW_MS, PUBLIC_ACTS, ACTIVE_SQL,
} from "../src/world-read-v2.mjs";
import { ONE_LINERS } from "../src/world-read-shape.mjs";
import { unbodied } from "./helpers/mark-bodies.mjs";

const NOW = Date.parse("2026-10-15T00:08:00Z");

test("G2: a landmark is lifted by its stamps AND weighs at least the floor; a picture is a flag", () => {
  const v = viewBlock([
    { id: "a/big", name: "Big", body: "A big place.", bearing: "NE", band: "across the way", distM: 393, weight: 83 },
    { id: "b/far", name: "Far", bearing: "SE", band: "far off", distM: 6164, weight: 82, lifted: true, image: true },
    { id: "c/tiny", name: "Tiny", bearing: "SE", band: "across the way", distM: 152, weight: LANDMARK_WEIGHT_FLOOR - 7, lifted: true },
    { id: "d/edge", name: "Edge", bearing: "N", band: "far off", distM: 3345, weight: LANDMARK_WEIGHT_FLOOR, lifted: true },
  ]);
  assert.deepEqual(Object.keys(v), ["NE", "SE", "N", "how"], "groups in the order of their best-ranked member");
  assert.equal(v.NE[0].landmark, undefined, "weighted but seated by its size: no flag");
  assert.equal(v.SE[0].landmark, true);
  assert.equal(v.SE[0].image, true);
  assert.deepEqual(v.SE[0].km, 6.2);
  assert.equal(v.SE[1].landmark, undefined, "lifted under the floor: no flag");
  assert.equal(v.N[0].landmark, true, "the floor itself counts");
  assert.equal(v.NE[0].m, 393);
  assert.equal(v.NE[0].body, "A big place.", "every view row carries its whole body (Darko 22:33)");
  assert.equal(v.SE[0].body, "", "a row whose mark has no body says so as an empty body, never by leaving the key out");
});

test("G3/G5/G6: active is a public act in the last 12 hours, at most 8, nearest first; a say is the fact of it", () => {
  const crowd = Array.from({ length: 12 }, (_, i) => ({ handle: `r${i}`, distance_m: 10 * (i + 1), bearing: "N", band: "close by", source: i === 11 ? "parcel" : "walk" }));
  const active = new Map([
    ["r0", { action: "say", at: NOW - 5 * 60000 }],
    ["r1", { action: "note-to-self", at: NOW - 60000 }],                     // private: never seen
    ["r2", { action: "walk", at: NOW - ACTIVE_WINDOW_MS - 60000 }],          // older than 12 h
    ...Array.from({ length: 9 }, (_, i) => [`r${i + 3}`, { action: "take", at: new Date(NOW - 3600000).toISOString() }]),
  ]);
  const who = whoBlock(crowd, active, { nowMs: NOW });
  assert.equal(who.active.length, ACTIVE_CAP);
  assert.equal(who.active[0].handle, "r0");
  assert.equal(who.active[0].last, "said something, 5 min ago");
  assert.ok(!who.active.some((r) => r.handle === "r1" || r.handle === "r2"));
  assert.equal(who.more_active, 10 - ACTIVE_CAP, "the rest of the active are counted");
  assert.equal(who.around_but_quiet.count, 2);
  assert.deepEqual(who.around_but_quiet.nearest, ["r1 (20 m)", "r2 (30 m)"]);
  assert.ok(!JSON.stringify(who).includes("note-to-self"));
  const home = whoBlock([crowd[11]], new Map(), { nowMs: NOW });
  assert.deepEqual(home.around_but_quiet.nearest, ["r11 (120 m, at home)"]);
});

test("G5: the public acts are the ones the crossing log or the docket publishes, and note-to-self is not one", () => {
  assert.deepEqual(Object.keys(PUBLIC_ACTS).sort(), ["drop", "enter", "exit", "give", "leave-mark", "say", "stake", "take", "walk", "withdraw"]);
});

test("G8: each act's line is the approved sentence without its fields, grouped by intent; an unknown act rides `more`", () => {
  const entries = ["say", "walk", "enter", "take", "candy-trade", "stake"].map((action) => ({ action, blurb: "A candy trade swaps two candies. More words." }));
  const can = canBlock(entries, { pace: 5, handles: ["wright", "rei"], standing: "wright", notYours: [{ action: "build", because: "not your ground" }] });
  assert.deepEqual(Object.keys(can), ["speak", "move", "back", "carry", "more", "not_here", "as"]);
  assert.equal(can.speak.say, ONE_LINERS.say.says);
  assert.doesNotMatch(JSON.stringify(can), /Fields:/);
  assert.equal(can.move.walk, "Walk to a mark or a point, at about 5 km an hour.");
  assert.equal(can.more["candy-trade"], "A candy trade swaps two candies.");
  assert.deepEqual(can.not_here, [{ act: "build", because: "not your ground" }]);
  const both = canBlock(entries, { notYours: [{ action: "say", because: "this door is for a human" }] });
  assert.equal(both.not_here, undefined, "G1: a refusal of an act your own grant opens is not said");
  assert.match(can.as, /^wright \(one of 2 residents on your key/);
  assert.equal(actLine({ action: "walk" }), "Walk to a mark or a point.", "no dial, no speed");
});

test("G7: happening_here says the vessel's next departures and the Mists only where you stand in them; nothing is null", () => {
  assert.equal(happeningBlock({}), null);
  assert.equal(happeningBlock({ mists: { in_wall: false, thickness: 0 } }), null, "clear of the Mists: the air says it");
  const snug = { id: "the-town/the-snug", name: "the Snug", body: "A small harbour." };
  const h = happeningBlock({ departures: { next: [{ at: "2026-10-15T01:30:00Z", toward: "the-town/the-snug" }] }, mists: { in_wall: false, thickness: 0.4 }, markOf: (id) => (id === snug.id ? snug : null) });
  assert.deepEqual(h.map((r) => r.kind), ["departure", "emission"]);
  assert.equal(h[0].at, "01:30Z");
  assert.deepEqual(h[0].to, snug, "a departure's destination is shown whole");
  assert.equal(h[0].what, "the Post Office leaves here for the Snug");
  assert.deepEqual(unbodied(h), []);
  const cal = { now: [
    { id: "postmaster/halloween", title: "Halloween in Postmark", place: { mark: "the-town/the-quay-reach", name: "the Quay Reach", x: 0, y: 0 }, phase: "underway", ends: "2026-11-01T04:00:00Z" },
    { id: "a/far-party", title: "Far party", place: { mark: "a/elsewhere", x: 5000, y: 5000 }, phase: "underway", ends: "2026-11-01T04:00:00Z" },
    { id: "b/near-point", title: "On the steps", place: { mark: null, x: 100, y: 100 }, phase: "doors-open", ends: "2026-11-01T04:00:00Z" },
  ] };
  const here = eventsHere(cal, { at: { x: 0, y: 50 }, ids: new Set(["the-town/the-quay-reach"]) });
  assert.deepEqual(here.map((e) => e.id), ["postmaster/halloween", "b/near-point"], "on the spine, or its point within 150 m");
  const reach = { id: "the-town/the-quay-reach", name: "the Quay Reach", body: "The mail's own water." };
  const rows = happeningBlock({ events: here, markOf: (id) => (id === reach.id ? reach : null) });
  assert.equal(rows[0].kind, "event");
  assert.deepEqual(rows[0].place, reach, "an event's place is shown whole");
  assert.equal(rows[0].event, "postmaster/halloween");
  assert.deepEqual(unbodied(rows), []);
});

test("G4: happened with no cursor names where it reaches back to; an unread delta says so", () => {
  const g = happenedGlance({ to_you: { complete: true, count: 0, events: [] }, around_you: { count: 7, events: [
    { kind: "departure", actor: "elowen", at: "2026-10-15T00:01:00Z" }, { kind: "emission", actor: "fizz", at: "2026-10-15T00:00:09Z" },
    { kind: "attachment", actor: "kai", at: "2026-10-14T23:00:00Z" }, { kind: "departure", actor: "x", at: "2026-10-14T22:00:00Z" },
  ] } }, { sinceCrossing: 249 });
  assert.equal(g.since, "crossing 249");
  assert.equal(g.around_you.events.length, 3);
  assert.equal(g.around_you.count, 7);
  assert.deepEqual(g.around_you.events[0], { who: "elowen", what: "set out", when: "00:01Z" });
  assert.match(happenedGlance(null, { sinceCrossing: 249 }).unavailable, /not read/);
});

test("the assembled read: you, now, view, who, can, law in order; no URL; happened always", () => {
  const v2 = shapeV2({
    handle: "wright", standpoint: { x: -318, y: 211, seat: { ground: "x" } }, spine: [{ id: "a", body: "A." }, { id: "b", body: "The reach." }],
    here: "the Quay Reach, the Town Centre", holdings: [], stancesAwaiting: 55, note: null, crossing: 250, nextCrossingIn: "11h 52m",
    canon: "S109", nextSettlement: "06:00Z", happened: null, sinceCrossing: 249, viewRows: [], crowd: [], active: new Map(), nowMs: NOW, entries: [{ action: "say" }],
  });
  assert.deepEqual(Object.keys(v2).slice(0, 6), ["you", "now", "view", "who", "can", "law"]);
  assert.deepEqual(v2.you.within.map((m) => m.body), ["A.", "The reach."], "every spine mark carries its whole body");
  assert.ok(!("here_body" in v2.you), "here_body repeated the innermost; within carries it");
  assert.deepEqual(unbodied(v2), [], "no mark is shown without its body");
  const dark = shapeV2({ standpoint: { x: 0, y: 0 }, spine: [], crossing: 1, entries: [], canUnavailable: "the world store is not open" });
  assert.deepEqual(dark.can, { unavailable: "the world store is not open" }, "an unreadable class layer is said, never an empty can (review-555 § 1)");
  assert.deepEqual(v2.you.seat, { ground: "x" }, "G1: the seat is said on you");
  assert.deepEqual(v2.you.waiting_on_you, { stances: 55, read: 'household { read: "stances" }' });
  assert.ok("happened" in v2.now);
  assert.doesNotMatch(JSON.stringify(v2), /https?:\/\//);
  assert.equal(inWords(52 * 60000 + 11 * 3600000), "11h 52m");
});

test("activeOf: one query for the crowd, public acts only, and a store that cannot answer is said", async () => {
  let asked = null;
  const r = await activeOf(["a", "b", "a"], { query: async (text, params) => { asked = { text, params }; return [{ handle: "a", action: "say", at: new Date(NOW) }]; } });
  assert.equal(asked.text, ACTIVE_SQL);
  assert.deepEqual(asked.params[0], ["a", "b"]);
  assert.deepEqual(asked.params[1], Object.keys(PUBLIC_ACTS));
  assert.equal(asked.params[2], ACTIVE_WINDOW_MS / 1000);
  assert.deepEqual(r.active.get("a"), { action: "say", at: NOW });
  assert.match((await activeOf(["a"], { query: async () => null })).unavailable, /store/);
  assert.match((await activeOf(["a"], { query: async () => { throw new Error("gone"); } })).unavailable, /could not be read/);
  assert.equal((await activeOf([], { query: async () => { throw new Error("never asked"); } })).active.size, 0);
});
