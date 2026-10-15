// creatures.test.mjs — the creatures core (POS-637 PR-A; src/creatures.mjs).
//
// RULED (Darko, Sitting E, 2026-10-14 21:31–21:32 EDT): a creature has an
// awareness ring and no verbs; code checks the ring, Jev chooses among the
// reactions whose `when` holds, a public d20 samples the choice, and the line
// is the kind's template. The settled engineering (W1–W10) is on POS-637.
//
// Everything is driven with its store, its judge and its clock injected. The
// kind is a fixture in the shape agreed with WLD-56 (its `when`s compiled to
// functions, as the adapter from the parsed file will hand them over).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CREATURE_DIALS, CREATURE_DIALS_PENDING, LivingSet, PRIOR_REACTION_SQL, SLICE_CAPS,
  allowedReactions, applyReaction, askJev, buildSlice, capOf, dial, judgmentFor, reactTo,
  reactionRows, sampleWith, t20, writeReaction,
} from "../src/creatures.mjs";

const levels = (m) => [`no ${m}`, `a little ${m}`, `plain ${m}`, `overwhelming ${m}`];
const WOLF = Object.freeze({
  kind: "wolf", name: "a grey wolf", what: "A grey wolf come out of the Mists. It belongs to no one.", ring_m: 80, span_h: 12,
  moods: { fear: { lo: 0, hi: 3, start: 1, levels: levels("fear") }, curiosity: { lo: 0, hi: 3, start: 1, levels: levels("curiosity") }, hunger: { lo: 0, hi: 3, start: 2, levels: levels("hunger") } },
  reactions: [
    { name: "watch", sentence: "it stands still and watches", when: () => true, effects: [], says: "At the edge of the Mists a grey wolf stands perfectly still, watching {actor}." },
    { name: "snarl", sentence: "it bares its teeth, a warning only", when: (s) => s.act.approaching && s.act.distance_m < 40, effects: [], says: "The wolf's lip curls back. It snarls at {actor}, low and steady." },
    { name: "stalk", sentence: "it paces along the mist-line with you", when: (s) => s.act.verb === "walk", effects: [], says: "The wolf paces along the edge of the Mists, keeping level with {actor}, never closer." },
    { name: "slink", sentence: "it slinks back a step", when: (s) => s.self.fear >= 2, effects: [{ do: "add", field: "fear", by: -1 }], says: "The wolf slinks back a step into the fog, its eyes still on {actor}." },
    { name: "flee", sentence: "it turns and is gone", when: (s) => s.self.fear >= 3, effects: [{ do: "flee" }], says: "The wolf wheels and is gone, a grey shape folding back into the grey." },
    { name: "fussy", sentence: "a `when` that throws", when: () => { throw new Error("a broken condition"); }, effects: [], says: "never" },
  ],
});
const kindOf = (k) => (k === "wolf" ? WOLF : null);

const T0 = Date.parse("2026-10-25T13:00:00Z");
const spawnRow = (id, { n = 1, x = 0, y = 0, at = T0 - 3600_000, moods } = {}) =>
  ({ id: String(n), at: new Date(at).toISOString(), actor: "the-town", action: "spawn", object: id, payload: { kind: "wolf", x, y, ...(moods ? { moods } : {}) } });
const livingWith = (...rows) => new LivingSet({ kindOf }).fold(rows);
const act = (over = {}) => ({ actor: "kai", verb: "walk", actId: "9001", atIso: new Date(T0).toISOString(), point: { x: 30, y: 0 }, ...over });

// A store write that records what it was handed and answers with ids.
function recordingWrite() {
  const calls = [];
  let next = 100;
  const write = async (rows) => {
    calls.push(rows);
    return { prior: false, rows: rows.map((r) => ({ id: String(next++), at: r.written_at, actor: r.actor, action: r.action, object: r.object, payload: r.payload })) };
  };
  return { calls, write };
}
const jevAnswer = (probabilities, scores = {}) => async () => ({
  response: { answers: { reaction: { probabilities, choice: Object.keys(probabilities)[0] }, ...Object.fromEntries(Object.entries(scores).map(([m, s]) => [m, { score: s }])) }, usage: { input_tokens: 1234 } },
  latency_ms: 150, tokens: 1234,
});
const ENV = { TYPESAFE_API_KEY: "k" };

// ── the dials ───────────────────────────────────────────────────────────────

test("every C value is a dial marked pending, carrying the lane's recommendation", () => {
  assert.deepEqual([...dial("perceived_acts")], ["walk", "enter", "exit", "say", "take", "give", "drop", "leave-mark"]);
  assert.equal(dial("per_actor_ms"), 60_000);
  assert.equal(dial("judgments_per_creature"), 100);
  assert.equal(dial("emission_m"), 500);
  assert.equal(dial("emission_ms"), 30 * 60_000);
  assert.equal(dial("far_line_m"), 5000);
  for (const d of Object.values(CREATURE_DIALS)) assert.match(d.pending, /^C[1-6]$/);
  assert.deepEqual([...new Set(CREATURE_DIALS_PENDING.map((s) => /\((C\d)\)/.exec(s)[1]))].sort(), ["C2", "C3", "C4", "C5", "C6"]);
});

// ── the d20 and the sampler ─────────────────────────────────────────────────

test("the d20 is the server stamp's: re-derivable, 1–20, and it moves with each of its three inputs", () => {
  const r = t20("creature:wolf-270-1", "9001", "2026-10-25T13:00:00.000Z");
  assert.equal(r, t20("creature:wolf-270-1", "9001", "2026-10-25T13:00:00.000Z"));
  const rolls = new Set();
  for (let i = 0; i < 400; i += 1) rolls.add(t20("creature:wolf-270-1", String(i), "2026-10-25T13:00:00.000Z"));
  assert.deepEqual([...rolls].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  const byStamp = new Set(Array.from({ length: 50 }, (_, i) => t20("creature:wolf-270-1", "9001", new Date(Date.UTC(2026, 9, 25, 13, 0, i)).toISOString())));
  const byCreature = new Set(Array.from({ length: 50 }, (_, i) => t20(`creature:wolf-270-${i}`, "9001", "2026-10-25T13:00:00.000Z")));
  assert.ok(byStamp.size > 5 && byCreature.size > 5, "the stamp and the creature each move the roll");
});

test("the sampler walks the distribution most likely first, as the prototypes do", () => {
  const p = { watch: 0.6, snarl: 0.3, stalk: 0.1 };
  assert.equal(sampleWith(1, p).picked, "watch");   // u 0.025
  assert.equal(sampleWith(12, p).picked, "watch");  // u 0.575
  assert.equal(sampleWith(13, p).picked, "snarl");  // u 0.625
  assert.equal(sampleWith(18, p).picked, "snarl");  // u 0.875
  assert.equal(sampleWith(19, p).picked, "stalk");  // u 0.925
  // a flat distribution keeps the menu's order
  assert.equal(sampleWith(1, { a: 0.5, b: 0.5 }).picked, "a");
  assert.equal(sampleWith(20, { a: 0.5, b: 0.5 }).picked, "b");
});

// ── the living set (W3) ─────────────────────────────────────────────────────

test("a creature is living from its spawn until it fades or flees, and the ring answers nearest first", () => {
  const living = livingWith(spawnRow("creature:wolf-270-1", { n: 1, x: 0 }), spawnRow("creature:wolf-270-2", { n: 2, x: 60 }),
    spawnRow("creature:wolf-270-3", { n: 3, x: 5000 }));
  const near = living.inRing({ x: 40, y: 0 }, { now: T0 });
  assert.deepEqual(near.map((n) => n.creature.id), ["creature:wolf-270-2", "creature:wolf-270-1"]);
  assert.equal(living.inRing({ x: 40, y: 0 }, { now: T0, most: 1 }).length, 1);
  assert.equal(living.inRing({ x: 2000, y: 0 }, { now: T0 }).length, 0);
  // the span ends it: 12 h from its spawn
  assert.equal(living.inRing({ x: 0, y: 0 }, { now: T0 + 12 * 3600_000 }).length, 0);
  // a fled withdraw ends it at once
  living.fold([{ id: "4", at: new Date(T0).toISOString(), actor: "creature:wolf-270-1", action: "withdraw", object: "creature:wolf-270-1", payload: { reason: "fled" } }]);
  assert.equal(living.byId.get("creature:wolf-270-1").gone, "fled");
  assert.deepEqual(living.living(T0).map((c) => c.id), ["creature:wolf-270-2", "creature:wolf-270-3"]);
});

test("an own write folds at once, and a smaller id another writer committed is still read at the next refresh", async () => {
  const living = livingWith(spawnRow("creature:wolf-270-1", { n: 1 }));
  living.booted = true;
  // this process's reaction lands as id 50 …
  living.fold([{ id: "50", at: new Date(T0).toISOString(), actor: "creature:wolf-270-1", action: "react", object: "9001", payload: { to: "kai", verb: "walk", reaction: "watch", judged_by: "jev" } }], { advance: false });
  assert.equal(living.byId.get("creature:wolf-270-1").reactions.length, 1);
  // … while the tick's spawn took id 40
  const store = [spawnRow("creature:wolf-270-2", { n: 40, x: 10 }),
    { id: "50", at: new Date(T0).toISOString(), actor: "creature:wolf-270-1", action: "react", object: "9001", payload: { to: "kai", verb: "walk", reaction: "watch", judged_by: "jev" } }];
  const query = async (sql, [cursor]) => store.filter((r) => BigInt(r.id) > BigInt(cursor));
  assert.deepEqual(await living.refresh({ query }), { ok: true, read: 2 });
  assert.ok(living.byId.has("creature:wolf-270-2"), "the spawn behind the own write was read");
  assert.equal(living.byId.get("creature:wolf-270-1").reactions.length, 1, "the own write was not folded twice");
  assert.equal(living.cursor, "50");
});

test("a store that cannot be read leaves the living set as it was", async () => {
  const living = livingWith(spawnRow("creature:wolf-270-1"));
  const r = await living.refresh({ query: async () => { throw new Error("the store went away"); } });
  assert.equal(r.ok, false);
  assert.equal(living.living(T0).length, 1);
});

// ── the caps (C2) and the menu ──────────────────────────────────────────────

test("the caps: one reaction per resident per creature a minute; past the creature's judgments, code answers", () => {
  const c = livingWith(spawnRow("creature:wolf-270-1")).byId.get("creature:wolf-270-1");
  c.reactions.push({ to: "kai", reaction: "watch", judged_by: "jev", at: T0 - 30_000 });
  assert.equal(capOf(c, "kai", { now: T0 }), "minute");
  assert.equal(capOf(c, "kai", { now: T0 + 31_000 }), null);
  assert.equal(capOf(c, "ash", { now: T0 }), null);
  for (let i = 1; i < dial("judgments_per_creature"); i += 1) c.reactions.push({ to: `r${i}`, judged_by: "jev", at: T0 - 3600_000 });
  assert.equal(capOf(c, "ash", { now: T0 }), "daily");
});

test("a `when` that throws is false, never an exception on the act's path", () => {
  const c = livingWith(spawnRow("creature:wolf-270-1")).byId.get("creature:wolf-270-1");
  const names = allowedReactions(WOLF, { self: c.moods, act: { verb: "say", distance_m: 30, approaching: false }, actor: { times: 0 } }).map((r) => r.name);
  assert.deepEqual(names, ["watch"]);
});

// ── reactTo: the whole turn ─────────────────────────────────────────────────

test("no living creature: an act costs nothing — no read, no judge, no write", async () => {
  const boom = () => { throw new Error("touched"); };
  const out = await reactTo(act(), { living: new LivingSet({ kindOf }), around: boom, ask: boom, write: boom, env: ENV, now: T0 });
  assert.deepEqual(out, []);
  const far = await reactTo(act({ point: { x: 900, y: 0 } }), { living: livingWith(spawnRow("creature:wolf-270-1")), around: boom, ask: boom, write: boom, env: ENV, now: T0 });
  assert.deepEqual(far, []);
});

test("an act outside the perceived list, and CREATURE_JUDGE=off, perceive nothing", async () => {
  const boom = () => { throw new Error("touched"); };
  const deps = { living: livingWith(spawnRow("creature:wolf-270-1")), around: boom, ask: boom, write: boom, now: T0 };
  assert.deepEqual(await reactTo(act({ verb: "note-to-self" }), { ...deps, env: ENV }), []);
  assert.deepEqual(await reactTo(act({ verb: "stake" }), { ...deps, env: ENV }), []);
  assert.deepEqual(await reactTo(act(), { ...deps, env: { ...ENV, CREATURE_JUDGE: "off" } }), []);
});

test("inside the ring Jev chooses, the d20 samples, the line is the template, and one row records it", async () => {
  const living = livingWith(spawnRow("creature:wolf-270-1"));
  const { calls, write } = recordingWrite();
  const a = act({ point: { x: 30, y: 0 }, toward: { x: 5, y: 0 } }); // approaching, 30 m off
  const roll = t20("creature:wolf-270-1", a.actId, a.atIso);
  const probs = { snarl: 0.7, stalk: 0.2, watch: 0.1 };
  const out = await reactTo(a, { living, around: async () => ({}), ask: jevAnswer(probs, { fear: 2 }), write, env: ENV, now: T0 });
  const expected = sampleWith(roll, probs).picked;
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]), ["id", "kind", "line", "reaction", "roll", "judged_by"]);
  assert.equal(out[0].reaction, expected);
  assert.equal(out[0].roll, roll);
  assert.equal(out[0].judged_by, "jev");
  assert.equal(out[0].line, WOLF.reactions.find((r) => r.name === expected).says.replaceAll("{actor}", "kai"));
  assert.equal(calls.length, 1);
  const [row] = calls[0];
  assert.equal(row.actor, "creature:wolf-270-1");
  assert.equal(row.action, "react");
  assert.equal(row.object, "9001");
  assert.equal(row.class, "creature");
  const p = JSON.parse(row.payload);
  assert.equal(p.to, "kai");
  assert.equal(p.roll, roll);
  assert.equal(p.approaching, true);
  assert.equal(p.moods_after.fear, 2, "the Score set the mood");
  // the creature remembers it
  assert.equal(living.byId.get("creature:wolf-270-1").reactions.at(-1).to, "kai");
});

test("the row never carries the slice: other residents' words stay out of the published record", async () => {
  const living = livingWith(spawnRow("creature:wolf-270-1"));
  const { calls, write } = recordingWrite();
  const SECRET_BODY = "a body only the slice should quote";
  const SECRET_SAY = "words only earshot should carry";
  const around = async () => ({ marks: [{ id: "elowen/a-bench", distance_m: 20, body: SECRET_BODY }], heard: [{ who: "elowen", said: SECRET_SAY, ago: "1 min" }],
    residents: [{ handle: "elowen", distance_m: 40 }] });
  let seen = null;
  const ask = async (state, q) => { seen = { state, q }; return jevAnswer({ stalk: 1 })(); };
  await reactTo(act(), { living, around, ask, write, env: ENV, now: T0 });
  assert.ok(JSON.stringify(seen.state).includes(SECRET_BODY), "Jev read the body");
  const recorded = JSON.stringify(calls);
  assert.ok(!recorded.includes(SECRET_BODY) && !recorded.includes(SECRET_SAY));
  const p = JSON.parse(calls[0][0].payload);
  assert.match(p.slice_sha256, /^[0-9a-f]{64}$/);
  // and Jev chose only among the reactions whose `when` holds
  assert.deepEqual(Object.keys(seen.q.reaction.criteria).sort(), ["stalk", "watch"]);
});

test("Jev down, slow, or unreadable: code answers with the same d20 over the allowed reactions", async () => {
  for (const [ask, why] of [
    [async () => { throw Object.assign(new Error("jev was slower than 900 ms"), { why: "timeout" }); }, "timeout"],
    [async () => { throw new Error("socket hang up"); }, "fault"],
    [async () => ({ response: { answers: { reaction: { probabilities: { lunge: 1 } } } } }), "unreadable"],
  ]) {
    const living = livingWith(spawnRow("creature:wolf-270-1"));
    const { calls, write } = recordingWrite();
    const out = await reactTo(act(), { living, around: async () => ({}), ask, write, env: ENV, now: T0 });
    assert.equal(out.length, 1, why);
    assert.equal(out[0].judged_by, "code");
    assert.equal(JSON.parse(calls[0][0].payload).why, why);
    assert.equal(out[0].reaction, sampleWith(out[0].roll, { watch: 0.5, stalk: 0.5 }).picked);
  }
});

test("a judgment the store cannot record answers nothing, and the act's caller never sees a throw", async () => {
  const living = livingWith(spawnRow("creature:wolf-270-1"));
  const out = await reactTo(act(), { living, around: async () => ({}), ask: jevAnswer({ stalk: 1 }), env: ENV, now: T0,
    write: async () => { throw new Error("the record cannot be reached"); } });
  assert.deepEqual(out, []);
  assert.equal(living.byId.get("creature:wolf-270-1").reactions.length, 0, "no line, no memory, for a row that never landed");
});

test("CREATURE_JUDGE=code and a spent creature never ask Jev; one possible reaction asks nobody", async () => {
  const boom = async () => { throw new Error("asked"); };
  const living = livingWith(spawnRow("creature:wolf-270-1"));
  const { write } = recordingWrite();
  const [coded] = await reactTo(act(), { living, around: async () => ({}), ask: boom, write, env: { ...ENV, CREATURE_JUDGE: "code" }, now: T0 });
  assert.equal(coded.judged_by, "code");
  const one = await reactTo(act({ verb: "say", actor: "ash", actId: "9002" }), { living, around: boom, ask: boom, write, env: ENV, now: T0 });
  assert.equal(one[0].reaction, "watch");
  const c = living.byId.get("creature:wolf-270-1");
  for (let i = 0; i < dial("judgments_per_creature"); i += 1) c.reactions.push({ to: `r${i}`, judged_by: "jev", at: T0 - 3600_000 });
  const [spent] = await reactTo(act({ actor: "lupi", actId: "9003" }), { living, around: boom, ask: boom, write, env: ENV, now: T0 });
  assert.equal(spent.judged_by, "code");
});

test("the per-minute cap: a second act inside the minute gets no reaction; a retried act gets the first answer again", async () => {
  const living = livingWith(spawnRow("creature:wolf-270-1"));
  const { calls, write } = recordingWrite();
  const deps = { living, around: async () => ({}), ask: jevAnswer({ stalk: 1 }), write, env: ENV };
  const first = await reactTo(act(), { ...deps, now: T0 });
  const again = await reactTo(act(), { ...deps, now: T0 + 5_000 });
  assert.deepEqual(again, first, "the same act, retried, reads its answer from the record");
  assert.deepEqual(await reactTo(act({ actId: "9010" }), { ...deps, now: T0 + 20_000 }), []);
  assert.equal((await reactTo(act({ actId: "9011" }), { ...deps, now: T0 + 61_000 })).length, 1);
  assert.equal(calls.length, 2);
});

test("a flee writes the creature's own withdraw beside the reaction, and the creature is gone for the next act", async () => {
  const living = livingWith(spawnRow("creature:wolf-270-1", { moods: { fear: 3 } }));
  const { calls, write } = recordingWrite();
  const out = await reactTo(act(), { living, around: async () => ({}), ask: jevAnswer({ flee: 1 }), write, env: ENV, now: T0 });
  assert.equal(out[0].reaction, "flee");
  assert.deepEqual(calls[0].map((r) => r.action), ["react", "withdraw"]);
  assert.equal(calls[0][1].actor, "creature:wolf-270-1");
  assert.deepEqual(JSON.parse(calls[0][1].payload), { reason: "fled", after: "9001" });
  assert.equal(living.byId.get("creature:wolf-270-1").gone, "fled");
  assert.deepEqual(await reactTo(act({ actor: "ash", actId: "9002" }), { living, around: async () => ({}), ask: jevAnswer({ watch: 1 }), write, env: ENV, now: T0 }), []);
});

test("two acts on one creature at once are judged in order: the second sees the first's moods (W6)", async () => {
  const living = livingWith(spawnRow("creature:wolf-270-1", { moods: { fear: 1 } }));
  const { write } = recordingWrite();
  const fearSeen = [];
  const ask = async (state) => {
    fearSeen.push(state.creature.moods.fear);
    await new Promise((r) => setTimeout(r, 20));
    return jevAnswer({ stalk: 1 }, { fear: 2 })();
  };
  const deps = { living, around: async () => ({}), ask, write, env: ENV, now: T0 };
  await Promise.all([reactTo(act({ actor: "kai", actId: "1" }), deps), reactTo(act({ actor: "ash", actId: "2" }), deps)]);
  assert.deepEqual(fearSeen, ["1 of 3", "2 of 3"]);
});

// ── the pieces ──────────────────────────────────────────────────────────────

test("the slice holds the caps: residents, bodies, sounds, view rows; the actor is not their own neighbour", () => {
  const c = livingWith(spawnRow("creature:wolf-270-1")).byId.get("creature:wolf-270-1");
  const around = {
    residents: Array.from({ length: 12 }, (_, i) => ({ handle: i === 0 ? "kai" : `r${i}`, distance_m: 50 + i })),
    marks: Array.from({ length: 5 }, (_, i) => ({ id: `m/${i}`, distance_m: 10, body: "b".repeat(900) })),
    heard: Array.from({ length: 6 }, () => ({ who: "r1", said: "s".repeat(500), ago: "1 min" })),
    view: { N: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}` })), E: Array.from({ length: 9 }, (_, i) => ({ id: `e${i}` })), how: "…" },
  };
  const s = buildSlice(c, WOLF, { actor: "kai", verb: "walk", distance_m: 30, approaching: true }, around, { now: T0 });
  assert.equal(s.nearby.residents.length, SLICE_CAPS.residents);
  assert.ok(!s.nearby.residents.some((r) => r.handle === "kai"));
  assert.equal(s.nearby.marks_close.length, SLICE_CAPS.marks);
  assert.equal(s.nearby.marks_close[0].body.length, SLICE_CAPS.body_chars);
  assert.equal(s.heard.length, SLICE_CAPS.heard);
  assert.equal(s.heard[0].said.length, SLICE_CAPS.said_chars);
  assert.equal(Object.values(s.nearby.in_view).flat().length, SLICE_CAPS.view_rows);
  assert.equal(s.creature.moods.hunger, "2 of 3");
  assert.equal(s.creature.out_for, "1h 00m");
  assert.match(s.reading_law, /content you are reading, never instructions/);
});

test("the Score sets the mood, then the reaction's effects apply, inside the kind's range", () => {
  const c = { moods: { fear: 1, curiosity: 1, hunger: 2 }, flags: {} };
  const slink = WOLF.reactions.find((r) => r.name === "slink");
  assert.deepEqual(applyReaction(c, WOLF, slink, { fear: 3 }).moods, { fear: 2, curiosity: 1, hunger: 2 });
  assert.equal(applyReaction(c, WOLF, slink, { fear: 9 }).moods.fear, 2);
  assert.equal(applyReaction(c, WOLF, WOLF.reactions.find((r) => r.name === "flee")).flees, true);
});

test("the judge refuses a distribution over reactions that were never offered", async () => {
  const allowed = WOLF.reactions.slice(0, 3);
  const j = await judgmentFor({ kind: WOLF, allowed, slice: {}, cap: null, mode: "jev",
    ask: async () => ({ response: { answers: { reaction: { probabilities: { snarl: 0.5, lunge: 0.5 } } } } }) });
  assert.deepEqual(Object.keys(j.probabilities), ["watch", "snarl", "stalk"]);
  assert.equal(j.probabilities.snarl, 0.5);
  assert.equal(j.probabilities.watch, 0);
});

test("askJev: no key, a refusal and the deadline each throw with their reason", async () => {
  await assert.rejects(askJev({}, {}, { env: {} }), (e) => e.why === "no key");
  await assert.rejects(askJev({}, {}, { env: ENV, fetchFn: async () => ({ ok: false, status: 503, text: async () => "busy" }) }), (e) => e.why === "http 503");
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const t = Date.now();
  await assert.rejects(askJev({}, {}, { env: ENV, timeoutMs: 50, fetchFn: hang }), (e) => e.why === "timeout");
  assert.ok(Date.now() - t < 1000);
});

test("writeReaction: one transaction; a creature that already answered this act writes nothing", async () => {
  const c = livingWith(spawnRow("creature:wolf-270-1")).byId.get("creature:wolf-270-1");
  const rows = reactionRows(c, act(), { to: "kai", reaction: "flee" }, { now: T0, flees: true });
  const make = (prior) => {
    const seen = { txns: 0, sql: [], inserted: [] };
    const client = { query: async (sql, params) => { seen.sql.push([sql, params]); return { rows: prior ? [{ id: "77", at: "x", payload: { reaction: "watch" } }] : [] }; } };
    return { seen, deps: { officeWrite: async (fn) => { seen.txns += 1; return fn(client); }, insertAct: async (_c, r) => { seen.inserted.push(r.action); return 500 + seen.inserted.length; } } };
  };
  const fresh = make(false);
  const w = await writeReaction(rows, fresh.deps);
  assert.equal(fresh.seen.txns, 1);
  assert.deepEqual(fresh.seen.inserted, ["react", "withdraw"]);
  assert.deepEqual(w.rows.map((r) => r.id), ["501", "502"]);
  assert.equal(fresh.seen.sql[0][0], PRIOR_REACTION_SQL);
  assert.deepEqual(fresh.seen.sql[0][1], ["creature:wolf-270-1", "9001"]);
  const retried = make(true);
  const again = await writeReaction(rows, retried.deps);
  assert.equal(again.prior, true);
  assert.deepEqual(retried.seen.inserted, []);
});
