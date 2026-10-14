// amend-carried.test.mjs — the store records which settlement carried each door
// amend (POS-612, migration 075), and the receipt reads it as `last_amended`.
//
//   node --test test/amend-carried.test.mjs      (the store from embedded-postgres)
//
// THE INSTANCE: keith/waiting-room-stool-2026-09-10, first carried at S65, amended
// at the door (claim 08a6b024, candle 244), carried by S104. On 10-14 its receipt
// still read "published at S65 (fc74bf68)" and was misread as an amend that never
// landed. Darko ruled the answer (10-14): `last_amended: { s, sha, at, window }`
// and the sentence "published at S65, last amended at S104".
//
// THE RIG, mark-carried.test.mjs's: a tagged world repo built here (one ANNOTATED
// settlement/S<n> per crossing) and a real Postgres with the whole schema.
//
//   S1  window 101  keith/the-stool, lupi/the-step and wright/the-lamp added
//   S2  window 102  wright/the-gate added; nothing touches the stool or the step
//   S3  window 104  the stool's file amended (window 103 had no settlement)
//   S4  window 105  the step's file changed by a hand commit (POS-446's class)
//   S5  window 106  the lamp's file changed (a marks-ingest amend follows it)
//
// THE DOCKET (door amends are locked claims with `supersedes` set):
//   stool-a  candle 103 → S3, which changed the stool's file: PROVEN, written
//   step-a   candle 102 → S2, which did not change the step's file: UNPROVEN, no row
//   lamp-i   candle 106, `data._ingested_from`: a file-side change, never planned
//   lamp-b   candle 108, past every settled window: UNSETTLED
//   stool-p  pending at candle 107: not a version
//
// THE CAN-FAIL FLIP: in amend-carried.mjs § planAmendsCarried, drop the proof
// (`const ok = prev != null`). "APPLY writes the proven amend and nothing else"
// goes red: step-a is written at S2, a settlement that never carried it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startStore } from "./helpers/embedded-store.mjs";
import {
  planAmendsCarried, proofFrom, recordAmendsCarried, verifyAmendsCarried, amendsLine, isDoorAmend, HAND_CARRIED, TICK_CAP,
} from "../world2/tools/amend-carried.mjs";
import { amendsOnTick } from "../world2/tools/settlements-backfill.mjs";
import { readMarkReceipt } from "../src/mark-receipt.mjs";
import { twinReceipt } from "../src/world2-serve.mjs";
import { __setPoolForTest } from "../src/world2-claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "..", "world2", "schema", "075_amend_carried.sql");

// ── the world ────────────────────────────────────────────────────────────────

const world = mkdtempSync(join(tmpdir(), "postmark-amend-carried-"));
after(() => rmSync(world, { recursive: true, force: true }));
let clock = Date.parse("2026-09-20T06:00:00Z");
const git = (...a) => execFileSync("git", ["-C", world, ...a], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_COMMITTER_DATE: new Date(clock).toISOString(), GIT_AUTHOR_DATE: new Date(clock).toISOString(), TZ: "UTC" },
});
const put = (p, t) => { const f = join(world, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); };
const markPath = (id) => `WORLD/marks/${id}/mark.md`;
const body = (id, note) => `---\nby: ${id.split("/")[0]}\n---\n${id}: ${note}\n`
  + [...id].map((ch, i) => `${i} ${ch.charCodeAt(0) * (i + 7)} ${id.split("").reverse().join("")}`).join("\n") + "\n";
const ids = new Set();
const SHA = {};
function settle(n, { add = [], amend = [] } = {}) {
  for (const id of add) { put(markPath(id), body(id, "declared")); ids.add(id); }
  for (const id of amend) put(markPath(id), body(id, `amended at S${n}`));
  put("WORLD/world-state.json", JSON.stringify({ marks: [...ids].sort().map((id) => ({ id })) }, null, 1));
  git("add", "-A");
  git("-c", "user.name=crossing", "-c", "user.email=c@t.invalid", "commit", "-q", "--allow-empty", "-m", `settlement: S${n}`);
  git("-c", "user.name=the Worldkeeper", "-c", "user.email=k@t.invalid", "tag", "-a", "-m", `S${n}`, `settlement/S${n}`);
  SHA[n] = git("rev-parse", `settlement/S${n}^{commit}`).trim();
  clock += 12 * 3600e3;
}
const STOOL = "keith/the-stool", STEP = "lupi/the-step", LAMP = "wright/the-lamp";
git("init", "-q", "-b", "main");
settle(1, { add: [STOOL, STEP, LAMP] });
settle(2, { add: ["wright/the-gate"] });
settle(3, { amend: [STOOL] });
settle(4, { amend: [STEP] });
settle(5, { amend: [LAMP] });
const WINDOW_OF = { 1: 101, 2: 102, 3: 104, 4: 105, 5: 106 };

// The store is started before any test is declared: a top-level await between
// tests lets the root's `after` hooks run early, and the world above would go.
const store = await startStore({ db: "amend_carried_test" });
const skip = store.skip ?? false;
after(async () => { if (!skip) await store.stop(); });

// ── the pure half ────────────────────────────────────────────────────────────

const SETTLED = Object.entries(WINDOW_OF).map(([n, w]) => ({ number: Number(n), window_id: w }));
const amend = (over) => ({ id: "a", slug: STOOL, status: "locked", window_id: 103, supersedes: "s0", ingested: false, ...over });
const proves = (yes) => () => yes;

test("plan: the lowest settlement whose window is at or after the amend's, written only when proven", () => {
  const plan = planAmendsCarried({ amends: [amend()], settlements: SETTLED, proof: proves(true) });
  assert.deepEqual(plan, [{ claim: "a", mark: STOOL, window: 103, state: "new", settlement: 3 }], "window 103 had no settlement; S3 closed 104");
});

test("plan: an unproven candidate is named with its settlement and gets no row", () => {
  const plan = planAmendsCarried({ amends: [amend()], settlements: SETTLED, proof: proves(false) });
  assert.deepEqual(plan.map((p) => [p.state, p.candidate, p.prev]), [["unproven", 3, 2]]);
});

test("plan: past every settled window is unsettled; a claim with a row is never planned again", () => {
  assert.equal(planAmendsCarried({ amends: [amend({ window_id: 120 })], settlements: SETTLED, proof: proves(true) })[0].state, "unsettled");
  assert.deepEqual(planAmendsCarried({ amends: [amend()], have: new Set(["a"]), settlements: SETTLED, proof: proves(true) }), []);
});

test("plan: only door amends — no marks-ingest row, no seed, no claim that is not locked", () => {
  const rows = [amend({ id: "i", ingested: true }), amend({ id: "s", supersedes: null }), amend({ id: "x", slug: null }),
    ...["pending", "refused", "retracted", "held_review"].map((status) => amend({ id: status, status }))];
  assert.equal(rows.filter(isDoorAmend).length, 0);
  assert.deepEqual(planAmendsCarried({ amends: rows, settlements: SETTLED, proof: proves(true) }), []);
});

test("plan: POS-446's five are 075's to write, never the window rule's", () => {
  for (const h of HAND_CARRIED) {
    const [p] = planAmendsCarried({ amends: [amend({ id: h.mark, slug: h.mark, window_id: h.window })], settlements: SETTLED, proof: proves(true) });
    assert.equal(p.state, "hand", h.mark);
  }
});

test("POS-446 · the tool's five and 075's five are the same five, at the same candles", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const inSql = [...sql.matchAll(/ARRAY\['([^']+)', '(\d+)'\]/g)].map((m) => `${m[1]}@${m[2]}`).sort();
  assert.deepEqual(inSql, HAND_CARRIED.map((h) => `${h.mark}@${h.window}`).sort());
  assert.deepEqual(HAND_CARRIED.map((h) => h.mark).sort(), [
    "berthillon/cone-peche-de-vigne-2026-08-27", "berthillon/cone-poire-williams-2026-09-15",
    "lupi/the-unworn-step", "vermillion/pagani-huayra", "vermillion/pagani-zonda"]);
  assert.match(sql, /'10e5b194acffedab9c5a6177ba6dc7f4360fcf96'/, "the hand commit, whole");
});

test("the proof: a settlement proves an amend only when it changed the mark's file", () => {
  const prove = proofFrom(world);
  assert.equal(prove(STOOL, 3, 2), true, "S3 changed the stool");
  assert.equal(prove(STOOL, 2, 1), false, "S2 did not");
  assert.equal(prove(STEP, 2, 1), false, "the step's candidate S2 did not change it");
  assert.equal(prove(STEP, 4, 3), true, "S4 did, by hand");
  assert.equal(prove("nobody/never-was", 3, 2), false, "no file is no proof");
  assert.equal(prove(STOOL, 99, 3), false, "no tag is no proof");
});

// ── the store ────────────────────────────────────────────────────────────────

async function owner(fn) { const c = await store.connect("world2_owner"); try { return await fn(c); } finally { await c.end(); } }
async function asApi(fn) { const c = await store.connect("office_api"); try { return await fn(c); } finally { await c.end(); } }
const rowsNow = () => owner(async (c) => (await c.query("SELECT mark, settlement, by_hand FROM amend_carried ORDER BY mark, settlement")).rows
  .map((r) => `${r.mark}@S${r.settlement}${r.by_hand ? " by hand" : ""}`));

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C = { stool0: uuid(1), stoolA: uuid(2), step0: uuid(3), stepA: uuid(4), lamp0: uuid(5), lampI: uuid(6), lampB: uuid(7), stoolP: uuid(8) };

async function seed() {
  await owner(async (c) => {
    for (let w = 101; w <= 108; w++) {
      const closes = new Date(Date.parse("2026-09-20T06:00:00Z") + (w - 101) * 12 * 3600e3);
      await c.query("INSERT INTO windows (id, opens_at, closes_at, status) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
        [w, new Date(closes - 12 * 3600e3), closes, w <= 106 ? "closed" : "open"]);
    }
    for (const [n, w] of Object.entries(WINDOW_OF))
      await c.query("INSERT INTO settlements (number, tag_sha, published_at, window_id) VALUES ($1, $2, $3, $4) ON CONFLICT (number) DO NOTHING",
        [Number(n), SHA[n], new Date(Date.parse("2026-09-20T06:00:30Z") + (Number(n) - 1) * 12 * 3600e3), w]);
    const claim = (id, slug, w, status, supersedes = null, data = {}) => c.query(
      `INSERT INTO claims (id, window_id, class, claimant, household, status, decided_at, body, stake, data, slug, supersedes)
       VALUES ($1, $2, 'thing', $3, $4, $5, now(), 'a thing', 1, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [id, w, slug.split("/")[0], `hh:${slug.split("/")[0]}`, status, data, slug, supersedes]);
    await claim(C.stool0, STOOL, 101, "locked");
    await claim(C.step0, STEP, 101, "locked");
    await claim(C.lamp0, LAMP, 101, "locked");
    await claim(C.stoolA, STOOL, 103, "locked", C.stool0);
    await claim(C.stepA, STEP, 102, "locked", C.step0);
    // lamp-b first: the twin reads the NEWEST claim to decide whether a mark is
    // carried, and a lamp whose newest claim is locked past the settled window
    // would read as locked, not published.
    await claim(C.lampB, LAMP, 108, "locked", C.lamp0);
    await claim(C.lampI, LAMP, 106, "locked", C.lamp0, { _ingested_from: { sha: SHA[5], ref: "settlement/S5" } });
    await claim(C.stoolP, STOOL, 107, "pending", C.stoolA);
    // the first carriage, as 049 records it
    for (const id of [STOOL, STEP, LAMP])
      await c.query("INSERT INTO mark_carried (mark, settlement, added_sha) VALUES ($1, 1, $2) ON CONFLICT (mark) DO NOTHING", [id, SHA[1]]);
  });
}

test("FRESH STORE: 075 applied on empty claims writes no POS-446 row", { skip }, async () => {
  assert.deepEqual(await rowsNow(), []);
});

test("APPLY writes the proven amend and nothing else; the line names the unproven one and its candidate", { skip }, async () => {
  await seed();
  const r = await asApi((c) => recordAmendsCarried(c, world, { apply: true }));
  assert.equal(r.verdict, "ok");
  assert.deepEqual(await rowsNow(), [`${STOOL}@S3`], "step-a's candidate S2 never changed its file, so no row");
  assert.deepEqual(r.by_settlement, { 3: 1 });
  assert.deepEqual([r.new, r.unproven, r.unsettled, r.hand], [1, 1, 1, 0]);
  const line = amendsLine(r);
  assert.match(line, /^amends: wrote 1 \(S3: 1\); the table holds 1/);
  assert.match(line, /unproven: lupi\/the-step \(candle 102 → S2\)/);
});

test("a second apply writes nothing, and the pen holds no UPDATE or DELETE", { skip }, async () => {
  const r = await asApi((c) => recordAmendsCarried(c, world, { apply: true }));
  assert.equal(r.wrote, 0);
  assert.deepEqual(await rowsNow(), [`${STOOL}@S3`]);
  await asApi(async (c) => {
    await assert.rejects(c.query("UPDATE amend_carried SET settlement = 4"), (e) => e.code === "42501");
    await assert.rejects(c.query("DELETE FROM amend_carried"), (e) => e.code === "42501");
  });
});

test("VERIFY re-proves every row, and reds on a row git does not prove", { skip }, async () => {
  assert.equal((await asApi((c) => verifyAmendsCarried(c, world))).verdict, "ok");
  await owner((c) => c.query("INSERT INTO amend_carried (claim, mark, settlement) VALUES ($1, $2, 2)", [C.stepA, STEP]));
  const v = await asApi((c) => verifyAmendsCarried(c, world));
  assert.equal(v.verdict, "DRIFT");
  assert.deepEqual(v.disagree.map((d) => d.mark), [STEP]);
  assert.match(v.disagree[0].why[0], /git does not prove S2 changed the file/);
  await owner((c) => c.query("DELETE FROM amend_carried WHERE claim = $1", [C.stepA]));
});

test("THE TWO DOORS read one row: the twin and 1.0 both say \"published at S1, last amended at S3\"", { skip }, async () => {
  const { default: pg } = await import("pg");
  const p = new pg.Pool({ connectionString: store.url("office_api"), max: 2 });
  const env = { WORLD2_PG: process.env.WORLD2_PG, WORLD2_PG_URL: process.env.WORLD2_PG_URL };
  try {
    const two = await twinReceipt(p, STOOL, { standing: true });
    assert.equal(two.status, "published");
    assert.equal(two.crossing.s, 1, "crossing stays the first carriage");
    assert.deepEqual(two.last_amended, { s: 3, sha: SHA[3], at: "2026-09-21T06:00:30Z", window: 103 });
    assert.equal(two.says, "published at S1, last amended at S3");

    process.env.WORLD2_PG = "1"; process.env.WORLD2_PG_URL = store.url("office_api");
    __setPoolForTest(p);
    const one = await readMarkReceipt(STOOL, { repo: world, canon: { id: STOOL }, publishedSha: SHA[5] });
    assert.deepEqual(one.last_amended, two.last_amended);
    assert.equal(one.says, two.says);
    assert.equal(one.crossing.s, 1);

    const lamp = await twinReceipt(p, LAMP, { standing: true });
    assert.equal(lamp.last_amended, null, "an ingested amend and an unsettled one name nothing");
    assert.match(lamp.says, /^published at S1 \([0-9a-f]{8}\)/, "and the sentence is today's");
  } finally {
    __setPoolForTest(null);
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await p.end();
  }
});

test("THE TICK: settlements-backfill's amends step writes on the keep tick and journals one line", { skip }, async () => {
  await owner((c) => c.query("TRUNCATE amend_carried"));
  const t = await asApi((c) => amendsOnTick(c, world));
  assert.equal(t.verdict, "ok");
  assert.match(t.line, /^amends: wrote 1 \(S3: 1\)/);
  const capped = await asApi((c) => recordAmendsCarried(c, world, { apply: true, cap: 0 }));
  assert.equal(capped.verdict, "skipped");
  assert.match(amendsLine(capped), /amend-carried\.mjs --apply/);
  assert.equal(TICK_CAP, 200);
});

// ── POS-446's five, written by 075 itself (G5, G9) ───────────────────────────

const runMigration = () => owner(async (c) => {
  try { await c.query(readFileSync(MIGRATION, "utf8")); }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
});
const FIVE_WINDOWS = [207, 212, 229, 239];

test("POS-446 · a store holding the five claims but not S100: 075 RAISES and writes nothing", { skip }, async () => {
  await owner(async (c) => {
    for (const w of FIVE_WINDOWS)
      await c.query("INSERT INTO windows (id, opens_at, closes_at, status) VALUES ($1, now(), now(), 'closed') ON CONFLICT (id) DO NOTHING", [w]);
    let i = 100;
    for (const h of HAND_CARRIED) {
      await c.query(`INSERT INTO claims (id, window_id, class, claimant, status, stake, slug, supersedes) VALUES ($1, $2, 'thing', $3, 'locked', 1, $4, NULL)`,
        [uuid(i), h.window, h.mark.split("/")[0], h.mark]);
      await c.query(`INSERT INTO claims (id, window_id, class, claimant, status, stake, slug, supersedes, data) VALUES ($1, $2, 'thing', $3, 'locked', 1, $4, $5, '{}')`,
        [uuid(i + 1), h.window, h.mark.split("/")[0], h.mark, uuid(i)]);
      i += 2;
    }
  });
  await assert.rejects(runMigration(), /settlement 100 is not in settlements/);
  assert.equal((await rowsNow()).filter((r) => r.endsWith("by hand")).length, 0);
});

test("POS-446 · with S100, 075 writes all five at S100 by hand, naming POS-446 and the whole commit", { skip }, async () => {
  await owner((c) => c.query("INSERT INTO settlements (number, tag_sha, published_at, window_id) VALUES (100, $1, '2026-10-09T18:01:11Z', 239)", ["1".repeat(40)]));
  await runMigration();
  const hand = await owner(async (c) => (await c.query("SELECT mark, settlement, by_hand, issue FROM amend_carried WHERE issue = 'POS-446' ORDER BY mark")).rows);
  assert.deepEqual(hand.map((r) => r.mark), HAND_CARRIED.map((h) => h.mark).sort());
  for (const r of hand) {
    assert.equal(r.settlement, 100, r.mark);
    assert.equal(r.by_hand, "10e5b194acffedab9c5a6177ba6dc7f4360fcf96", r.mark);
  }
  await runMigration();   // idempotent
  assert.equal((await rowsNow()).filter((r) => r.endsWith("by hand")).length, 5);
  const v = await asApi((c) => verifyAmendsCarried(c, world));
  assert.equal(v.hand, 5, "hand rows are counted, never re-proved");
});

test("POS-446 · VERIFY reds when a store holds the five's claims and not their rows", { skip }, async () => {
  await owner((c) => c.query("DELETE FROM amend_carried WHERE issue = 'POS-446'"));
  const v = await asApi((c) => verifyAmendsCarried(c, world));
  assert.equal(v.verdict, "DRIFT");
  assert.equal(v.disagree.filter((d) => /075 owes it/.test(d.why[0])).length, 5);
  await runMigration();
  assert.equal((await asApi((c) => verifyAmendsCarried(c, world))).verdict, "ok");
});

test("POS-446 · a doubled amend for one of the five: 075 RAISES", { skip }, async () => {
  const h = HAND_CARRIED[0];
  await owner((c) => c.query(`INSERT INTO claims (id, window_id, class, claimant, status, stake, slug, supersedes) VALUES ($1, $2, 'thing', 'berthillon', 'locked', 1, $3, $4)`,
    [uuid(200), h.window, h.mark, uuid(100)]));
  await assert.rejects(runMigration(), /2 door amends for berthillon\/cone-peche-de-vigne-2026-08-27 at candle 229/);
  // Left in place: a claim the public docket carried is never deleted (the docket's own trigger).
});

test("075 NOT APPLIED: the tick says so in one line, and both doors disclose rather than answer null", { skip }, async () => {
  await owner((c) => c.query("DROP TABLE amend_carried"));
  const t = await asApi((c) => amendsOnTick(c, world));
  assert.equal(t.verdict, "absent");
  const { default: pg } = await import("pg");
  const p = new pg.Pool({ connectionString: store.url("office_api"), max: 2 });
  const env = { WORLD2_PG: process.env.WORLD2_PG, WORLD2_PG_URL: process.env.WORLD2_PG_URL };
  try {
    const two = await twinReceipt(p, STOOL, { standing: true });
    assert.equal(two.last_amended, null);
    assert.equal(two.amends?.readable, false);
    assert.match(two.amends.reason, /075 not applied/);
    assert.match(two.says, /^published at S1 \([0-9a-f]{8}\)/);
    // 1.0 discloses the same way: null is never "never amended" when unread.
    process.env.WORLD2_PG = "1"; process.env.WORLD2_PG_URL = store.url("office_api");
    __setPoolForTest(p);
    const one = await readMarkReceipt(STOOL, { repo: world, canon: { id: STOOL }, publishedSha: SHA[5] });
    assert.equal(one.last_amended, null);
    assert.equal(one.amends?.readable, false);
    assert.match(one.amends.reason, /075 not applied/);
  } finally {
    __setPoolForTest(null);
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await p.end();
  }
});
