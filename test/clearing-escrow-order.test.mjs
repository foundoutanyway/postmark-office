// clearing-escrow-order.test.mjs — THE CANDLE'S ESCROW GATE JUDGES AGAINST THE
// WINDOW'S RESULT (WLD-51; Darko, 2026-10-14: "the settlement's order is always
// town, then sovereign (parcels), then market").
//
//   node --test test/clearing-escrow-order.test.mjs
//
// Step 5.5 used to walk the standing rows AND every claim, so a claim moving a
// standing parcel stood in the walk twice, at its old place and its new one. A
// ✦0 commons claim passed as `home` on either rect: inside the old one though the
// parcel was leaving, or inside the new one though step 5.7 then refused the
// move. The store locked a ✦0 commons mark the world's sweep never publishes.
//
// THE RIG is carry-at-the-clearing.test.mjs's: a real Postgres
// (test/helpers/embedded-store.mjs) and the real `clearing-job.mjs` run as a
// child under the `clearing_job` pen. Rei's parcel stands at (1000, 1000), and a
// claim moves it to (1100, 960). Two ✦0 sheds of Rei's are claimed in the same
// window: one at the parcel's old place, one at its new place.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startStore } from "./helpers/embedded-store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOB = join(ROOT, "world2", "tools", "clearing-job.mjs");
const TOWN_SHA = "t".repeat(40);
const LAW_SHA = "l".repeat(40);
const WIN = 240;

const store = await startStore({ db: "escrow_order_test" });
after(() => store.stop());
const skip = store.skip ?? false;

const IDS = {
  parcel: "b0000000-0000-4000-8000-000000000001",
  house: "b0000000-0000-4000-8000-000000000002",
  stone: "b0000000-0000-4000-8000-000000000003",
};
const box = (at, ext) => `((${at.x - ext.w / 2},${at.y - ext.h / 2}),(${at.x + ext.w / 2},${at.y + ext.h / 2}))`;
const OLD = { x: 1000, y: 1000 }, NEW = { x: 1100, y: 960 }, FAR = { x: 5000, y: 5000 };

async function seed({ refuseTheMove = false } = {}) {
  const c = await store.connect("world2_owner");
  try {
    await c.query("TRUNCATE escrow_projection, claims, marks, windows, projection_heads, households, household_pins CASCADE");
    for (const id of [WIN - 1, WIN]) {
      const opens = new Date(Date.UTC(2026, 9, 6, 18) + (id - WIN + 1) * 12 * 3600e3).toISOString();
      await c.query(
        `INSERT INTO windows (id, opens_at, closes_at, status, cleared_at)
         VALUES ($1, $2, $2::timestamptz + interval '12 hours', $3, $4)`,
        [id, opens, id === WIN ? "open" : "closed", id === WIN ? null : opens]);
    }
    await c.query("INSERT INTO projection_heads (repo, sha, ingested_at) VALUES ('world-law', $1, now()), ('town', $2, now())", [LAW_SHA, TOWN_SHA]);
    await c.query(
      `INSERT INTO households (slug, ord, name, residents, since, declared_by)
       VALUES ('starforge', 0, 'Starforge', ARRAY['rei'], '2026-08-01', 'rei'),
              ('rabbit', 1, 'Rabbit', ARRAY['sable'], '2026-08-01', 'sable')`);
    await c.query(
      `INSERT INTO household_pins (handle, login, gh_id, pinned)
       VALUES ('rei', 'rei', 201, '2026-08-01'), ('sable', 'sable', 204, '2026-08-01')`);
    const mark = async (id, slug, kind, owner, household, at, ext) => {
      const geometry = JSON.stringify({ at, extent: ext }), d = JSON.stringify({ tier: "home" });
      await c.query(
        `INSERT INTO claims (id, window_id, class, claimant, household, status, decided_at, body, geometry, bbox, stake, data, slug)
         VALUES ($1, $2, $3, $4, $5, 'locked', now(), $6, $7, $8::box, 0, $9, $10)`,
        [id, WIN - 1, kind, owner, household, `${slug}.`, geometry, box(at, ext), d, slug]);
      await c.query(
        `INSERT INTO marks (id, slug, kind, owner, household, body, geometry, bbox, status, locked_window, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::box, 'standing', $9, $10)`,
        [id, slug, kind, owner, household, `${slug}.`, geometry, box(at, ext), WIN - 1, d]);
    };
    await mark(IDS.parcel, "rei/the-parcel", "parcel", "rei", "hh:starforge", OLD, { w: 25, h: 25 });
    await mark(IDS.house, "rei/the-house", "sited", "rei", "hh:starforge", OLD, { w: 10, h: 10 });
    // somebody's stake on another mark, so the escrow read is a real answer
    // (an empty projection reports every commons claim UNCHECKED and refuses none)
    await mark(IDS.stone, "sable/the-stone", "sited", "sable", "hh:rabbit", { x: 9000, y: 9000 }, { w: 1, h: 1 });
    await c.query(
      `INSERT INTO escrow_projection (town_sha, mark, holder, household, own_household, n, weight_k)
       VALUES ($1, 'sable/the-stone', 'rei', 'hh:starforge', 'hh:rabbit', 1, 0)`, [TOWN_SHA]);
    const claim = async (slug, kind, at, ext, supersedes = null) => (await c.query(
      `INSERT INTO claims (window_id, class, claimant, household, status, body, geometry, bbox, stake, data, slug, supersedes)
       VALUES ($1, $2, 'rei', 'hh:starforge', 'pending', $3, $4, $5::box, 0, '{"date":"2026-10-08"}', $6, $7)
       RETURNING id::text`,
      [WIN, kind, `${slug}.`, JSON.stringify({ slug, at, extent: ext }), box(at, ext), slug, supersedes])).rows[0].id;
    const ids = {
      move: await claim("rei/the-parcel", "parcel", NEW, { w: 25, h: 25 }, IDS.parcel),
      oldShed: await claim("rei/the-old-shed", "sited", OLD, { w: 4, h: 4 }),
      newShed: await claim("rei/the-new-shed", "sited", NEW, { w: 4, h: 4 }),
      bench: await claim("rei/the-far-bench", "sited", FAR, { w: 1, h: 1 }),
    };
    // A rider with its own claim waiting refuses the move (5.7, ALL OR NOTHING).
    if (refuseTheMove) ids.house = await claim("rei/the-house", "sited", OLD, { w: 10, h: 10 }, IDS.house);
    return ids;
  } finally { await c.end(); }
}

function clear() {
  const r = spawnSync(process.execPath, [JOB, "--window", String(WIN)], {
    cwd: ROOT, encoding: "utf8",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WORLD2_CLEARING_URL: store.url("clearing_job") },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
async function statusOf(id) {
  const c = await store.connect("world2_owner");
  try {
    const { rows: [row] } = await c.query("SELECT status, refusal_check FROM claims WHERE id = $1", [id]);
    return row ? `${row.status}${row.refusal_check ? `: ${row.refusal_check}` : ""}` : null;
  } finally { await c.end(); }
}

test("THE MOVE LOCKS: a ✦0 shed at the parcel's NEW place locks home; one at the place it LEFT is a commons mark with nothing staked, refused", { skip }, async () => {
  const ids = await seed();
  const run = clear();
  assert.equal(run.code, 0, run.out);
  assert.equal(await statusOf(ids.move), "locked");
  assert.equal(await statusOf(ids.newShed), "locked");
  assert.match(await statusOf(ids.oldShed), /^refused: escrow-absent/, "the parcel left that ground in this window");
  assert.match(await statusOf(ids.bench), /^refused: escrow-absent/, "the control: open ground, nothing staked");
});

test("THE MOVE IS REFUSED (5.7): the shed at the parcel's OLD place locks home; the one at the place it never reached is refused", { skip }, async () => {
  const ids = await seed({ refuseTheMove: true });
  const run = clear();
  assert.equal(run.code, 0, run.out);
  assert.match(await statusOf(ids.move), /^refused: carry:/);
  assert.equal(await statusOf(ids.oldShed), "locked", "the parcel stayed, so its old ground still holds the shed");
  assert.match(await statusOf(ids.newShed), /^refused: escrow-absent/, "a move 5.7 refused lends no ground");
  assert.match(await statusOf(ids.bench), /^refused: escrow-absent/);
});
