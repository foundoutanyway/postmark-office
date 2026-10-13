// chest-stock.test.mjs — WLD-27: the first stock of a chest, in a real store.
//
//   node --test test/chest-stock.test.mjs
//
// A real Postgres (test/helpers/embedded-store.mjs) with the whole schema, the
// stock written as `office_api` — the pen the settlement tick holds — against
// SYNTHETIC candy labels in `law_projection` (never the town's assignments).
// What it proves, each in the store's own terms:
//   · a settlement admitting chests stocks each with min(30, capacity), once;
//   · a replay or retry writes nothing more (the plan, and the nonce index);
//   · a maker with no label is admitted unstocked, named, and not counted;
//   · a later label stocks that chest at the next tick, exactly once;
//   · units already in a chest are kept, and the stock never overfills it.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { startStore } from "./helpers/embedded-store.mjs";
import { stockChests, stockNonce, TOWN_PEN, TOWN_HOUSEHOLD } from "../world2/tools/chest-stock.mjs";
import { stockedOnTick } from "../world2/tools/settlements-backfill.mjs";
import { foldUnits, totalOf, edgesOf, UNIT_ACTION } from "../src/world-stacks.mjs";

const store = await startStore({ db: "chest_stock_test" });
after(() => store.stop());
const skip = store.skip ?? false;
const WIN = 250;
const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
const CHEST_DIALS = { capacity: 30, capacity_min: 1, capacity_max: 120, first_stock: 30, portable: true, welcome: "open" };
const LABELS_A = [{ label: "test-comets", name: "Test Comets", creator: "sbx-ana" }];
const LABELS_B = [...LABELS_A, { label: "test-eves", name: "Test Eves", creator: "sbx-eve" }];

let n = 0;
const uuid = () => `c0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const box = (at) => `((${at.x - 1},${at.y - 1}),(${at.x + 1},${at.y + 1}))`;

async function owner(fn) { const c = await store.connect("world2_owner"); try { return await fn(c); } finally { await c.end(); } }
async function asOffice(fn) { const c = await store.connect("office_api"); try { return await fn(c); } finally { await c.end(); } }

async function law(c, sha, number, labels) {
  for (const [key, data] of [["candy", { class: "candy", extends: "consumable", dials: {}, labels }], ["chest", { class: "chest", extends: "thing", dials: CHEST_DIALS }], ["thing", { class: "thing", extends: "mark", dials: { carry_cap: 24 } }]])
    await c.query("INSERT INTO law_projection (law_sha, kind, path, key, data) VALUES ($1, 'class', $2, $3, $4)", [sha, `WORLD/${key}/mark.md`, key, JSON.stringify(data)]);
  await c.query("INSERT INTO settlements (number, tag_sha, published_at, window_id) VALUES ($1, $2, now(), $3)", [number, sha, WIN]);
}

async function chest(c, slug, data = {}) {
  const id = uuid(), at = { x: 10 * n, y: 0 };
  const owner = slug.split("/")[0];
  const geometry = JSON.stringify({ at, extent: { w: 2, h: 2 } }), d = JSON.stringify({ class: "chest", by: owner, ...data });
  await c.query(`INSERT INTO claims (id, window_id, class, claimant, household, status, decided_at, body, geometry, bbox, stake, data, slug)
                 VALUES ($1, $2, 'sited', $3, $4, 'locked', now(), 'A chest.', $5, $6::box, 1, $7, $8)`, [id, WIN, owner, `hh:${owner}`, geometry, box(at), d, slug]);
  await c.query(`INSERT INTO marks (id, slug, kind, owner, household, body, geometry, bbox, status, locked_window, data)
                 VALUES ($1, $2, 'sited', $3, $4, 'A chest.', $5, $6::box, 'standing', $7, $8)`, [id, slug, owner, `hh:${owner}`, geometry, box(at), WIN, d]);
}

async function seed() {
  await owner(async (c) => {
    await c.query("TRUNCATE acts, claims, marks, settlements, law_projection, windows CASCADE");
    await c.query(`INSERT INTO windows (id, opens_at, closes_at, status, cleared_at) VALUES ($1, now() - interval '12 hours', now(), 'closed', now())`, [WIN]);
    await law(c, SHA_A, 250, LABELS_A);
    await chest(c, "sbx-ana/the-bowl");
    await chest(c, "sbx-ana/the-thimble", { capacity: 1 });
    await chest(c, "sbx-ana/the-tub", { capacity: 120 });
    await chest(c, "sbx-eve/her-chest", { capacity: 20 });
  });
}
const units = () => owner(async (c) => (await c.query("SELECT id, class, action, object, payload, actor, household, nonce FROM acts WHERE action LIKE 'units:%' ORDER BY at, id")).rows);

test("a settlement's chests are stocked min(30, capacity), once; the unlabelled maker's chest is admitted unstocked and named", { skip }, async () => {
  await seed();
  const r = await asOffice((c) => stockChests(c, { crossing: 250.5 }));
  assert.deepEqual(r.stocked.map((s) => [s.chest, s.n]).sort(), [["sbx-ana/the-bowl", 30], ["sbx-ana/the-thimble", 1], ["sbx-ana/the-tub", 30]]);
  assert.match(r.line, /chest-unstocked: sbx-eve has no candy label/);
  const rows = await units();
  assert.equal(rows.length, 3);
  for (const a of rows) {
    assert.deepEqual([a.action, a.actor, a.household, a.nonce], [UNIT_ACTION.stock, TOWN_PEN, TOWN_HOUSEHOLD, stockNonce(a.object)]);
    assert.equal(a.payload.settlement, 250);
  }
  const fold = foldUnits(rows);
  assert.deepEqual(edgesOf(fold, "sbx-ana/the-bowl"), [{ label: "test-comets", count: 30 }]);
  assert.equal(totalOf(fold, "sbx-eve/her-chest"), 0, "admitted, not stocked, and not counted as stocked");

  // the replay: the tick runs again, and again — nothing more is written
  const again = await asOffice((c) => stockChests(c, { crossing: 250.6 }));
  assert.deepEqual(again.stocked, []);
  assert.equal((await units()).length, 3);
});

test("the nonce index is the second wall: a racing insert of the same stock writes nothing", { skip }, async () => {
  await seed();
  await asOffice((c) => stockChests(c, { crossing: 250.5 }));
  const dup = await asOffice((c) => c.query(
    `INSERT INTO acts (at, crossing, actor, action, object, class, payload, effect, household, nonce)
     VALUES (now(), 250.7, $1, $2, 'sbx-ana/the-bowl', 'holding', '{"units":true,"moves":[{"from":null,"to":"sbx-ana/the-bowl","label":"test-comets","n":30}]}', 'x', $3, $4)
     ON CONFLICT DO NOTHING RETURNING id`, [TOWN_PEN, UNIT_ACTION.stock, TOWN_HOUSEHOLD, stockNonce("sbx-ana/the-bowl")]));
  assert.equal(dup.rows.length, 0);
  assert.equal(totalOf(foldUnits(await units()), "sbx-ana/the-bowl"), 30);
});

test("a label registered later stocks the unstocked chest at the next tick, once, keeping what was given into it", { skip }, async () => {
  await seed();
  await asOffice((c) => stockChests(c, { crossing: 250.5 }));
  // someone gave 4 units into Eve's empty chest meanwhile
  await asOffice((c) => c.query(`INSERT INTO acts (at, crossing, actor, action, object, class, payload, effect, household)
     VALUES (now(), 250.8, 'sbx-cy', $1, 'sbx-eve/her-chest', 'holding', '{"units":true,"moves":[{"from":null,"to":"sbx-eve/her-chest","label":"test-comets","n":4}]}', 'a give', 'hh:sbx-cy')`, [UNIT_ACTION.give]));
  await owner((c) => law(c, SHA_B, 251, LABELS_B));
  const r = await asOffice((c) => stockChests(c, { crossing: 251.5 }));
  assert.deepEqual(r.stocked.map((s) => [s.chest, s.label, s.n]), [["sbx-eve/her-chest", "test-eves", 16]], "min(30, 20) less the 4 already in it");
  assert.doesNotMatch(r.line, /chest-unstocked/);
  assert.equal((await asOffice((c) => stockChests(c, { crossing: 251.6 }))).stocked.length, 0);
  assert.deepEqual(edgesOf(foldUnits(await units()), "sbx-eve/her-chest"), [{ label: "test-comets", count: 4 }, { label: "test-eves", count: 16 }]);
});

test("the tick's step is non-fatal: an error is one named line", { skip }, async () => {
  const r = await stockedOnTick(null, { stock: async () => { throw new Error("no store"); }, crossing: () => 1 });
  assert.deepEqual([r.verdict, r.line], ["error", "chests: NOT stocked (non-fatal) — no store"]);
});

test("a whole thing already in a chest takes its slot: the first stock fills only the room left", { skip }, async () => {
  await seed();
  // before the tick, the toaster went into the 20-slot chest of a labelled maker
  await owner((c) => law(c, SHA_B, 251, LABELS_B));
  await asOffice((c) => c.query(`INSERT INTO acts (at, crossing, actor, action, object, class, payload, effect, household)
     VALUES (now() - interval '1 minute', 250.9, 'sbx-cy', 'give', 'sbx-cy/the-toaster', 'holding',
             '{"thing":"sbx-cy/the-toaster","holder":"sbx-eve/her-chest","previous_holder":"sbx-cy","made_by":"sbx-cy","policy":"cascade"}', 'into the chest', 'hh:sbx-cy')`));
  const r = await asOffice((c) => stockChests(c, { crossing: 251.5 }));
  assert.deepEqual(r.stocked.filter((s) => s.chest === "sbx-eve/her-chest").map((s) => s.n), [19], "min(30, 20) less the toaster's one slot");
});
