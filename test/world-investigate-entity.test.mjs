// world-investigate-entity.test.mjs — investigate: on a resident (POS-632 PR-4).
//
// The entity read's composition on fixtures: the three parts, the privacy
// scope (G5: public acts only, a say as the fact of it, never a note to self),
// the 12-hour window, the cap, and the kinds an investigate: can name.
//
// Run: node --test test/world-investigate-entity.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { entityKindOf, investigateResident, RECENT_CAP } from "../src/world-investigate-entity.mjs";

const NOW = Date.parse("2026-10-15T00:08:00Z");
const ago = (min) => new Date(NOW - min * 60000);
const deps = (over = {}) => ({
  nowMs: NOW,
  from: { x: 0, y: 0 },
  known: async (h) => h === "elowen",
  standpoint: async () => ({ placed: true, x: 30, y: 40, moving: false, aboard: false, source: "walk" }),
  place: async ({ x }) => (x === 30 ? "the Quay Reach, the Town Centre" : "the Gauge House, the Town Centre"),
  saved: () => ({ crossing: 250, x: -62, y: 148 }),
  recent: async () => [
    { action: "say", at: ago(4), at_anchor: "a/b" },
    { action: "note-to-self", at: ago(5), at_anchor: "a/b" },
    { action: "take", at: ago(40), at_anchor: "a/b" },
    { action: "walk", at: ago(13 * 60), at_anchor: "a/b" },
  ],
  holds: async () => ["the-town/a-pocket-comet"],
  placeOf: () => ({ x: 30, y: 40 }),
  ...over,
});

test("the kinds: a handle is a resident, a creature/ id waits on its class, any other slash is a mark", () => {
  assert.deepEqual(entityKindOf("elowen"), { kind: "resident", handle: "elowen" });
  assert.deepEqual(entityKindOf("@elowen"), { kind: "resident", handle: "elowen" });
  assert.equal(entityKindOf("creature/mist-hare-7").kind, "creature");
  assert.equal(entityKindOf("the-town/the-quay-reach").kind, "mark");
});

test("a resident: presence now and at the last crossing, each labelled with what answered it; holds", async () => {
  const r = await investigateResident("elowen", deps());
  assert.equal(r.kind, "resident");
  assert.deepEqual(r.presence.now.at, { x: 30, y: 40 });
  assert.equal(r.presence.now.from_you.m, 50);
  assert.equal(r.presence.now.doing, "standing");
  assert.match(r.presence.now.answered_by, /as of now/);
  assert.equal(r.presence.last_crossing.crossing, 250);
  assert.match(r.presence.last_crossing.answered_by, /as of crossing 250/);
  assert.deepEqual(r.holds, ["the-town/a-pocket-comet"]);
});

test("G5: only public acts, a say as the fact of it; never a note to self; only the last 12 hours", async () => {
  const r = await investigateResident("elowen", deps());
  assert.deepEqual(r.recent.acts.map((a) => a.did), ["said something", "picked something up"]);
  assert.ok(!JSON.stringify(r).includes("note-to-self"));
  assert.equal(r.recent.window, "the last 12 hours");
  assert.equal(r.recent.acts[0].where, "the Quay Reach, the Town Centre");
});

test("the cap, an unknown handle, and sources that cannot be read are said, never guessed", async () => {
  const many = await investigateResident("elowen", deps({ recent: async () => Array.from({ length: 20 }, (_, i) => ({ action: "walk", at: ago(i) })) }));
  assert.equal(many.recent.acts.length, RECENT_CAP);
  const nobody = await investigateResident("nobody", deps());
  assert.equal(nobody.code, 404);
  const dark = await investigateResident("elowen", deps({ recent: async () => null, holds: async () => null, standpoint: async () => null, saved: () => null }));
  assert.match(dark.recent.unavailable, /could not be read/);
  assert.match(dark.holds.unavailable, /could not be read/);
  assert.match(dark.presence.now.unavailable, /cannot place/);
  assert.equal(dark.presence.last_crossing, undefined);
});
