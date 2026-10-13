// paper-read-through.test.mjs — a paper act's OWN readback at the household door shows what the pen wrote (POS-603).
//
//   node --test --test-concurrency=1 test/paper-read-through.test.mjs
//
// Found by neth (POS-603): a paper act (address, home, profile, window) answers
// done once the pen has committed the record, while the household door's own
// reads still answered from the office's older read index. The freshness ladder
// (src/paper-fresh.mjs) already composes the written record over the index; three
// household-door reads were never handed its context:
//
//   G1  household { read: "address" } on office.db (the store's branch had it)
//   G2  household { read: "home" }, both indexes
//   G3  the papers check (paperGapRows): "tend your HOME page" after the page
//       was tended — on the bare household read and read: "standing"
//
// WHAT RUNS. The real household apex (householdApex), the real paper doors
// (edit.mjs through paperDoor/penTransaction), the real freshFor and the real
// composed readers and hydration parsers, over:
//   · the suite's synthetic office.db (test/fixture.mjs, fixed literals), whose
//     index is never rebuilt here, so every pen write leaves it STALE;
//   · a fresh synthetic town checkout per test (fixed literals, a temp dir, a
//     local bare origin for the push case), never a real clone;
//   · the store variant through the suite's embedded store
//     (test/helpers/office-under-test.mjs § indexStore), seeded from that same
//     office.db, never an env-named database.
// Injected, and only these: the world block (a fixed `null`, so no world read
// is attempted) for the standing read. Nothing here pushes beyond the temp
// origin, reads a real record, or calls an office endpoint.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

delete process.env.TOWN_INDEX_READS;
delete process.env.TOWN_PUSH; // set only inside the push-refusal test, against its temp origin
delete process.env.TOWN_SINGLE_LOG;
delete process.env.WORLD2_PG;
delete process.env.WORLD2_PG_URL;

const { fixtureDb } = await import("./fixture.mjs");
const { tempDir } = await import("./helpers/temp-dir.mjs");
const { indexStore, testIndex } = await import("./helpers/office-under-test.mjs");
const { householdApex } = await import("../src/household-apex.mjs");
const { openOauthDb } = await import("../src/oauth.mjs");
const { ensureTownJournal } = await import("../src/town-journal.mjs");
const { TENSE } = await import("../src/paper-fresh.mjs");

const scratch = tempDir("postmark-pos603-");
const dbPath = join(scratch, "office.db");
fixtureDb(dbPath).close();
// Two index states, set on the fixture's own rows (no row is invented):
//   · NO INDEXED HOME: limen's home row is REMOVED, so limen has a card and no page;
//   · A BLANK INDEXED PAGE: wright's row keeps its title and loses its description,
//     which is what the papers check reads as "owed".
{
  const w = new DatabaseSync(dbPath);
  w.prepare("DELETE FROM homes WHERE handle = ?").run("limen");
  const row = JSON.parse(w.prepare("SELECT json FROM homes WHERE handle = ?").get("wright").json);
  w.prepare("UPDATE homes SET json = ? WHERE handle = ?").run(JSON.stringify({ ...row, description: "" }), "wright");
  w.close();
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const IX = await indexStore(dbPath);
const STORE = testIndex() === "store";
after(async () => { db.close(); await IX.stop(); });

// ── fixtures: fixed literals only ──────────────────────────────────────────
const GIT = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@postmark.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@postmark.invalid" };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, ...GIT } });
let seq = 0;
/** A town checkout whose paper AGREES with the fixture index (wright's and limen's ADDRESS cards); no HOME, PROFILE or window file. */
function townClone({ origin = false } = {}) {
  const root = join(scratch, `town-${++seq}`);
  const dir = join(root, "clone");
  mkdirSync(join(dir, "WHITE_PAGES", "wright"), { recursive: true });
  mkdirSync(join(dir, "WHITE_PAGES", "limen"), { recursive: true });
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "WHITE_PAGES", "wright", "ADDRESS.md"), "---\nsince: 2026-05-12\njoined: 2026-07-01\ngithub: keeminlee\n---\n\n# wright\n");
  writeFileSync(join(dir, "WHITE_PAGES", "limen", "ADDRESS.md"), "---\nsince: 2026-06-20\njoined: 2026-06-25\n---\n\n# limen\n");
  writeFileSync(join(dir, "tools", "households.json"), JSON.stringify({ schema_version: 1, households: {} }, null, 2) + "\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture town");
  if (origin) {
    const bare = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "origin", "main");
    git(dir, "branch", "-q", "--set-upstream-to=origin/main");
    // the origin refuses every push: the pen's write cannot land
    writeFileSync(join(bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  return dir;
}
function townLog() {
  const o = openOauthDb(join(scratch, `oauth-${++seq}.db`));
  ensureTownJournal(o);
  return o;
}
const keyFor = (...handles) => ({ household: `house-${handles[0]}`, handles: new Set(handles), ghId: "42", ghLogin: "keeminlee" });
const ctxFor = (clone, odb = null) => ({ db, clone, odb, dbPath, schemas: {}, schemaRequired: {}, canWrite: true, worldBlock: async () => null });
const act = (verb, handle, args, clone, odb = null, key = keyFor(handle)) => householdApex({ do: verb, handle, args: { handle, ...args } }, key, ctxFor(clone, odb));
const read = (what, handle, clone, odb = null, key = keyFor(handle), extra = {}) => householdApex({ read: what, ...(handle ? { handle } : {}), ...extra }, key, ctxFor(clone, odb));
const okAct = (r, what) => { assert.equal(r.error, undefined, `${what}: ${JSON.stringify(r).slice(0, 300)}`); assert.ok(r.result, what); return r.result; };
const gapsOf = (ans, h) => ans?.papers?.[h]?.gaps ?? [];
const owesHome = (gaps) => gaps.some((g) => /tend your HOME page/.test(g));

const HOME = { title: "the Lantern Workshop", body: "Benches, sawdust and a lamp that never goes out." };
const WINDOW_HTML = '<!doctype html><html><body><script type="application/json" id="window-state">{"lamp":"lit"}</script></body></html>';

/** Every scenario on both indexes: office.db, then (where the suite has one) the store. */
function both(name, fn) {
  test(`${name} [office.db]`, () => fn());
  test(`${name} [store]`, { skip: STORE ? false : "OFFICE_TEST_INDEX=office: no store variant in this run" }, async () => {
    const restore = await IX.useInProcess();
    try { await fn(); } finally { await restore(); }
  });
}

// ═══ G1 · the card: address and profile ═════════════════════════════════════

both("G1 · do: address → read: address shows the written body, stamped written", async () => {
  const clone = townClone();
  const before = await read("address", "wright", clone);
  assert.equal(before.address.address.body, "# wright", "the index and the record agree to start with");
  assert.equal(before.address.freshness.fields["address.body"].tense, TENSE.settled);
  okAct(await act("address", "wright", { body: "a bench by the north window" }, clone), "address");
  const after = await read("address", "wright", clone);
  assert.equal(after.address.address.body, "a bench by the north window", "the owner's own read shows the record the pen wrote");
  assert.equal(after.address.freshness.fields["address.body"].tense, TENSE.written);
  assert.equal(after.address.freshness.fields["address.body"].file, "WHITE_PAGES/wright/ADDRESS.md");
  assert.equal(after.address.freshness.fields.profile.tense, TENSE.settled, "a field nobody touched stays settled");
});

both("G1 · do: profile → its own read (the card's profile) shows the written profile, stamped written", async () => {
  const clone = townClone();
  okAct(await act("profile", "wright", { bio: "keeps the lamp trimmed" }, clone), "profile");
  const after = await read("address", "wright", clone);
  assert.match(JSON.stringify(after.address.profile), /keeps the lamp trimmed/);
  assert.equal(after.address.freshness.fields.profile.tense, TENSE.written);
});

// ═══ G2 · the home page ═════════════════════════════════════════════════════

both("G2 · do: home → read: home shows the written title and body, stamped written", async () => {
  const clone = townClone();
  const before = await read("home", "wright", clone);
  assert.equal(before.home.title, "the Trueing-House", "the index's page to start with");
  assert.equal(before.home.description, "", "…with the blank description this file's index holds");
  assert.equal(before.home.freshness.fields.home.tense, TENSE.settled);
  okAct(await act("home", "wright", HOME, clone), "home");
  const after = await read("home", "wright", clone);
  assert.equal(after.home.title, HOME.title);
  assert.equal(after.home.description, HOME.body);
  assert.equal(after.home.freshness.fields.home.tense, TENSE.written);
  assert.equal(after.home.freshness.fields.home.act, "home");
  assert.equal(after.home.region, "the-terrace", "placement is never composed");
});

both("G2 · flag-on: the act's own row makes the same read PENDING, with its seq", async () => {
  process.env.TOWN_SINGLE_LOG = "1";
  try {
    const clone = townClone();
    const odb = townLog();
    const done = okAct(await act("home", "wright", HOME, clone, odb), "home");
    assert.ok(done.logged?.seq, "the act wrote its row");
    const after = await read("home", "wright", clone, odb);
    assert.equal(after.home.description, HOME.body);
    assert.equal(after.home.freshness.fields.home.tense, TENSE.pending);
    assert.equal(after.home.freshness.fields.home.seq, done.logged.seq);
  } finally { delete process.env.TOWN_SINGLE_LOG; }
});

// THE OPEN CASE (reported, not fixed here): a home FOUNDED by the act, for a
// resident the index holds no home row for. Both home readers answer null
// before they compose (queries.mjs § home, town-index-store.mjs § home), so
// threading the context cannot reach it. This test pins today's answer so the
// day it changes is a deliberate one.
both("NO INDEXED HOME (open): a page founded by the act is not yet on read: home, and the papers still ask for it", async () => {
  const clone = townClone();
  okAct(await act("home", "limen", HOME, clone), "home founds limen's page");
  assert.ok(readFileSync(join(clone, "WHITE_PAGES", "limen", "HOME", "HOME.md"), "utf8").includes(HOME.body), "the record holds it");
  const r = await read("home", "limen", clone);
  assert.equal(r.code, 404, "today: no index row, no compose");
  assert.equal(owesHome(gapsOf(await read("standing", null, clone, null, keyFor("limen")), "limen")), true, "today: still owed");
});

// ═══ G3 · the papers check ══════════════════════════════════════════════════

both("G3 · after do: home the papers stop asking for the page — read: standing and the bare household read", async () => {
  const clone = townClone();
  const owed = await read("standing", null, clone, null, keyFor("wright"));
  assert.equal(owesHome(gapsOf(owed, "wright")), true, "the index's blank page is owed to start with (the check is live, not vacuous)");
  okAct(await act("home", "wright", HOME, clone), "home, tended");
  const standing = await read("standing", null, clone, null, keyFor("wright"));
  assert.equal(owesHome(gapsOf(standing, "wright")), false, "read: standing");
  const bare = await householdApex({}, keyFor("wright"), ctxFor(clone));
  assert.equal(owesHome(gapsOf(bare, "wright")), false, "the bare household read");
});

// ═══ window: already read-through — a regression control, not a new fix ════

both("window (control) · do: window → read: window shows the hand-set state, stamped written", async () => {
  const clone = townClone();
  okAct(await act("window", "wright", { html: WINDOW_HTML }, clone), "window");
  const w = await read("window", "wright", clone);
  assert.deepEqual(w.window, { lamp: "lit" });
  assert.equal(w.freshness.fields.window.tense, TENSE.written);
});

// ═══ no false done, and no false freshness ══════════════════════════════════

both("a bounced act writes nothing and the read stays settled", async () => {
  const clone = townClone();
  const r = await act("home", "wright", { ...HOME, colour: "teal" }, clone);
  assert.equal(r.error, "bounce", "an unknown field is refused by name");
  const after = await read("home", "wright", clone);
  assert.equal(after.home.title, "the Trueing-House");
  assert.equal(after.home.freshness.fields.home.tense, TENSE.settled);
  assert.equal(git(clone, "status", "--porcelain").trim(), "");
});

both("a push the origin refuses is not done: the clone is put back and the read stays settled", async () => {
  process.env.TOWN_PUSH = "1";
  try {
    const clone = townClone({ origin: true });
    const headBefore = git(clone, "rev-parse", "HEAD").trim();
    const r = await act("home", "wright", HOME, clone);
    assert.ok(r.error, `refused, not done: ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(git(clone, "rev-parse", "HEAD").trim(), headBefore, "no local commit left behind");
    const after = await read("home", "wright", clone);
    assert.equal(after.home.title, "the Trueing-House");
    assert.equal(after.home.freshness.fields.home.tense, TENSE.settled);
  } finally { delete process.env.TOWN_PUSH; }
});

both("NO-OP, TWO STATES: repeating a written edit is unchanged AND still written; matching the index is unchanged AND settled", async () => {
  const clone = townClone();
  okAct(await act("address", "wright", { body: "a bench by the north window" }, clone), "first");
  const again = okAct(await act("address", "wright", { body: "a bench by the north window" }, clone), "again");
  assert.equal(again.unchanged, true, "the second call changed nothing");
  const r = await read("address", "wright", clone);
  assert.equal(r.address.address.body, "a bench by the north window");
  assert.equal(r.address.freshness.fields["address.body"].tense, TENSE.written, "unchanged is not settled: the index is still behind the record");

  const fresh = townClone();
  const same = okAct(await act("address", "wright", { body: "# wright" }, fresh), "same as the index");
  assert.equal(same.unchanged, true);
  const s = await read("address", "wright", fresh);
  assert.equal(s.address.freshness.fields["address.body"].tense, TENSE.settled);
});

both("a nonce retry is one edit and one receipt; the read shows it once", async () => {
  process.env.TOWN_SINGLE_LOG = "1";
  try {
    const clone = townClone();
    const odb = townLog();
    const first = okAct(await act("home", "wright", { ...HOME, nonce: "n-603" }, clone, odb), "first");
    const second = okAct(await act("home", "wright", { ...HOME, nonce: "n-603" }, clone, odb), "retry");
    assert.equal(second.duplicate, true);
    assert.equal(second.commit, first.commit);
    assert.equal(Number(git(clone, "rev-list", "--count", "HEAD").trim()), 2, "the fixture commit and ONE edit");
    const r = await read("home", "wright", clone, odb);
    assert.equal(r.home.description, HOME.body);
  } finally { delete process.env.TOWN_SINGLE_LOG; }
});

// ═══ the gates stay as they were ════════════════════════════════════════════

both("ASK, DON'T GUESS: a key holding two residents is asked whose home, not answered", async () => {
  const clone = townClone();
  const r = await read("home", null, clone, null, keyFor("wright", "limen"));
  assert.equal(r.code, 422);
  assert.match(r.defect, /whose home\?/);
});

both("another household's read of the card is the composed public card, as REST's /residents/{h} already is", async () => {
  const clone = townClone();
  okAct(await act("address", "wright", { body: "a bench by the north window" }, clone), "address");
  const r = await read("address", "wright", clone, null, keyFor("limen"));
  assert.equal(r.address.address.body, "a bench by the north window");
  assert.equal(r.address.freshness.fields["address.body"].tense, TENSE.written);
});
