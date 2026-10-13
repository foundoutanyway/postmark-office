// bevel-followup-boundaries.test.mjs — Bevel's follow-up FIRST REVIEW (2026-10-13T04:20Z) probes,
// carried VERBATIM from /tmp/bevel-wld27-fu-1pdkiln2/test/bevel-followup-boundaries.test.mjs (red at 9896d619: 98 tests, 95 pass, 3 fail).
// Corrections A (the dropped-act reference) and B (out read before held).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStore } from './helpers/embedded-store.mjs';
import { recoverOrphanDrops, dropsStillOut, dropMarkId } from '../src/drop-recovery.mjs';
import { foldUnits, totalOf } from '../src/world-stacks.mjs';
import { callUnits, classViewOf } from '../src/world-units.mjs';
import { appendActFlipped } from '../src/world-journal.mjs';
import { __setPoolForTest } from '../src/world2-pen.mjs';
import { RECORD_ON } from './acts-pen-stub.mjs';
import { currentCrossing } from '../src/crossings.mjs';

const store = await startStore({ db: 'bevel_followup_boundaries' });
const skip = store.skip ?? false;
const ACTOR = 'sbx-cy', HH = 'hh:sbx-cy', LABEL = 'test-comets', CHEST = 'sbx-ana/review-chest';
let pool;
after(async () => { __setPoolForTest(null); if (pool) await pool.end(); await store.stop(); });
async function owner(fn) { const c = await store.connect('world2_owner'); try { return await fn(c); } finally { await c.end(); } }
async function office(fn) { const c = await store.connect('office_api'); try { return await fn(c); } finally { await c.end(); } }
async function seed() {
  await owner(async c => {
    await c.query('TRUNCATE acts, claims, marks, windows, settlements, households, household_pins CASCADE');
    await c.query("INSERT INTO windows (id,opens_at,closes_at,status) VALUES (300,now()-interval '1 day',now()+interval '1 day','open')");
    await c.query("INSERT INTO households (slug,ord,name,residents,since,declared_by) VALUES ('sbx-cy',0,'Synthetic Cy',ARRAY['sbx-cy'],'2026-08-01','sbx-cy')");
    await c.query("INSERT INTO household_pins (handle,login,gh_id,pinned) VALUES ('sbx-cy','sbx-cy',931,'2026-08-01')");
  });
}
const give = (to, n) => owner(c => c.query(
  "INSERT INTO acts (at,crossing,actor,action,object,class,payload,household) VALUES (now()-interval '1 day',300,'the-town','units:give',$1,'holding',$2,'the-town')",
  [to, JSON.stringify({ units: true, moves: [{ from: null, to, label: LABEL, n }] })]));
const drop = () => owner(async c => (await c.query(
  "INSERT INTO acts (at,crossing,actor,action,object,class,payload,household) VALUES (now()-interval '30 minutes',300.1,$1,'units:drop',$1,'holding',$2,$3) RETURNING id::text",
  [ACTOR, JSON.stringify({ units: true, label: LABEL, moves: [{ from: ACTOR, to: null, label: LABEL, n: 1 }] }), HH])).rows[0].id);
const claim = (slug, data) => owner(c => c.query(
  `INSERT INTO claims (window_id,class,claimant,household,status,body,geometry,bbox,stake,data,slug)
   VALUES (300,'sited',$1,$2,'draft','Synthetic review claim.','{"at":{"x":3,"y":4},"extent":{"w":1,"h":1}}','((2.5,3.5),(3.5,4.5))',0,$3,$4)`,
  [ACTOR, HH, JSON.stringify(data), slug]));
const rows = () => owner(async c => (await c.query("SELECT id::text,class,action,actor,household,payload FROM acts WHERE action LIKE 'units:%' ORDER BY acts.id")).rows);
const held = async () => totalOf(foldUnits(await rows()), ACTOR);

test('Bevel F0: exact dropped-act reference prevents recovery regardless of claim slug', { skip }, async () => {
  await seed(); await give(ACTOR, 1); const id = await drop();
  await claim(`${ACTOR}/a-different-name`, { class: 'candy', label: LABEL, dropped: `act:${id}` });
  const r = await office(c => recoverOrphanDrops(c, {}));
  assert.deepEqual(r.restored, [], 'a real claim for this exact act is not an orphan just because its slug differs');
  assert.equal(await held(), 0, 'one ground unit must not also reappear in hands');
});

test('Bevel F0: an unrelated claim at the predicted slug cannot stand in for the dropped unit', { skip }, async () => {
  await seed(); await give(ACTOR, 1); const id = await drop();
  await claim(dropMarkId({ actor: ACTOR, label: LABEL, actId: id }), { class: 'thing' });
  const r = await office(c => recoverOrphanDrops(c, {}));
  assert.deepEqual(r.restored.map(x => x.act), [id], 'match the act reference, not an unrelated private thing with the predicted name');
  assert.equal(await held(), 1, 'the actual orphan comes back');
});

test('Bevel F0: tick recovery between unit snapshot and durable-out query cannot admit a 25th unit', { skip }, async () => {
  await seed(); await give(ACTOR, 24); await drop(); await give(CHEST, 5);
  assert.equal(await held(), 23);
  if (!pool) { const { default: pg } = await import('pg'); pool = new pg.Pool({ connectionString: store.url('office_api') }); }
  Object.assign(process.env, RECORD_ON); __setPoolForTest(pool);
  const classes = new Map(Object.entries({
    mark: { extends: null, dials: {} }, thing: { extends: 'mark', dials: { carry_cap: 24 } },
    consumable: { extends: 'thing', dials: {} }, chest: { extends: 'thing', dials: { capacity: 30, welcome: true } },
    candy: { extends: 'consumable', dials: {}, labels: [{ label: LABEL, name: 'Synthetic comets', creator: 'sbx-ana' }] },
  }));
  let recovered;
  const deps = {
    classes: () => classViewOf({ classes }), readRows: async () => ({ units: await rows(), attachments: [] }),
    markById: async id => id === CHEST ? { id, by: 'sbx-ana', class: 'chest', capacity: 30 } : null,
    reachTake: async () => ({}), householdOf: null,
    dropsOut: async h => {
      recovered = await office(c => recoverOrphanDrops(c, {}));
      assert.equal(recovered.restored.length, 1, 'tick restores the missing unit after the earlier unit snapshot');
      return office(async c => { await c.query('BEGIN READ ONLY'); try { return await dropsStillOut(c, h); } finally { await c.query('COMMIT'); } });
    },
    append: (e, opts = {}) => appendActFlipped(null, { ...e, writtenAt: new Date().toISOString() }, opts),
    stamp: async () => ({ at: null, witnesses: null }), crossing: () => currentCrossing(), household: () => HH,
  };
  let result, error;
  try { result = await callUnits('take', { from: CHEST, count: 1 }, { handles: new Set([ACTOR]) }, ACTOR, deps); }
  catch (e) { error = e; }
  const actual = await held();
  assert.equal(actual, 24, `current authoritative carry must stay24; actual${actual}, response${JSON.stringify(result)}, error${error?.message}`);
  assert.equal(error?.code, 409, `the additional take must refuse at the now-full cap; caught ${error?.message}, result ${JSON.stringify(result)}`);
});
