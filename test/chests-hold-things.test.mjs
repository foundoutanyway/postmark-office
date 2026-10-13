// chests-hold-things.test.mjs — WLD-27, Bevel's first review (2026-10-13).
//
// Four boundary findings and one scope correction, each held here by a test
// that fails on the submitted head (01abca91) and passes on the correction:
//   1. a take-back refused for the carry cap returns NO stake first;
//   2. a failed withdrawal of an exited mark is tried again on retry — and
//      only the withdrawal: no second unit, no second return;
//   3. a failed set-down's compensation cannot leave 25 carried when another
//      hold reached for the freed slot while the mark was filing;
//   4. a carried chest is on its CARRIER's card (and still on its maker's);
//   5. a chest takes whole THINGS too: they share its one capacity, show in
//      what it holds (101 candies and a toaster read 102 things), leave the
//      carrier's load, and come out by a take aimed at the chest.
// Everything is synthetic and in memory: the record, the ledger, the pens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callUnits, classViewOf, residentHolds, chestsRead, reservedFor } from "../src/world-units.mjs";
import { UNIT_ACTION, foldUnits, totalOf } from "../src/world-stacks.mjs";
import { liveHolder, holdingsOf } from "../src/world-hold.mjs";

const LABEL = "test-comets";
const CLASSES = new Map(Object.entries({
  mark: { extends: null, dials: {} },
  thing: { extends: "mark", dials: { carry_cap: 24 } },
  consumable: { extends: "thing", dials: {} },
  candy: { extends: "consumable", dials: {}, labels: [{ label: LABEL, name: "Test Comets", creator: "sbx-ana" }] },
  chest: { extends: "thing", dials: { capacity: 30, capacity_min: 1, capacity_max: 120, first_stock: 30, portable: true, welcome: "open" } },
  toaster: { extends: "thing", dials: {} },
}));
const view = () => classViewOf({ classes: CLASSES });
const KEY = (h) => ({ handles: new Set([h]) });

function rig({ marks = {}, stakes = {} } = {}) {
  const acts = [], attachments = [], ledger = [], withdrawals = [];
  const positions = structuredClone(stakes);
  let failWithdraw = 0, leave = null;
  const deps = {
    classes: view,
    readRows: async () => ({ units: acts.filter((a) => String(a.action).startsWith("units:")), attachments: attachments.slice() }),
    markById: async (id) => marks[id] ?? null,
    reachTake: async () => ({}), reachGive: async () => ({}),
    standpoint: async () => ({ x: 1, y: 1 }),
    householdOf: (h) => ({ key: `hh:${h}`, house: `hh:${h}` }),
    stamp: async () => ({ at: {}, witnesses: [] }),
    crossing: () => 250, household: () => "hh:test",
    append: async (e) => {
      const id = acts.length + 100;
      acts.push({ id, class: e.cls, action: e.action, object: e.object, actor: e.actor, payload: e.payload, effect: e.effect });
      if (["give", "take", "drop"].includes(e.action) && e.payload?.thing)
        attachments.push({ entity: e.payload.holder ?? e.actor, target: e.payload.thing, policy: e.payload.policy, born_at: e.writtenAt });
      return { actId: id };
    },
    leave: async (...a) => (leave ? leave(...a) : { id: "x", put_forward: true }),
    holders: async (m) => (positions[m] ?? []).filter((p) => p.stamps > 0),
    unstake: async (r) => {
      const p = (positions[r.mark] ?? []).find((x) => x.handle === r.handle);
      const n = Math.min(p?.stamps ?? 0, r.stamps); if (p) p.stamps -= n;
      if (n) ledger.push({ handle: r.handle, mark: r.mark, n });
      return { applied: n };
    },
    withdraw: async (m) => { withdrawals.push(m); if (failWithdraw-- > 0) throw new Error("synthetic pen refused"); return { withdrawn: true }; },
  };
  const seedUnits = (to, n, label = LABEL) => acts.push({ id: acts.length + 100, class: "holding", action: UNIT_ACTION.give, object: to, payload: { units: true, moves: [{ from: null, to, label, n }] } });
  const hold = (holder, thing) => attachments.push({ entity: holder, target: thing, policy: "cascade", born_at: new Date(Date.now() - 1000).toISOString() });
  return { deps, acts, attachments, ledger, withdrawals, seedUnits, hold,
    failWithdrawals: (n) => { failWithdraw = n; }, onLeave: (fn) => { leave = fn; },
    units: () => foldUnits(acts.filter((a) => String(a.action).startsWith("units:"))) };
}

const DROPPED = "sbx-ana/test-comets-41";
const droppedMark = { id: DROPPED, by: "sbx-ana", class: "candy", kind: "sited", label: LABEL, dropped: "act:41" };
const STAKES = { [DROPPED]: [{ handle: "sbx-ana", stamps: 1 }, { handle: "sbx-bo", stamps: 2 }] };

test("1 · a take-back refused for the carry cap returns no stake and records nothing", async () => {
  const r = rig({ marks: { [DROPPED]: droppedMark }, stakes: STAKES });
  r.seedUnits("sbx-cy", 24);
  const before = r.acts.length;
  await assert.rejects(callUnits("take-back", { thing: DROPPED }, KEY("sbx-cy"), "sbx-cy", r.deps), (e) => e.code === 409 && /24 of 24/.test(e.defect));
  assert.deepEqual(r.ledger, [], "no position moved");
  assert.equal(r.acts.length, before);
  assert.deepEqual(r.withdrawals, []);
});

test("2 · a failed withdrawal is tried again on retry — and only the withdrawal", async () => {
  const r = rig({ marks: { [DROPPED]: droppedMark }, stakes: STAKES });
  r.failWithdrawals(1);
  const first = await callUnits("take-back", { thing: DROPPED }, KEY("sbx-cy"), "sbx-cy", r.deps);
  assert.equal(first.withdrawn.withdrawn, false);
  assert.match(first.withdrawn.retry, /only the withdrawal/);
  const second = await callUnits("take-back", { thing: DROPPED }, KEY("sbx-cy"), "sbx-cy", r.deps);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.withdrawn, { withdrawn: true });
  assert.equal(r.withdrawals.length, 2);
  const third = await callUnits("take-back", { thing: DROPPED }, KEY("sbx-cy"), "sbx-cy", r.deps);
  assert.equal(third.withdrawn.already, true, "once the withdrawal is recorded, nothing asks the pen again");
  assert.equal(r.withdrawals.length, 2);
  assert.equal(totalOf(r.units(), "sbx-cy"), 1, "one unit gained, ever");
  assert.equal(r.ledger.length, 2, "two stakers, two returns, ever");
  assert.equal(r.acts.filter((a) => a.action === UNIT_ACTION.exitWithdrawn).length, 1);
});

test("3 · a failed set-down keeps its slot: another hold cannot take it, and the compensation lands at 24", async () => {
  const CHEST = "sbx-ana/the-bowl";
  const r = rig({ marks: { [CHEST]: { id: CHEST, by: "sbx-ana", class: "chest" } } });
  r.seedUnits("sbx-cy", 24); r.seedUnits(CHEST, 5);
  let raced = null;
  r.onLeave(async () => {
    raced = await callUnits("take", { from: CHEST }, KEY("sbx-cy"), "sbx-cy", r.deps).then(() => "took", (e) => e.defect);
    assert.equal(reservedFor("sbx-cy"), 1, "the slot is held while the filing is in flight");
    return { error: "bounce", defect: "the mark pass tripped" };
  });
  await assert.rejects(callUnits("drop", { label: LABEL }, KEY("sbx-cy"), "sbx-cy", r.deps), (e) => /back in your hands/.test(e.hint));
  assert.match(String(raced), /24 of 24/, "the racing take was refused, not admitted into the held slot");
  assert.equal(totalOf(r.units(), "sbx-cy"), 24);
  assert.equal(reservedFor("sbx-cy"), 0, "nothing stays reserved once the filing settles");
});

test("3b · a set-down that files releases its slot", async () => {
  const r = rig();
  r.seedUnits("sbx-cy", 2);
  await callUnits("drop", { label: LABEL }, KEY("sbx-cy"), "sbx-cy", r.deps);
  assert.equal(reservedFor("sbx-cy"), 0);
});

test("4 · a carried chest is on its carrier's card, contents and all; its maker still sees it, authorship unmoved", async () => {
  const BAG = "sbx-ana/the-bag";
  const marks = [{ id: BAG, by: "sbx-ana", class: "chest", portable: true }];
  const units = [{ class: "holding", action: UNIT_ACTION.stock, object: BAG, payload: { moves: [{ from: null, to: BAG, label: LABEL, n: 30 }] } }];
  const deps = { classes: view, units: async () => units, attachments: async () => [{ entity: "sbx-cy", target: BAG, policy: "cascade", born_at: "2026-10-13T00:00:00Z" }], marks: async () => marks };
  const carrier = await residentHolds("sbx-cy", deps);
  assert.equal(carrier.chests.length, 1);
  assert.deepEqual([carrier.chests[0].chest, carrier.chests[0].by, carrier.chests[0].held_by, carrier.chests[0].shows], [BAG, "sbx-ana", "sbx-cy", "Test Comets: 30"]);
  assert.equal(carrier.holds.count, 0, "the bag's contents are the bag's, not loose in the carrier's hands");
  const maker = await residentHolds("sbx-ana", deps);
  assert.equal(maker.chests[0].held_by, "sbx-cy");
  assert.equal((await residentHolds("sbx-dee", deps)).chests.length, 0, "a stranger's card has no row");
  assert.equal((await chestsRead(deps)).chests[0].held_by, "sbx-cy", "the map and the card agree");
});

const CHEST = "sbx-ana/the-bowl";
const TOASTER = "sbx-cy/the-toaster";
const thingMarks = { [CHEST]: { id: CHEST, by: "sbx-ana", class: "chest", capacity: 3 }, [TOASTER]: { id: TOASTER, by: "sbx-cy", class: "toaster" },
  "sbx-cy/a-stool": { id: "sbx-cy/a-stool", by: "sbx-cy", class: "thing" }, "sbx-cy/a-tin": { id: "sbx-cy/a-tin", by: "sbx-cy", class: "chest" } };

test("5 · a whole thing goes into a chest: it shares the one capacity, shows in what the chest holds, and leaves the carrier's load", async () => {
  const r = rig({ marks: thingMarks });
  r.seedUnits(CHEST, 2); r.hold("sbx-cy", TOASTER);
  const put = await callUnits("thing-into-chest", { thing: TOASTER, to: CHEST }, KEY("sbx-cy"), "sbx-cy", r.deps);
  assert.equal(liveHolder(r.attachments, TOASTER), CHEST, "the holding edge names the chest");
  assert.equal(holdingsOf(r.attachments, "sbx-cy").length, 0, "no longer in the carrier's hands");
  assert.equal(put.chest.shows, "3 things", "2 candies and a toaster: the nearest common class is thing");
  assert.deepEqual(put.chest.things, [{ thing: TOASTER, class: "toaster" }]);
  // capacity 3 is now full: a unit and a thing are both refused, and nothing moves
  r.seedUnits("sbx-cy", 1); r.hold("sbx-cy", "sbx-cy/a-stool");
  await assert.rejects(callUnits("give", { to: CHEST, label: LABEL }, KEY("sbx-cy"), "sbx-cy", r.deps), /room for 0/);
  await assert.rejects(callUnits("thing-into-chest", { thing: "sbx-cy/a-stool", to: CHEST }, KEY("sbx-cy"), "sbx-cy", r.deps), /no room — 3 of 3/);
  const read = await chestsRead({ classes: view, units: async () => r.acts.filter((a) => a.action.startsWith("units:")), attachments: async () => r.attachments, marks: async () => Object.values(thingMarks) });
  assert.equal(read.chests.find((c) => c.chest === CHEST).shows, "3 things", "the map read counts the toaster too");
});

test("5b · it comes out by a take aimed at the chest — reach, welcome and the carry cap apply", async () => {
  const r = rig({ marks: { ...thingMarks, [CHEST]: { ...thingMarks[CHEST], welcome: "closed" } } });
  r.hold(CHEST, TOASTER);
  await assert.rejects(callUnits("thing-from-chest", { thing: TOASTER, from: CHEST }, KEY("sbx-cy"), "sbx-cy", r.deps), (e) => e.code === 403);
  const r2 = rig({ marks: thingMarks });
  r2.hold(CHEST, TOASTER); r2.seedUnits("sbx-cy", 24);
  await assert.rejects(callUnits("thing-from-chest", { thing: TOASTER, from: CHEST }, KEY("sbx-cy"), "sbx-cy", r2.deps), /24 of 24/);
  assert.equal(liveHolder(r2.attachments, TOASTER), CHEST, "a refused take moves nothing");
  const r3 = rig({ marks: thingMarks });
  r3.hold(CHEST, TOASTER);
  const out = await callUnits("thing-from-chest", { thing: TOASTER, from: CHEST }, KEY("sbx-cy"), "sbx-cy", r3.deps);
  assert.equal(out.holder, "sbx-cy");
  assert.equal(liveHolder(r3.attachments, TOASTER), "sbx-cy");
  await assert.rejects(callUnits("thing-from-chest", { thing: TOASTER, from: CHEST }, KEY("sbx-cy"), "sbx-cy", r3.deps), /is not holding/);
});

test("5c · only what you hold goes in; no chest inside itself, however deep", async () => {
  const r = rig({ marks: thingMarks });
  await assert.rejects(callUnits("thing-into-chest", { thing: TOASTER, to: CHEST }, KEY("sbx-cy"), "sbx-cy", r.deps), /you are not holding/);
  await assert.rejects(callUnits("thing-into-chest", { thing: CHEST, to: CHEST }, KEY("sbx-ana"), "sbx-ana", r.deps), /cannot hold itself/);
  // the bowl sits in the tin; carrying the tin, you cannot put the tin into the bowl
  r.hold("sbx-cy", "sbx-cy/a-tin"); r.hold("sbx-cy/a-tin", CHEST);
  await assert.rejects(callUnits("thing-into-chest", { thing: "sbx-cy/a-tin", to: CHEST }, KEY("sbx-cy"), "sbx-cy", r.deps), /is inside/);
});
