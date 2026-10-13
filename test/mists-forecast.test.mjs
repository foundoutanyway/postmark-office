// mists-forecast.test.mjs — WLD-38: WHEN THE MISTS REACH A HOUSEHOLD'S MARKS,
// on the doorstep and on the placement receipt.
//
//   WORLD_CLONE=<tree>/world-clone node --test test/mists-forecast.test.mjs
//
// The World engine is REAL: `tools/world-engine.mjs` is copied from the
// WORLD_CLONE beside this office (CI's pinned world) into a bottled world, so
// `mistsAt` and `mistsHere` are the engine's own; without one every leg skips
// by name. The season is SYNTHETIC: a 2 km box whose front creeps 50 m a
// crossing from crossing 300 (front 0) to 310 (front 500), a 100 m fringe, and
// one 120 m clearing — so every expected crossing below is arithmetic on
// those numbers, and none falls on a keyframe. Synthetic residents and marks;
// no resident data, no store, no box. The placement door is the real
// `leaveMarkViaOffice` writing through the acts-pen stub.
//
// THE NUMBERS. On the east side the clear box's edge stands at 1000 − 50k at
// crossing 300 + k. A footprint whose east edge is at x = 720 is in the FRINGE
// (within 100 m of the wall) once 280 − 50k < 100 → k = 4 → crossing 304, and
// behind the WALL once 1000 − 50k < 720 → k = 6 → crossing 306. Its centre at
// x = 600 would say 307 and 309; a keyframe-only forecast would say 310.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const SOURCE_WORLD = process.env.WORLD_CLONE;
const SOURCE_ENGINE = SOURCE_WORLD ? join(SOURCE_WORLD, "tools", "world-engine.mjs") : null;
const haveEngine = !!(SOURCE_ENGINE && existsSync(SOURCE_ENGINE));
const skip = !haveEngine && "no WORLD_CLONE (the World engine is copied from it)";

// Bottles are left in the OS temp dir: this file deletes nothing.
const repo = mkdtempSync(join(tmpdir(), "wld38-world-"));
const noEngine = mkdtempSync(join(tmpdir(), "wld38-no-engine-"));
const scratch = mkdtempSync(join(tmpdir(), "wld38-db-"));
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (path, text) => { const f = join(repo, path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };

export const MISTS = {
  border_m: { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 },
  clearings_m: [{ id: "glade", x: -950, y: 0, r_m: 120 }],
  fringe_m: 100, wall_sight_m: 20,
  schedule: [{ crossing: 300, front_m: 0, veil: 0.1 }, { crossing: 310, front_m: 500, veil: 0.5 }],
  density: { from: 0.5, to: 0.9, power: 1 },
};
const box = (id, by, x, y, w, h, extra = {}) => ({ id, by, kind: "sited", tier: "market", household: by, at: { x, y }, extent: { w, h }, body: id, ...extra });
const MARKS = {
  edge: box("mira/east-shed", "mira", 600, 0, 240, 10),                    // east edge 720, centre 600
  ring: { id: "mira/east-spit", by: "mira", kind: "sited", tier: "market", household: "mira", at: { x: 610, y: 0 }, extent: { w: 220, h: 40 },
    points: [[500, -20], [720, 0], [500, 20], [500, -20]], body: "a spit" },  // one vertex at 720
  glade: box("mira/glade-hut", "mira", -950, 0, 10, 10),                   // deep inside the clearing
  twin: box("mira/west-hut", "mira", -950, 300, 10, 10),                   // the same x, outside it
  inner: box("mira/middle-well", "mira", 0, 0, 10, 10),                    // the front never comes near
  ola: box("ola/east-mill", "ola", 600, 50, 240, 10),                      // Mira's housemate
  zed: box("zed/east-barn", "zed", 600, -50, 240, 10),                     // another household
};
const PUBLISHED = [
  { id: "the-town/let-there-be-light", by: "the-town", kind: "sited", tier: "constitution", at: { x: 0, y: 0 }, extent: { w: 8000, h: 8000 }, body: "the world frame" },
  ...Object.values(MARKS),
];

if (haveEngine) { mkdirSync(join(repo, "tools"), { recursive: true }); copyFileSync(SOURCE_ENGINE, join(repo, "tools", "world-engine.mjs")); }
put("tools/world-build.mjs", `export function assembleWorld({ worldState, skeleton }) { return { ...worldState, skeleton }; }\n`);
put("tools/where-is.mjs", `
export const NOWHERE = Object.freeze({ x: null, y: null, placed: false, source: null, mark_id: null });
export function homeOf() { return { ...NOWHERE }; }
export function whereIs() { return { ...NOWHERE }; }
export function publicResidents() { return []; }
`);
put("tools/world-verbs.mjs", `
export function containmentChain() { return []; }
export function orient() { return { seen: [] }; }
export function investigate() { return null; }
`);
put("tools/marks-fold.mjs", `
export function loadMarks() { return []; }
export const PARCEL_EXTENT_M = 25;
export const PARCEL_CLAIM_CAP = 3;
export const PARCEL_CAP_LAW_DATE = "2026-07-30";
export function marksContain(outer, inner) {
  if (!outer?.at || !outer?.extent || !inner?.at) return false;
  return Math.abs(inner.at.x - outer.at.x) <= outer.extent.w / 2 && Math.abs(inner.at.y - outer.at.y) <= outer.extent.h / 2;
}
export const WORLD_ROOT_SLUG = "let-there-be-light";
export const worldRootOf = (marks) => marks.find((m) => m.slug === WORLD_ROOT_SLUG) ?? null;
export function placementParent() { return null; }
export function containmentParents(marks) { return { parent: new Map(marks.map((m) => [m.id, null])), rootId: null }; }
`);
put("seeding/manifest.json", JSON.stringify({ homes: [] }));
put("WORLD/households.json", JSON.stringify({ households: { mira: "gh:1", ola: "gh:2", zed: "gh:3", kip: "gh:4" } }));
put("WORLD/skeleton.json", JSON.stringify({ features: [], physics_registry: {}, mists: MISTS }));
put("WORLD/world-state.json", JSON.stringify({ tick: 0, dials: {}, marks: PUBLISHED, parcels: [],
  determined: {}, vague: [], rivalries: [], portfolios: {}, terrain_weight: {}, errors: [] }));
git("init", "-q", "-b", "main");
git("config", "user.email", "test@postmark.town"); git("config", "user.name", "WLD-38 falsifier");
git("add", "-A"); git("commit", "-qm", "a bottled world with a synthetic Mists season");

process.env.WORLD_CLONE = repo;
process.env.WORLD_SINGLE_LOG = "1";
process.env.WORLD_DYNAMIC_DB = join(scratch, "dynamic.db");
process.env.W2_GUARDS = ""; process.env.W2_PEN = ""; process.env.TOWN_PUSH = "";
const { installActsPen, uninstallActsPen, RECORD_ON } = await import("./acts-pen-stub.mjs");
process.env.WORLD2_PG = RECORD_ON.WORLD2_PG; process.env.WORLD2_PG_URL = RECORD_ON.WORLD2_PG_URL;
const pen = installActsPen();
after(() => { uninstallActsPen(); delete process.env.WORLD2_PG; delete process.env.WORLD2_PG_URL; });

const { forecastMists, householdMistsForecast, mistsEngine, reachOf, samplesOf, MISTS_FORECAST_UNAVAILABLE } = await import("../src/mists-forecast.mjs");
const { crossingSailsAt } = await import("../src/crossings.mjs");
const { groundRingOf } = await import("../src/world.mjs");
const eng = haveEngine ? await import(pathToFileURL(join(repo, "tools", "world-engine.mjs")).href) : null;
const at = (c) => Date.parse(crossingSailsAt(c));
const dateOf = (c) => crossingSailsAt(c).slice(0, 10);
const fp = (m) => ({ id: m.id, ring: groundRingOf(m) });
const reach = (m, now) => reachOf(eng, MISTS, samplesOf(groundRingOf(m)), now);

// ── the forecast itself, on the real engine ──────────────────────────────────

test("EARLIEST ACTUAL CROSSING, BETWEEN KEYFRAMES: the footprint's edge is reached at 304 (fringe) and 306 (wall) — not the centre's 307/309, not the keyframe's 310", { skip }, () => {
  assert.deepEqual(reach(MARKS.edge, 300), { fringe: 304, wall: 306 });
  assert.deepEqual(reachOf(eng, MISTS, [{ x: 600, y: 0 }], 300), { fringe: 307, wall: 309 }, "the centre alone is later — a clear centre is no proof");
  assert.deepEqual(reach(MARKS.ring, 300), { fringe: 304, wall: 306 }, "a ring is asked by its outline, its one far vertex included");
  assert.deepEqual(reach(MARKS.inner, 300), { fringe: null, wall: null }, "the middle of the town is never reached");
});

test("CLEARINGS ARE THE ENGINE'S: a hut deep in the glade is never reached, while its twin at the same x outside it is walled from 301", { skip }, () => {
  assert.deepEqual(reach(MARKS.glade, 300), { fringe: null, wall: null });
  assert.deepEqual(reach(MARKS.twin, 300), { fringe: 300, wall: 301 });
});

test("ONE CLOCK, SWEPT ACROSS THE ARRIVALS: future tense before, the present at and after, dates by the crossing's own sailing", { skip }, async () => {
  const f = async (c) => (await forecastMists({ engine: eng, skeleton: { mists: MISTS }, footprints: [fp(MARKS.edge)], nowMs: at(c) })).reaches[0];
  const at303 = await f(303);
  assert.deepEqual([at303.fringe, at303.wall], [{ crossing: 304, date: dateOf(304), now: false }, { crossing: 306, date: dateOf(306), now: false }]);
  assert.deepEqual(at303.says, [
    `the fringe of the Mists reaches mira/east-shed from crossing 304 (${dateOf(304)}): sight will be shorter there, nothing hidden, and it stays yours`,
    `the wall of the Mists reaches mira/east-shed from crossing 306 (${dateOf(306)}); it stays yours and comes back when they lift`,
  ]);
  const at304 = await f(304);
  assert.deepEqual([at304.fringe.now, at304.wall.now], [true, false]);
  assert.match(at304.says[0], /stands in the fringe of the Mists now: sight is shorter there, nothing is hidden/);
  const at306 = await f(306);
  assert.deepEqual(at306.says, ["the wall of the Mists stands over mira/east-shed now; it stays yours and comes back when they lift"], "never a future first arrival for what is already there");
  const after = await f(312);                                       // past the last keyframe the front holds
  assert.equal(after.wall.crossing, 312);
  assert.equal(after.wall.now, true);
});

test("FRINGE IS NOT WALL: a footprint the fringe reaches and the wall never does is told its sight shortens, never that it is hidden", { skip }, async () => {
  // the front stops at 500 (crossing 310): an east edge at x = 460 is 40 m inside it — in the fringe, never in the wall
  const near = box("mira/fringe-post", "mira", 450, 0, 20, 10);
  const r = (await forecastMists({ engine: eng, skeleton: { mists: MISTS }, footprints: [fp(near)], nowMs: at(300) })).reaches[0];
  assert.equal(r.wall, null);
  assert.equal(r.fringe.crossing, 309);                             // 1000 − 50k − 460 < 100 → k = 9 (90 m), between keyframes
  assert.equal(r.says.length, 1);
  assert.doesNotMatch(r.says[0], /hidden(?!,)|hides|wall/, "fringe never claims the wall");
  assert.match(r.says[0], /nothing hidden/);
});

test("UNKNOWN IS NEVER CLEAR: no skeleton, no engine, no schedule each say mists-forecast-unavailable; a record with no Mists at all says there is no season", async () => {
  const fps = [fp(MARKS.edge)];
  assert.match((await forecastMists({ engine: eng, skeleton: undefined, footprints: fps })).unavailable, new RegExp(`^${MISTS_FORECAST_UNAVAILABLE}: the world's skeleton could not be read$`));
  assert.match((await forecastMists({ engine: null, skeleton: { mists: MISTS }, footprints: fps })).unavailable, /^mists-forecast-unavailable: the World engine/);
  assert.match((await forecastMists({ engine: eng ?? {}, skeleton: { mists: { ...MISTS, schedule: [] } }, footprints: fps })).unavailable, /^mists-forecast-unavailable: the Mists record carries no schedule/);
  assert.deepEqual(await forecastMists({ engine: eng, skeleton: { features: [] }, footprints: fps }), { season: false }, "absent is not unreadable");
  assert.equal(await mistsEngine(noEngine), null, "a clone with no engine yields no engine, not a guess");
});

// ── the household's doorstep block ──────────────────────────────────────────

const deps = (over = {}) => ({
  pointed: () => true,
  household: async (h) => ({ mira: { residents: ["mira", "ola"] }, ola: { residents: ["mira", "ola"] }, "hh:mira-and-ola": { residents: ["mira", "ola"] } })[h] ?? { residents: [h] },
  publishedMarks: () => PUBLISHED,
  skeleton: () => ({ mists: MISTS }),
  engine: async () => eng,
  ringOf: async (m) => groundRingOf(m),
  ...over,
});

test("THE HOUSEHOLD, NOT ONE HANDLE: Mira's doorstep names her marks AND Ola's, never Zed's; the house's other spelling answers the same", { skip }, async () => {
  const b = await householdMistsForecast("mira", { nowMs: at(300), deps: deps() });
  assert.deepEqual([b.serves, b.args], ["world.mists", { handle: "mira" }]);
  assert.deepEqual(b.reaches.map((r) => r.mark).sort(), ["mira/east-shed", "mira/east-spit", "mira/west-hut", "ola/east-mill"]);
  assert.ok(!JSON.stringify(b).includes("zed/"), "another household's marks never ride here");
  const alias = await householdMistsForecast("hh:mira-and-ola", { nowMs: at(300), deps: deps() });
  assert.deepEqual(alias.reaches.map((r) => r.mark).sort(), b.reaches.map((r) => r.mark).sort());
  assert.equal(await householdMistsForecast("kip", { nowMs: at(300), deps: deps() }), null, "a house the Mists never reach: no key at all");
});

test("PUBLISHED MARKS ONLY: a draft of Mira's in the live layer is not read, on her doorstep or a stranger's", { skip }, async () => {
  const draft = box("mira/secret-shed", "mira", 600, 20, 240, 10);
  let readDrafts = 0;
  const b = await householdMistsForecast("mira", { nowMs: at(300), deps: deps({ publishedMarks: () => PUBLISHED, liveMarks: () => { readDrafts += 1; return [draft]; } }) });
  assert.ok(!JSON.stringify(b).includes("secret-shed"));
  assert.equal(readDrafts, 0, "the block has no road to the live layer");
});

test("NAMED, NEVER EMPTY: an unreadable season on a pointed office is `unavailable`; an office pointed at no world says nothing; nothing is written either way", { skip }, async () => {
  const before = pen.rows().length;
  const u = await householdMistsForecast("mira", { nowMs: at(300), deps: deps({ engine: async () => null }) });
  assert.match(u.unavailable, /^mists-forecast-unavailable: /);
  assert.equal("reaches" in u, false, "no empty, safe-looking list beside it");
  const s = await householdMistsForecast("mira", { nowMs: at(300), deps: deps({ skeleton: () => { throw new Error("torn read"); } }) });
  assert.match(s.unavailable, /^mists-forecast-unavailable: the world's skeleton could not be read$/);
  assert.equal(await householdMistsForecast("mira", { nowMs: at(300), deps: deps({ pointed: () => false }) }), null);
  assert.equal(await householdMistsForecast("mira", { nowMs: at(300), deps: deps({ skeleton: () => ({ features: [] }) }) }), null, "no season: nothing to say");
  assert.equal(pen.rows().length, before, "a forecast writes nothing");
});

test("THE LIVE READ, ON THE BOTTLED WORLD: published state, skeleton and engine read from the clone itself; twice, and at a later clock, derived again — no write", { skip }, async () => {
  const before = pen.rows().length;
  const one = await householdMistsForecast("mira", { nowMs: at(303) });
  const two = await householdMistsForecast("mira", { nowMs: at(303) });
  assert.deepEqual(one, two);
  const shed = one.reaches.find((r) => r.mark === "mira/east-shed");
  assert.deepEqual([shed.fringe.crossing, shed.wall.crossing], [304, 306]);
  const later = (await householdMistsForecast("mira", { nowMs: at(307) })).reaches.find((r) => r.mark === "mira/east-shed");
  assert.deepEqual([later.wall.crossing, later.wall.now], [307, true]);
  assert.equal(pen.rows().length, before);
});

// ── the placement receipt, at the real door ─────────────────────────────────

const keyFor = (household, ...handles) => ({ household, handles: new Set(handles) });
const MIRA = keyFor("mirahouse", "mira");
async function leave(payload, opts = {}, clone = repo) {
  const { leaveMarkViaOffice } = await import("../src/world.mjs");
  try { return { ok: true, ...(await leaveMarkViaOffice(clone, payload, MIRA, opts)) }; }
  catch (e) { return { ok: false, code: e?.code, defect: e?.defect ?? e?.message }; }
}
const written = (id) => pen.rows().filter((r) => r.object === id).length;

test("PLACEMENT · ground the WALL already stands on is WRITTEN and warned (the old door refused it, 422)", { skip }, async () => {
  const out = await leave({ slug: "far-east-post", kind: "sited", by: "mira", at: { x: 900, y: 0 }, extent: { w: 10, h: 10 }, body: "a post at the edge" }, { mistsCrossing: 307 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(written("mira/far-east-post"), 1, "the mark is written");
  assert.deepEqual([out.mists.wall.crossing, out.mists.wall.now], [307, true]);
  assert.deepEqual(out.mists.says, ["the wall of the Mists stands over mira/far-east-post now; it stays yours and comes back when they lift"]);
});

test("PLACEMENT · a future reach is warned with the same forecast the doorstep gives", { skip }, async () => {
  const out = await leave({ slug: "east-shed-two", kind: "sited", by: "mira", at: { x: 600, y: 200 }, extent: { w: 240, h: 10 }, body: "a second shed" }, { mistsCrossing: 303 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([out.mists.fringe.crossing, out.mists.wall.crossing], [304, 306]);
  const door = (await forecastMists({ engine: eng, skeleton: { mists: MISTS }, footprints: [fp(box("mira/east-shed-two", "mira", 600, 200, 240, 10))], nowMs: at(303) })).reaches[0];
  assert.deepEqual(out.mists.says, door.says, "one forecast, one set of words");
});

test("PLACEMENT · ground the Mists never reach adds no `mists` key; the receipt is as it was", { skip }, async () => {
  const out = await leave({ slug: "well-two", kind: "sited", by: "mira", at: { x: 0, y: 20 }, extent: { w: 10, h: 10 }, body: "a well" }, { mistsCrossing: 303 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal("mists" in out, false);
});

test("PLACEMENT · an engine that cannot be read WRITES the valid mark and says mists-forecast-unavailable — not the old season 503", { skip }, async () => {
  const out = await leave({ slug: "blind-post", kind: "sited", by: "mira", at: { x: 900, y: 40 }, extent: { w: 10, h: 10 }, body: "a post placed blind" }, { mistsCrossing: 307 }, noEngine);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(written("mira/blind-post"), 1);
  assert.match(out.mists.unavailable, /^mists-forecast-unavailable: the World engine/);
});

test("PLACEMENT · what the door refused for other reasons it still refuses, and writes nothing", { skip }, async () => {
  const before = pen.rows().length;
  const bad = await leave({ slug: "no-body", kind: "sited", by: "mira", at: { x: 900, y: 80 }, extent: { w: 10, h: 10 } }, { mistsCrossing: 307 });
  assert.equal(bad.ok, false);
  const notYours = await leave({ slug: "zeds-post", kind: "sited", by: "zed", at: { x: 900, y: 120 }, extent: { w: 10, h: 10 }, body: "not mine" }, { mistsCrossing: 307 });
  assert.equal(notYours.ok, false);
  assert.equal(pen.rows().length, before, "no write from a refused placement");
});
