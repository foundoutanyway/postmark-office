// arrival-entries.test.mjs — a walk's enter_on_arrival is queued at the walk and
// made at arrival by the office's tick (WLD-5, POS-618; src/arrival-entries.mjs).
//
// RULED (Darko, 2026-10-14 10:20 EDT): "delaying the row on the ledger until
// they actually arrive at the thing, while still affording residents the
// convenience of being able to say: I want to enter at the time I arrive." And
// at 11:27: a pre-check that would not enter queues nothing (G2); the walker
// reads a pending entry and a refusal on their own standpoint (G3); any later
// departure overtakes the intent (G4).
//
// The tick is driven here with its store, its clock and its enter injected;
// test/arrival-entries-store.test.mjs drives the same SQL against a real store,
// and the pen's never-twice guard through the real crossing-exec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ARRIVAL_OUTCOMES, arrivalLine, arrivalOutcome, arrivalTick, enterAtArrival, entryAtTheWalk,
  precheckVerdict, startArrivalTick, stopArrivalTick,
} from "../src/arrival-entries.mjs";
import { enterViaOffice } from "../src/world-crossings.mjs";
import { NO_WORLD, worldClone } from "./fixture-paths.mjs";

// ── a store the tick can be driven against ──────────────────────────────────

function queue(rows) {
  const settled = [];
  const query = async (text, params) => {
    if (/FROM arrival_entries\s+WHERE settled_at IS NULL AND due_at <= \$1/.test(text)) {
      const now = Date.parse(params[0]);
      return rows.filter((r) => !r.settled && Date.parse(r.due_at) <= now).slice(0, params[1]);
    }
    if (/^\s*UPDATE arrival_entries/.test(text)) {
      const r = rows.find((x) => String(x.walk) === params[0] && !x.settled);
      if (!r) return [];
      r.settled = { outcome: params[1], enter_act_id: params[2], words: params[3] };
      settled.push({ walk: params[0], ...r.settled });
      return [{ walk: params[0] }];
    }
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  };
  return { query, settled };
}
const row = (walk, extra = {}) => ({ walk: String(walk), handle: "ann", household: "ann-house", mark: "a/room",
  accept: false, into_mark: null, due_at: "2026-10-14T12:00:00.000Z", ...extra });
const NOW = Date.parse("2026-10-14T12:00:05.000Z");
const bounce = (code, defect, hint, extra = {}) => Object.assign(new Error(defect), { code, defect, hint, ...extra });

// ── AT ARRIVAL: the tick ─────────────────────────────────────────────────────

test("OVERTAKEN — a later departure replaces the intent: settled overtaken, nothing entered (Darko, G4)", async () => {
  const q = queue([row(10)]);
  let entered = 0;
  const r = await arrivalTick({ now: NOW, query: q.query, current: async () => "11", arrival: async () => ({ arrived: true }),
    enter: async () => { entered += 1; return { answer: { entered: ["a/room"] }, seq: "1" }; } });
  assert.deepEqual(q.settled, [{ walk: "10", outcome: "overtaken", enter_act_id: null, words: null }]);
  assert.equal(entered, 0, "an overtaken intent never reaches the enter");
  assert.deepEqual(r.overtaken, ["10"]);
});

test("STILL WALKING — due by the clock but not arrived by the walk record: left for the next tick, nothing entered", async () => {
  const q = queue([row(10)]);
  let entered = 0;
  const r = await arrivalTick({ now: NOW, query: q.query, current: async () => "10", arrival: async () => ({ arrived: false }),
    enter: async () => { entered += 1; } });
  assert.deepEqual(q.settled, []);
  assert.equal(entered, 0);
  assert.deepEqual(r.walking, ["10"]);
});

test("ENTERED — the walk stands and has arrived: the ordinary enter runs, and the row is settled with its act", async () => {
  const q = queue([row(10)]);
  const seen = [];
  await arrivalTick({ now: NOW, query: q.query, current: async () => "10", arrival: async (r) => ({ arrived: true, target: { x: 1, y: 2 }, r }),
    enter: async (r, a) => { seen.push({ walk: r.walk, target: a.target }); return { answer: { entered: ["a/room"] }, seq: "77" }; } });
  assert.deepEqual(seen, [{ walk: "10", target: { x: 1, y: 2 } }]);
  assert.deepEqual(q.settled, [{ walk: "10", outcome: "entered", enter_act_id: "77", words: null }]);
});

test("REFUSED AT ARRIVAL — the mark's word changed on the way: settled refused in its own words, and nothing else is written", async () => {
  const q = queue([row(10)]);
  await arrivalTick({ now: NOW, query: q.query, current: async () => "10", arrival: async () => ({ arrived: true }),
    enter: async () => { throw bounce(422, "a/room is opposed to you", "it answers everyone the same"); } });
  assert.deepEqual(q.settled, [{ walk: "10", outcome: "refused", enter_act_id: null, words: "a/room is opposed to you — it answers everyone the same" }]);
});

test("HELD — the pen busy or the store away: the row waits, and the next tick enters", async () => {
  const q = queue([row(10)]);
  let busy = true;
  const deps = { now: NOW, query: q.query, current: async () => "10", arrival: async () => ({ arrived: true }),
    enter: async () => { if (busy) throw bounce(503, "the office pen is busy — other writes hold the town lock"); return { answer: { entered: ["a/room"] }, seq: "78" }; } };
  const first = await arrivalTick(deps);
  assert.deepEqual(q.settled, [], "a 503 is not a refusal");
  assert.equal(first.held.length, 1);
  busy = false;
  await arrivalTick(deps);
  assert.deepEqual(q.settled, [{ walk: "10", outcome: "entered", enter_act_id: "78", words: null }]);
});

test("NEVER TWICE — a re-run whose enter the pen already holds is settled as that enter, not written again", async () => {
  const q = queue([row(10)]);
  await arrivalTick({ now: NOW, query: q.query, current: async () => "10", arrival: async () => ({ arrived: true }),
    enter: async () => { throw bounce(409, "walk 10 was already entered on arrival, by act 55", "nothing was written a second time", { arrival_settled: "55" }); } });
  assert.deepEqual(q.settled, [{ walk: "10", outcome: "entered", enter_act_id: "55", words: null }]);
});

test("RESTART CATCH-UP — rows that fell due while the office was down are entered at the tick's first run, at boot", async () => {
  const q = queue([row(10, { due_at: "2026-10-14T09:00:00.000Z" }), row(11, { handle: "bea", due_at: "2026-10-14T10:30:00.000Z" })]);
  const calls = [];
  const tick = async () => { calls.push("tick"); return arrivalTick({ now: NOW, query: q.query, current: async (h) => (h === "ann" ? "10" : "11"),
    arrival: async () => ({ arrived: true }), enter: async (r) => ({ answer: { entered: [r.mark] }, seq: `9${r.walk}` }) }); };
  try {
    assert.equal(startArrivalTick({ port: 4380, env: { WORLD2_PG: "1", WORLD2_PG_URL: "postgres://x/y" }, log: {}, tick }), true);
    for (let i = 0; i < 50 && q.settled.length < 2; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(calls.length, 1, "one run at boot, before the first interval");
    assert.deepEqual(q.settled.map((s) => [s.walk, s.outcome, s.enter_act_id]), [["10", "entered", "910"], ["11", "entered", "911"]]);
  } finally { stopArrivalTick(); }
});

test("THE TICK RUNS IN THE WRITER ONLY — never on port 0 (a suite's office), never off a store, never when the operator says off", () => {
  const store = { WORLD2_PG: "1", WORLD2_PG_URL: "postgres://x/y" };
  const tick = async () => ({ due: 0 });
  try {
    assert.equal(startArrivalTick({ port: 0, env: store, log: {}, tick }), false, "port 0");
    assert.equal(startArrivalTick({ port: 4380, env: {}, log: {}, tick }), false, "no store");
    assert.equal(startArrivalTick({ port: 4380, env: { ...store, ARRIVAL_TICK: "off" }, log: {}, tick }), false, "the operator's off");
  } finally { stopArrivalTick(); }
});

test("[pin] the server starts the tick outside the read workers and the read role", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(!IN_READ_WORKER && !READ_ONLY_ROLE\) import\("\.\/arrival-entries\.mjs"\)\.then\(\(m\) => m\.startArrivalTick\(\{ port: PORT \}\)\);/);
});

test("arrivalOutcome — every answer of the ordinary enter has one settle", () => {
  assert.deepEqual(arrivalOutcome({ answer: { entered: ["a"] }, seq: "5" }), { outcome: "entered", enterActId: "5" });
  assert.deepEqual(arrivalOutcome({ answer: { entered: [], already: true } }), { outcome: "already" });
  assert.equal(arrivalOutcome({ answer: { entered: [], awaiting: { terms: {} } } }).outcome, "refused", "a mark that now asks for terms is a refusal of the queued entry");
  assert.equal(arrivalOutcome({ answer: { entered: [], choose: [{ id: "x" }] } }).outcome, "refused");
  assert.deepEqual(arrivalOutcome({ answer: { entered: ["a"], refused: { mark: "a/b" }, stranded_at: "a/b" }, seq: "6" }),
    { outcome: "refused", enterActId: "6", words: "refused at a/b" }, "a chain refused part-way keeps the act it wrote");
  assert.equal(arrivalOutcome({ answer: { entered: [], crossed_nothing: "nothing" } }).outcome, "refused");
  assert.deepEqual(arrivalOutcome({ error: { name: "PenUnreachableError", message: "gone" } }), { held: "the office's record could not be reached" });
  const tripped = arrivalOutcome({ error: new Error("pg: relation does not exist") });
  assert.equal(tripped.outcome, "refused");
  assert.equal(tripped.words.includes("relation"), false, "a codeless error's own text never reaches the walker (POS-578)");
  for (const o of [{ answer: { entered: ["a"] } }, { answer: { already: true, entered: [] } }])
    assert.ok(ARRIVAL_OUTCOMES.includes(arrivalOutcome(o).outcome));
});

// ── AT THE WALK: the pre-check and the queue (G2) ────────────────────────────

const WALK = { who: "ann", key: { handles: new Set(["ann"]), household: "ann-house" }, mark: "a/room", target: { x: 5, y: 6 },
  arrivalCrossing: 250.5, dueAt: "2026-10-14T18:00:00.000Z", walkActId: "42", household: "ann-house" };

/** crossingDeps() as the office hands it, whose pen and walk hooks must never run in a pre-check. */
const officeDeps = () => ({
  marker: "office", now: (ms) => ms, nowMs: () => 0,
  standpointOf: async () => { throw new Error("the pre-check measured from the live standpoint"); },
  record: async () => { throw new Error("the pre-check WROTE"); },
  walking: async () => { throw new Error("the pre-check asked about the walk"); },
  stop: async () => { throw new Error("the pre-check stopped the walk"); },
});

test("ON THE WAY, AND IT WOULD ENTER — the pre-check writes nothing and the intent is queued against the walk", async () => {
  const queued = [];
  let seen = null;
  const r = await entryAtTheWalk({ ...WALK, arrived: false }, {
    crossingDeps: officeDeps,
    enter: async (payload, key, deps) => {
      seen = { payload, standpoint: await deps.standpointOf("ann"), now: deps.now(), walking: deps.walking, stop: deps.stop };
      await deps.record({ lines: ["x"] });   // the dry pen: answers, writes nothing
      return { entered: ["a/room"], within: [] };
    },
    queue: async (q) => { queued.push(q); return { queued: true }; },
  });
  assert.equal(r.queued, true);
  assert.deepEqual(seen.payload, { mark: "a/room", handle: "ann", accept: false });
  assert.deepEqual(seen.standpoint, { x: 5, y: 6, name: "ann" }, "judged from the walk's target");
  assert.equal(seen.now, 250.5, "at the arrival instant");
  assert.equal(seen.walking, null);
  assert.equal(seen.stop, null);
  assert.deepEqual(queued, [{ walkActId: "42", handle: "ann", household: "ann-house", mark: "a/room", accept: false, into: null, dueAt: WALK.dueAt }]);
});

test("ON THE WAY, AND IT WOULD NOT — refused, asking for terms, asking which way: nothing queued, and the why names what to pass (Darko, G2)", async () => {
  const cases = [
    [async () => { throw bounce(422, "a/room is opposed to you"); }, /refuses you/],
    [async () => ({ entered: [], awaiting: { terms: { edge: "aboard" } }, terms: { edge: "aboard" } }), /accept: true/],
    [async () => ({ entered: [], choose: [{ id: "a/east" }, { id: "a/west" }] }), /into:/],
    [async () => ({ entered: [], already: true }), /already within/],
  ];
  for (const [enter, why] of cases) {
    let queued = 0;
    const r = await entryAtTheWalk({ ...WALK, arrived: false }, { crossingDeps: officeDeps, enter, queue: async () => { queued += 1; return { queued: true }; } });
    assert.equal(r.queued, false);
    assert.match(r.why, why);
    assert.equal(queued, 0, "nothing reaches the queue");
  }
});

test("ALREADY THERE — a zero-length leg enters now, by the ordinary enter with the office's own deps, and queues nothing", async () => {
  let deps = null, queued = 0;
  const r = await entryAtTheWalk({ ...WALK, arrived: true }, { crossingDeps: officeDeps,
    enter: async (p, k, d) => { deps = d; return { entered: ["a/room"], within: ["a/room"] }; },
    queue: async () => { queued += 1; return { queued: true }; } });
  assert.equal(deps.marker, "office", "the office's real deps, untouched");
  assert.equal(r.queued, null);
  assert.deepEqual(r.entry.entered, ["a/room"]);
  assert.equal(queued, 0);
});

test("a walk with no record to queue on says so, and the walk still stands", async () => {
  const { queueArrival } = await import("../src/arrival-entries.mjs");
  assert.deepEqual(await queueArrival({ walkActId: null, handle: "ann", mark: "a/room", dueAt: WALK.dueAt }),
    { queued: false, why: "this office kept no record of the walk to queue the entry on" });
});

test("precheckVerdict — only an answer that enters is queued", () => {
  assert.deepEqual(precheckVerdict({ entered: ["a"] }), { would: true });
  assert.equal(precheckVerdict({ entered: ["a"], refused: { mark: "b" }, stranded_at: "b" }).would, false, "a chain that stops part-way is not an entry");
  assert.equal(precheckVerdict({ entered: [], crossed_nothing: "x" }).would, false);
});

// ── ON THE WALKER'S OWN STANDPOINT (G3) ──────────────────────────────────────

test("the standpoint's line: pending names the mark and the arrival; a refusal names the words; anything else says nothing", () => {
  assert.deepEqual(arrivalLine({ mark: "a/room", due_at: new Date("2026-10-14T18:00:00Z"), settled_at: null }).enters_on_arrival.arrives_at, "2026-10-14T18:00:00.000Z");
  const refused = arrivalLine({ mark: "a/room", settled_at: new Date("2026-10-14T18:00:10Z"), outcome: "refused", words: "a/room is opposed to you" });
  assert.equal(refused.arrival.outcome, "refused");
  assert.equal(refused.arrival.words, "a/room is opposed to you");
  assert.deepEqual(arrivalLine({ mark: "a/room", settled_at: new Date(), outcome: "entered" }), {});
  assert.deepEqual(arrivalLine(undefined), {});
});

// ── THE TRANSCRIPT, ON THE CLONE'S OWN VERBS (#529's, made at arrival) ───────
//
// FOUND walking the Spire's shell (lane plumb-spire-ktable, 2026-10-13): a
// stranger walked to the vestibule's portal with `enter_on_arrival: true` and
// was entered but never set down at the landing, because the old composition
// passed `stop: null`. At arrival the tick runs the ordinary enter, so the
// portal's own landing is written in the same passage. The fixture is
// test/wld5-portals.test.mjs's ruled instance in miniature.

const CLONE = worldClone();
const HAVE = !!CLONE && existsSync(join(CLONE, "tools", "portals.mjs"));
const SKIP = !HAVE && (CLONE ? `the world clone at ${CLONE} predates WLD-5 (no tools/portals.mjs)` : NO_WORLD);
const grammarOf = async () => import(pathToFileURL(join(CLONE, "tools", "enter-exit.mjs")).href);

const SPIRE = "spire/the-spire";
const marks = () => [
  { id: "spire/grounds", kind: "sited", by: "spire", at: { x: 1000, y: 1000 }, extent: { w: 500, h: 400 }, body: "The open Grounds." },
  { id: "spire/forecourt", kind: "sited", by: "spire", at: { x: 800, y: 1000 }, extent: { w: 80, h: 120 }, body: "The Forecourt." },
  { id: SPIRE, kind: "sited", by: "spire", class: "dungeon", at: { x: 1000, y: 1000 }, extent: { w: 300, h: 300 }, body: "The Spire." },
  { id: "spire/vestibule", kind: "sited", by: "spire", at: { x: 880, y: 1000 }, extent: { w: 50, h: 50 }, body: "The vestibule." },
  { id: "spire/doors-outside", kind: "sited", by: "spire", at: { x: 838, y: 1000 }, extent: { w: 2, h: 2 }, body: "The Gilded Doors.",
    entry: { word: "welcomed", into: "spire/vestibule", lands_at: "spire/doors-inside" } },
  { id: "spire/doors-inside", kind: "sited", by: "spire", at: { x: 860, y: 1000 }, extent: { w: 2, h: 2 }, body: "From inside.",
    entry: { word: "neutral", into: "spire/forecourt", lands_at: "spire/doors-outside" } },
];
const OUTSIDE_FACE = { x: 838, y: 1000 };
const INSIDE_FACE = { x: 860, y: 1000 };
const T = Date.parse("2026-10-14T18:00:00.000Z");
const ferryOf = (ms) => (ms - Date.UTC(2026, 5, 12)) / (12 * 3600 * 1000);

/** crossingDeps() in miniature: the walker's live standpoint where the walk record
 *  published it (`published`), an arrived walk, an in-memory ledger, an observable pen and stop. */
async function officeAt({ published = OUTSIDE_FACE, ledger = "" } = {}) {
  const thresholds = await grammarOf();
  const worldState = { marks: marks() };
  let text = ledger;
  const stops = [], records = [];
  return {
    stops, records, text: () => text,
    base: {
      world: async () => worldState,
      ledger: async () => text,
      standpointOf: async (who) => ({ ...published, name: who }),
      acts: async () => [],
      nowMs: () => T,
      now: (ms = Date.now()) => ferryOf(ms),
      walking: async () => ({ live: false, x: published.x, y: published.y }),   // the walk has arrived
      record: async (payload) => {
        records.push(payload);
        text += payload.lines.join("\n") + "\n";
        const folded = thresholds.parseEnterExitLedger(text).acts;
        return { lines: payload.lines, within: thresholds.occupancyAt(folded, payload.at).get(payload.handle) ?? [], seq: 900 + records.length };
      },
      stop: async (who, to, k, opts = {}) => { stops.push({ who, to, from: opts.from ?? null }); },
    },
  };
}
const ROW = { walk: "4242", handle: "ann", household: "ann-house", mark: "spire/doors-outside", accept: false, into_mark: null };

test("THE TRANSCRIPT · at arrival on the Gilded Doors' outside face, the walker is entered and set down at the inside face, in one passage", { skip: SKIP }, async () => {
  const o = await officeAt();
  const { answer, seq } = await enterAtArrival(ROW, { arrived: true, target: OUTSIDE_FACE }, { base: o.base, enter: enterViaOffice, worldClone: CLONE });

  assert.deepEqual(answer.entered, [SPIRE, "spire/vestibule"], "the passage enters the dungeon and the room");
  assert.equal(o.records.length, 1, "one passage, written once");
  assert.equal(o.records[0].via, "spire/doors-outside");
  assert.equal(o.records[0].arrival_of, "4242", "the pen is told which walk this entry arrived with");
  assert.equal(seq, "901");
  assert.deepEqual(o.stops, [{ who: "ann", to: INSIDE_FACE, from: INSIDE_FACE }], "THE LANDING: set down at the inside face, now");
  assert.deepEqual(answer.landed, { ...INSIDE_FACE, mark: "spire/doors-inside", clamped: false, recorded: true });
  assert.equal("walk_ended" in answer, false, "#2859 holds: the arrived walk is not stopped again");
});

test("ORDERING · the arrival's row is stamped at its own write: ferry and iso are one reading, never ahead of the rows before it", { skip: SKIP }, async () => {
  const { formatEnterExit, stampAt, parseEnterExitLedger } = await grammarOf();
  // a row written a minute earlier, by someone else
  const earlier = formatEnterExit({ handle: "bea", act: "enters", mark: "spire/forecourt", at: stampAt(ferryOf(T - 60_000)), word: "neutral", iso: new Date(T - 60_000).toISOString() });
  const o = await officeAt({ ledger: `${earlier}\n` });
  await enterAtArrival(ROW, { arrived: true, target: OUTSIDE_FACE }, { base: o.base, enter: enterViaOffice, worldClone: CLONE });
  const acts = parseEnterExitLedger(o.text()).acts;
  const mine = acts.filter((a) => a.handle === "ann");
  assert.ok(mine.length > 0);
  for (const a of mine) {
    assert.equal(a.at, stampAt(ferryOf(T)), "the ferry is the write's own instant, not the walk's");
    assert.ok(a.at >= acts[0].at, "never behind the row written before it");
  }
});

test("THE REACH AT ARRIVAL is measured from the walk's target: a published arrival point a few centimetres outside the mark still enters", { skip: SKIP }, async () => {
  // the engine rounds an arrival point to 0.1 m, and on a box's edge that can be 0.05 m outside it
  // (measured on world 17b64ef1: 1,066 of 14,700 rim arrivals). The walk record says arrived; the reach agrees.
  const o = await officeAt({ published: { x: 836.95, y: 1000 } });
  const { answer } = await enterAtArrival(ROW, { arrived: true, target: OUTSIDE_FACE }, { base: o.base, enter: enterViaOffice, worldClone: CLONE });
  assert.deepEqual(answer.entered, [SPIRE, "spire/vestibule"]);
});

test("[pin] the line rides the walker's own standpoint (every read) and their doorstep's world block, and nothing else (G3)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/world.mjs", import.meta.url), "utf8");
  assert.match(src, /const arrival = choice\.handle \? await \(await import\("\.\/arrival-entries\.mjs"\)\)\.arrivalLineFor\(choice\.handle\)\.catch\(\(\) => \(\{\}\)\) : \{\};\n  return \{ standpoint: \{ \.\.\.at, stance: choice\.stance, \.\.\.arrival \},/,
    "worldOrient: a spectator's glance (coords, no handle) carries nobody's line");
  const block = src.slice(src.indexOf("export async function worldBlockForHandle("), src.indexOf("async function doorstepTransportFor("));
  assert.match(block, /const arrival = await \(await import\("\.\/arrival-entries\.mjs"\)\)\.arrivalLineFor\(handle\)/);
  assert.equal(block.split("...(transport ? { transport } : {}), ...arrival };").length - 1, 2, "both of the doorstep block's answers carry it");
  assert.equal((src.match(/arrivalLineFor\(/g) ?? []).length, 2, "and no other reader of world.mjs");
});
