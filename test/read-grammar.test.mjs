// read-grammar.test.mjs — explain:, the read grammar's second move (POS-632).
//
// One table, three doors. These hold: the fixed shape; the tutorial at an
// empty path; an unknown path refused with the list; and COVERAGE: every key a
// bare read can carry has a row, so a new key with no explain reds here by
// name. The world's coverage is the v2 read with every optional block filled;
// the town's is its bare read at each shape. The household's live read needs
// the index rig, so its coverage rides test/foyer-shrink.test.mjs.
//
// Run: node --test test/read-grammar.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

process.env.WORLD_APEX = "1";
const { EXPLAIN, EXPLAIN_DOORS, TUTORIAL, explainAnswer, explainRow, explainPath, keyPaths, unexplained } = await import("../src/read-grammar.mjs");
const { shapeV2 } = await import("../src/world-read-v2.mjs");
const { worldApex } = await import("../src/world-apex.mjs");
const { townApex } = await import("../src/town-apex.mjs");

const NOW = Date.parse("2026-10-15T00:08:00Z");

test("every row has the fixed shape, and changes is one of the three cadences", () => {
  assert.deepEqual(EXPLAIN_DOORS, ["world", "household", "town"]);
  for (const door of EXPLAIN_DOORS) for (const [path, r] of Object.entries(EXPLAIN[door])) {
    assert.equal(typeof r.what, "string", `${door} ${path}: what`);
    assert.ok(r.what.length <= 200, `${door} ${path}: what is one line`);
    assert.equal(typeof r.deeper, "string", `${door} ${path}: deeper`);
    assert.ok(["live", "settled", "weekly"].includes(r.changes), `${door} ${path}: changes`);
    for (const k of Object.keys(r)) assert.ok(["what", "detail", "deeper", "changes"].includes(k), `${door} ${path}: ${k}`);
  }
});

test("explain answers docs in one shape, a wildcard covers data-named keys, and an empty path is the tutorial", () => {
  const who = explainAnswer("world", "who.active");
  assert.deepEqual(Object.keys(who), ["explains", "what", "deeper", "changes"]);
  assert.equal(who.explains, "who.active");
  assert.equal(explainRow("world", "view.NNW"), EXPLAIN.world["view.*"]);
  assert.equal(explainRow("household", "papers.wright"), EXPLAIN.household["papers.*"]);
  const t = explainAnswer("town", "");
  assert.equal(t.tutorial, TUTORIAL);
  assert.match(TUTORIAL, /explain: "<path>"/);
  const bad = explainAnswer("world", "nope.nothing");
  assert.equal(bad.code, 422);
  assert.ok(bad.explainable.includes("who"));
  assert.equal(explainPath({ explain: "" }), "", "an empty explain is present, not absent");
  assert.equal(explainPath({}), null);
});

test("coverage: every key of a full v2 world read, to depth 2, has a row", () => {
  const full = shapeV2({
    deep: null, handle: "wright", standpoint: { x: 1, y: 2, seat: {}, arrival: {}, enters_on_arrival: {} }, spine: [{ id: "a", body: "b" }],
    here: "here", near: { id: "n/m", name: "M", body: "b" }, holdings: ["x"], stancesAwaiting: 3, note: "n", frame: { vessel: "v" }, crossing: 250, nextCrossingIn: "1h 00m",
    air: "air", canon: "S1", nextSettlement: "06:00Z", sinceCrossing: 249,
    happened: { to_you: { complete: true }, around_you: { count: 0, events: [] } },
    viewRows: [{ id: "a/b", name: "B", bearing: "N", band: "close by", distM: 5, weight: 20, lifted: true, image: true }],
    events: [{ id: "e/1", title: "E", place: { name: "P" }, phase: "underway", ends: "2026-10-15T04:00:00Z" }],
    departures: { next: [{ at: "2026-10-15T01:00:00Z", toward: "t/s" }] }, mists: { in_wall: true },
    crowd: Array.from({ length: 10 }, (_, i) => ({ handle: `r${i}`, distance_m: i, bearing: "N", band: "close by" })),
    active: new Map(Array.from({ length: 10 }, (_, i) => [`r${i}`, { action: "say", at: NOW }])), activeUnavailable: "x", nowMs: NOW,
    entries: [{ action: "say" }, { action: "candy" }], handles: ["wright", "rei"], humanHere: ["say"], notYours: [{ action: "build", because: "x" }],
    focus: { a: 1 }, found: { b: 1 }, diagnostics: { law: {} },
  });
  assert.deepEqual(unexplained("world", { ...full, heard: [], renamed: [] }, 2), []);
  assert.ok(keyPaths(full).includes("who.more_active"), "the fixture reaches the capped branch");
});

test("coverage: the town's bare read at every shape has a row for every key", async () => {
  for (const shape of [undefined, "t1", "t2"]) {
    const t = await townApex({}, null, shape ? { readShape: shape } : {});
    assert.ok(!t.error, `the town's bare read answers at ${shape ?? "t0"}`);
    assert.deepEqual(unexplained("town", t, 1), [], `town at ${shape ?? "t0"}`);
  }
});

test("the doors answer explain: before anything is read, and never beside an act or a read", async () => {
  const w = await worldApex({ explain: "now.happened" }, null, {});
  assert.equal(w.explains, "now.happened");
  assert.equal(w.changes, "live");
  assert.equal((await worldApex({ explain: "" }, null, {})).tutorial, TUTORIAL);
  assert.equal((await worldApex({ explain: "who", do: "say" }, null, {})).code, 422);
  assert.equal((await worldApex({ explain: "who", read: "view" }, null, {})).code, 422);
  assert.equal((await townApex({ explain: "reading" }, null, {})).explains, "reading");
  assert.equal((await townApex({ explain: "who" }, null, {})).code, 422, "a world path is not a town path");
});
