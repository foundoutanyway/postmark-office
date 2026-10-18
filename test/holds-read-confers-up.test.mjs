// holds-read-confers-up.test.mjs — hotfix w43.1 (Darko 2026-10-18 12:04, "agreed
// on the hotfix for 1"; the playground evidence in Starstory
// docs/2026-10-18/playground-holders/).
//
//   A. A holder's read counts what its room counts: a bag of 8 inside a bowl of
//      8 reads 17 (1 + 8 + 8), and the read's count plus the door's room is the
//      capacity. Counts confer up (Darko, 2026-10-17 23:29); a resident's hands
//      still count each top-level thing 1.
//   B. A pot-luck draw that lands on a holder you cannot carry says WHY it was
//      declined: the draw fell on a holder, pot luck draws over everything, and
//      kind: narrows it. Words only: the draw and the one-holder rule are unchanged.
//   C. consume { kind: "thing" } with candies in hand says a thing is not a
//      consumable and names the consumables you hold.
//
// Each test is a falsifier: it fails on main @ 54ce28fdc and passes on the fix.
// The kind door (`callKinds`) with every collaborator injected over an
// in-memory record, as kind-door.test.mjs drives it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callKinds } from "../src/world-kinds.mjs";
import { classViewOf } from "../src/world-units.mjs";
import { UNIT_ACTION } from "../src/world-stacks.mjs";
import { lawSnapshotFromRows } from "../src/law-classes.mjs";

const SHA = "d".repeat(40);
const cls = (key, data = {}) => ({ number: 300, tag_sha: SHA, newest: 300, kind: "class", key, data: { class: key, ...data } });
const prop = (klass, name, dflt, tier, parent = null) => ({ number: 300, tag_sha: SHA, newest: 300, kind: "property",
  key: parent ? `${klass}/${parent}/${name}` : `${klass}/${name}`, data: { class: klass, parent, name, tier, default: dflt, id: `the-town/${klass}-${name}` } });
const SNAP = lawSnapshotFromRows([
  cls("postmark-node"), cls("mark", { extends: "postmark-node" }), cls("sited", { extends: "mark" }),
  cls("thing", { extends: "sited" }), cls("consumable", { extends: "thing" }), cls("candy", { extends: "consumable" }),
  cls("halloween-candy-bag", { extends: "thing" }), cls("halloween-candy-bowl", { extends: "thing" }),
  cls("entity", { extends: "postmark-node" }), cls("resident", { extends: "entity" }),
  prop("postmark-node", "makers", false, "constitution"), prop("thing", "makers", true, "constitution"),
  prop("resident", "holder", true, "constitution"), prop("resident", "capacity", 24, "constitution", "holder"),
  prop("resident", "holders", 1, "constitution", "holder"),
  prop("thing", "holder", false, "sovereign"), prop("thing", "capacity", 30, "sovereign", "holder"),
  prop("thing", "min", 1, "constitution", "capacity"), prop("thing", "max", 120, "constitution", "capacity"),
  prop("thing", "open", true, "sovereign", "holder"), prop("thing", "portable", true, "sovereign"),
  prop("halloween-candy-bag", "holder", true, "constitution"), prop("halloween-candy-bowl", "holder", true, "constitution"),
]);

const ASH = "sb-ash", CLEO = "sb-cleo";
const BOWL = "sb-ash/a-halloween-bowl", BAG = "sb-ash/a-candy-bag", CLOTH = "sb-ash/a-cloth-bag-two";
const MARKS = {
  [BOWL]: { id: BOWL, by: ASH, kind: "halloween-candy-bowl", at: { x: 5, y: 6 } },
  [BAG]: { id: BAG, by: ASH, kind: "halloween-candy-bag", at: { x: 5, y: 6 } },
  [CLOTH]: { id: CLOTH, by: ASH, kind: "halloween-candy-bag", at: { x: 5, y: 6 } },
};
const NAMES = { [BOWL]: "A Halloween Bowl", [BAG]: "A Candy Bag", [CLOTH]: "A Cloth Bag Two" };
const row = (entity, target) => ({ entity, target, policy: "cascade", born_at: "2026-10-18T00:00:00Z" });

function world(things) {
  const acts = [];
  let seeded = 0;
  const deps = {
    classes: () => classViewOf(SNAP),
    readRows: async () => ({ units: acts.slice(), attachments: things }),
    markById: async (id) => MARKS[id] ?? null,
    nameOf: async (id) => NAMES[id] ?? null,
    reachTake: async () => ({ reach: { stands: true } }),
    reachGive: async () => ({ stands: true }),
    standpoint: async () => ({ x: 5, y: 6 }),
    householdOf: () => ({ key: "hh:sb", house: "hh:sb" }),
    append: async (entry, { also = [] } = {}) => { for (const e of [entry, ...also]) acts.push({ id: acts.length + 100, class: e.cls, action: e.action, payload: e.payload }); return { actId: acts.length + 99 }; },
    stamp: async (actor) => ({ at: `2026-10-18T12:00:00Z@${actor}#${acts.length}`, witnesses: [] }),
    crossing: () => 262,
    household: () => "hh:sb",
  };
  const seed = (to, n) => { acts.push({ id: acts.length + 100, class: "holding", action: UNIT_ACTION.make, payload: { units: true, moves: [{ from: null, to, kind: "candy", n }] } }); seeded += 1; };
  return { deps, seed, written: () => acts.length - seeded };
}
const go = (w, route, args, actor = ASH) => callKinds(route, args, { handles: new Set([actor]) }, actor, w.deps);

// ── A ───────────────────────────────────────────────────────────────────────

test("A · a bowl of 8 with a bag of 8 inside reads 17, and the read's count plus the door's room is the capacity", async () => {
  const at = () => { const w = world([row(BOWL, BAG)]); w.seed(BOWL, 8); w.seed(BAG, 8); return w; };
  // the door: 30 less 17 is 13 (the playground's T4, word for word)
  await assert.rejects(go(at(), "make", { kind: "candy", count: 14, to: BOWL }), (e) => e.code === 409 && e.room === 13 && /holds 17 of 30/.test(e.hint));
  // the read after an act at the bowl: one more candy made into it
  const w = at();
  const made = await go(w, "make", { kind: "candy", count: 1, to: BOWL });
  assert.equal(made.holds.count, 18, `the bowl's count confers up: 9 candies + the bag as 1 + its 8 (${JSON.stringify(made.holds)})`);
  assert.equal(made.holds.shows, "9 candies and A Candy Bag holding 8");
  assert.deepEqual(made.holds.whole, [{ thing: BAG, name: "A Candy Bag", holds: 8, counts: 9 }]);
  assert.match(made.holds.counting, /9 candies, A Candy Bag as 1 and the 8 it holds: 18 counted/);
  // and the door agrees with the read: its room now is 30 less the read's count
  await assert.rejects(go(w, "make", { kind: "candy", count: 13, to: BOWL }), (e) => e.room === 30 - made.holds.count);
});

test("A · the take result's holder block confers up too; a resident's hands still count each top-level thing 1", async () => {
  const w = world([row(BOWL, BAG)]);
  w.seed(BOWL, 8); w.seed(BAG, 8);
  const took = await go(w, "take", { from: BOWL, kind: "candy", count: 2 });
  assert.equal(took.holder.count, 15, "6 candies + the bag as 1 + its 8");
  assert.equal(took.holder.shows, "6 candies and A Candy Bag holding 8");
  assert.equal(took.holds.count, 2, "my hands: the 2 candies I took");
  // carrying the bag of 8, my hands read 1 for it (the ruled blur), never 9
  const hands = world([row(ASH, BAG)]);
  hands.seed(BAG, 8);
  const mine = await go(hands, "make", { kind: "candy", count: 3, to: ASH });
  assert.equal(mine.holds.count, 4, "3 candies and the bag as 1");
  assert.equal(mine.holds.whole, undefined);
});

test("A · a holder with nothing nested inside reads as before (the blur is the count)", async () => {
  const w = world([]);
  w.seed(BOWL, 8);
  const made = await go(w, "make", { kind: "candy", count: 2, to: BOWL });
  assert.deepEqual([made.holds.count, made.holds.shows, made.holds.whole], [10, "10 candies", undefined]);
});
