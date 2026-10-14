// arrival-entries.mjs — a walk's "enter on arrival", queued at the walk and made
// at arrival by the office's own tick (WLD-5, POS-618; 074_arrival_entries.sql).
//
// RULED (Darko, 2026-10-14 10:20 EDT): "delaying the row on the ledger until
// they actually arrive at the thing, while still affording residents the
// convenience of being able to say: I want to enter at the time I arrive."
//
// Until this file the walk door ran the enter AT DEPARTURE and stamped its rows
// with the arrival crossing. Those rows are 49 of the ledger's 52 backward
// ferry steps (POS-618), 10 of 111 were overtaken before the walker arrived,
// and a portal's landing could not be written at all without dating a
// departure in the future (office #529, blocked by its review). Now:
//
//   · AT THE WALK (`entryAtTheWalk`). A walker already standing there enters at
//     once, by the ordinary enter. Anyone else gets a PRE-CHECK: the same enter,
//     judged by the mark's law as it stands now, with a pen that writes nothing.
//     If it would enter, the intent is queued here, keyed to the walk act. If
//     it refuses, asks for terms the walker did not accept, or asks which way,
//     nothing is queued and the answer says why (Darko, G2).
//   · AT ARRIVAL (`arrivalTick`). Every ARRIVAL_TICK_MS the writer process asks
//     for the queued rows that are due. A row whose walk is no longer the
//     walker's current departure is overtaken (Darko, G4: any later departure).
//     A row whose walker has arrived runs the ORDINARY enter, with the office's
//     real deps: the reach, the portal's landing, the walk's end, ferry and iso
//     both now. The row is then settled once: entered, refused, already or
//     overtaken.
//   · ON THE WALKER'S OWN STANDPOINT (`arrivalLineFor`). While it is pending,
//     `enters_on_arrival`. After a refusal, `arrival` with the mark's words,
//     until the walker's next act (Darko, G3). Nowhere else.
//
// NEVER TWICE. The tick's enter carries `arrival_of: <walk act id>` to the pen,
// and crossing-exec refuses a second enter for the same walk inside the
// write's own transaction (`arrivalOnceGuard`). So a tick that crashes between
// the write and the settle re-runs safely: the pen answers with the first
// enter's act, and the row is settled as entered.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { actsQuery, world2Enabled } from "./world2-acts.mjs";
import { DEPARTURE_ACTIONS, departureRecordOf, fractionalCrossing } from "../world2/tools/live-reads.mjs";

export const ARRIVAL_TICK_MS = 10_000;
export const ARRIVAL_TICK_BATCH = 20;
export const ARRIVAL_OUTCOMES = Object.freeze(["entered", "refused", "already", "overtaken"]);
// a refusal stays on the standpoint until the walker's next act, and at most this long
const REFUSAL_SHOWN_MS = 24 * 3600 * 1000;
const WORDS_MAX = 600;

const QUEUE_SQL = `
  INSERT INTO arrival_entries (walk_act_id, handle, household, mark, accept, into_mark, due_at)
  VALUES ($1::bigint, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (walk_act_id) DO NOTHING
  RETURNING walk_act_id::text AS walk`;
const DUE_SQL = `
  SELECT walk_act_id::text AS walk, handle, household, mark, accept, into_mark, due_at
    FROM arrival_entries
   WHERE settled_at IS NULL AND due_at <= $1
   ORDER BY due_at, walk_act_id
   LIMIT $2`;
const SETTLE_SQL = `
  UPDATE arrival_entries
     SET settled_at = now(), outcome = $2, enter_act_id = $3::bigint, words = $4
   WHERE walk_act_id = $1::bigint AND settled_at IS NULL
  RETURNING walk_act_id::text AS walk`;
// The walker's current departure: the newest store-era departure act, in the
// record's own order (live-reads.mjs § DEPARTURE_ORDER_KEYS: instant, then id).
const CURRENT_SQL = `
  SELECT id::text AS id FROM acts
   WHERE actor = $1 AND action = ANY($2) AND payload->>'_ledger' IS NULL
   ORDER BY at DESC, id DESC
   LIMIT 1`;
const WALK_SQL = `SELECT id, at, crossing, actor, action, payload FROM acts WHERE id = $1::bigint`;
// Who has a line on their standpoint: a pending row whose walk is still the
// current departure, or a refusal with no act of theirs since it.
const STANDING_SQL = `
  SELECT DISTINCT ON (e.handle) e.handle, e.walk_act_id::text AS walk, e.mark, e.due_at, e.settled_at, e.outcome, e.words
    FROM arrival_entries e
   WHERE (e.settled_at IS NULL
          AND e.walk_act_id = (SELECT a.id FROM acts a
                                WHERE a.actor = e.handle AND a.action = ANY($1) AND a.payload->>'_ledger' IS NULL
                                ORDER BY a.at DESC, a.id DESC LIMIT 1))
      OR (e.outcome = 'refused' AND e.settled_at > $2
          AND NOT EXISTS (SELECT 1 FROM acts a WHERE a.actor = e.handle AND a.at > e.settled_at))
   ORDER BY e.handle, e.walk_act_id DESC`;

const iso = (t) => (t instanceof Date ? t : new Date(t)).toISOString();
const wordsOf = (...parts) => parts.filter(Boolean).map(String).join(" — ").slice(0, WORDS_MAX);

// ── AT THE WALK ──────────────────────────────────────────────────────────────

/**
 * Queue the intent. Answers `{ queued: true }`, or `{ queued: false, why }`.
 * Never throws: the walk is already recorded, and an intent that could not be
 * queued is said on the walk's answer, never swallowed.
 */
export async function queueArrival({ walkActId, handle, household = null, mark, accept = false, into = null, dueAt }, { query = actsQuery } = {}) {
  if (walkActId == null) return { queued: false, why: "this office kept no record of the walk to queue the entry on" };
  try {
    const rows = await query(QUEUE_SQL, [String(walkActId), handle, household, mark, accept === true, into ?? null, iso(dueAt)]);
    if (rows === null) return { queued: false, why: "this office is not pointed at the store" };
    return rows.length === 1 ? { queued: true } : { queued: false, why: "this walk's entry is already queued" };
  } catch (e) {
    return { queued: false, why: `the store did not take it (${String(e?.message ?? e).split("\n")[0].slice(0, 160)})` };
  }
}

/** What a pre-check answered, as one word: would it enter, and if not, why not. */
export function precheckVerdict(answer) {
  if (!answer) return { would: false, why: "the mark gave no answer" };
  if (answer.refused && typeof answer.refused === "string" && !answer.entered)
    return { would: false, why: "the mark refuses you as its law stands now. Its own words are above" };
  if (answer.choose)
    return { would: false, why: "this portal leads more than one way: walk again with into: <one of choose> to have the entry made on arrival" };
  if (answer.awaiting && !answer.entered?.length)
    return { would: false, why: "this mark asks for your word: walk again with accept: true to have the entry made on arrival" };
  if (answer.refused)
    return { would: false, why: `the way in refuses you at ${answer.stranded_at ?? "a threshold"} as its law stands now` };
  if (answer.already) return { would: false, why: "you are already within it" };
  if (!answer.entered?.length) return { would: false, why: String(answer.crossed_nothing ?? "the mark would let you cross nothing") };
  return { would: true };
}

/**
 * The walk door's `enter_on_arrival`, once the walk is recorded.
 *
 * `arrived`: the walker is standing there already (a zero-length leg, or a
 * start inside the target), so the ordinary enter runs now. Otherwise the
 * pre-check, and the queue. Answers `{ entry, queued }` for walkEntryReceipt.
 * `deps.enter(payload, key, depsForEnter)` and `deps.crossingDeps()` are the
 * office's own, injected so this is driven without a server.
 */
export async function entryAtTheWalk({ who, key, mark, accept = false, into = null, arrived, target, arrivalCrossing, dueAt, walkActId, household },
  { enter, crossingDeps, queue = queueArrival } = {}) {
  const payload = { mark, handle: who, accept: accept === true, ...(into ? { into } : {}) };
  if (arrived) {
    // THE ORDINARY ENTER, NOW: the walker is standing there, so it is a plain
    // enter with the office's real deps (the walk's end, a portal's landing)
    try { return { entry: await enter(payload, key, crossingDeps()), queued: null }; }
    catch (e) { return { entry: refusalOf(e), queued: null }; }
  }
  // THE PRE-CHECK: the same enter, judged at the arrival instant from the
  // walk's target, with a pen that writes nothing and no walk to stop.
  const base = crossingDeps();
  const dry = {
    ...base, walking: null, stop: null,
    now: () => arrivalCrossing,
    standpointOf: async () => ({ x: target.x, y: target.y, name: who }),
    record: async () => ({ within: [], dry: true }),
  };
  let answer;
  try { answer = await enter(payload, key, dry); }
  catch (e) { return { entry: refusalOf(e), queued: false, why: precheckVerdict({ refused: refusalOf(e).refused }).why }; }
  const verdict = precheckVerdict(answer);
  if (!verdict.would) return { entry: answer, queued: false, why: verdict.why };
  const q = await queue({ walkActId, handle: who, household, mark, accept, into, dueAt });
  return q.queued ? { entry: answer, queued: true } : { entry: answer, queued: false, why: `${q.why}. Walk there and enter by hand` };
}

/** A thrown refusal in the walk answer's own words (`world.mjs § THE WALK STILL STANDS`). */
function refusalOf(e) {
  return { refused: e?.defect ?? String(e?.message ?? e), ...(e?.hint ? { hint: e.hint } : {}), ...(e?.code ? { code: e.code } : {}) };
}

// ── AT ARRIVAL ───────────────────────────────────────────────────────────────

/**
 * What an arrival's enter came to, as the row's settle. Pure.
 * `{ outcome, enterActId?, words? }`, or `{ held: why }` when the office could
 * not try (the pen busy, the store away): the row is asked again next tick.
 */
export function arrivalOutcome({ answer = null, error = null, seq = null } = {}) {
  if (error) {
    if (error.arrival_settled != null) return { outcome: "entered", enterActId: String(error.arrival_settled) };
    if (error.code === 503 || error.name === "PenUnreachableError") return { held: String(error.defect ?? error.message ?? error).slice(0, 200) };
    return { outcome: "refused", words: wordsOf(error.defect ?? error.message ?? error, error.hint) };
  }
  if (!answer) return { outcome: "refused", words: "the mark gave no answer" };
  if (answer.choose) return { outcome: "refused", words: wordsOf(answer.note ?? "this portal leads more than one way, and the way you named is not one of them") };
  if (answer.awaiting && !answer.entered?.length)
    return { outcome: "refused", words: wordsOf("the mark now asks for your word before you enter, and you had not given it", "walk again with accept: true, or enter by hand") };
  if (answer.refused) return { outcome: "refused", enterActId: seq, words: wordsOf(`refused at ${answer.stranded_at ?? answer.refused?.mark ?? "a threshold"}`, answer.note) };
  if (answer.already) return { outcome: "already" };
  if (!answer.entered?.length) return { outcome: "refused", words: wordsOf(answer.crossed_nothing ?? "nothing was crossed") };
  return { outcome: "entered", enterActId: seq };
}

/**
 * One tick. Never throws for one row: each row is decided, held or skipped on
 * its own. Answers the counts and one line for the log.
 *
 * deps (all injectable; the defaults are the office's own):
 *   query(text, params)  the store (actsQuery)
 *   current(handle)      the walker's current departure act id
 *   arrival(row)         { arrived, target } from the walk act and the clock
 *   enter(row)           { answer, seq } from the ordinary enter, or throws
 */
export async function arrivalTick({ now = Date.now(), query = actsQuery, current, arrival, enter, batch = ARRIVAL_TICK_BATCH } = {}) {
  current ??= (h) => currentDeparture(h, { query });
  arrival ??= (row) => arrivalOf(row, { query, now });
  enter ??= enterAtArrival;
  const rows = (await query(DUE_SQL, [iso(now), batch])) ?? [];
  const out = { due: rows.length, entered: [], refused: [], already: [], overtaken: [], held: [], walking: [] };
  for (const row of rows) {
    const walk = String(row.walk);
    let settle;
    try {
      const cur = await current(row.handle);
      if (cur !== walk) settle = { outcome: "overtaken" };
      else {
        const a = await arrival(row);
        if (!a.arrived) { out.walking.push(walk); continue; }   // due by the clock, not yet by the record: next tick
        let r;
        try { r = arrivalOutcome(await enter(row, a)); }
        catch (error) { r = arrivalOutcome({ error }); }
        if (r.held) { out.held.push({ walk, why: r.held }); continue; }
        settle = r;
      }
      const done = await query(SETTLE_SQL, [walk, settle.outcome, settle.enterActId ?? null, settle.words ?? null]);
      if (done?.length) out[settle.outcome].push(walk);
    } catch (e) {
      out.held.push({ walk, why: String(e?.message ?? e).split("\n")[0].slice(0, 160) });
    }
  }
  out.line = `arrivals: ${out.due} due · ${out.entered.length} entered · ${out.refused.length} refused · ${out.already.length} already · ${out.overtaken.length} overtaken`
    + (out.walking.length ? ` · ${out.walking.length} still walking` : "")
    + (out.held.length ? ` · ${out.held.length} held (${out.held.map((h) => `walk ${h.walk}: ${h.why}`).join("; ")})` : "");
  return out;
}

/** The walker's current departure act id, or null. */
export async function currentDeparture(handle, { query = actsQuery } = {}) {
  const rows = await query(CURRENT_SQL, [handle, [...DEPARTURE_ACTIONS]]);
  return rows?.[0]?.id ?? null;
}

/**
 * Has this row's walk arrived, by its own record and the clock? And where is
 * its target. The walk act read back and mapped by the record's one converter
 * (live-reads.mjs § departureRecordOf), then the engine's own positionAt.
 */
export async function arrivalOf(row, { query = actsQuery, now = Date.now(), walkMod = null } = {}) {
  const [act] = (await query(WALK_SQL, [String(row.walk)])) ?? [];
  const rec = act ? departureRecordOf(act)?.record : null;
  if (!rec) return { arrived: false, target: null, why: "the walk act could not be read back" };
  const walk = walkMod ?? await import(pathToFileURL(join((await import("./world.mjs")).WORLD_CLONE, "tools", "walk.mjs")));
  const pos = walk.positionAt(rec, fractionalCrossing(now));
  return { arrived: pos?.arrived === true, target: { x: rec.toward.x, y: rec.toward.y }, position: pos };
}

/**
 * THE ORDINARY ENTER, AT ARRIVAL. The office's real deps (the reach, the
 * portal's landing, the walk's end, one instant for ferry and iso), with two
 * things added: the pen carries `arrival_of` so the walk is entered once, and
 * the reach is measured from the walk's target. The tick has no request key,
 * so it acts with the walker's own handle and the household the walk was
 * declared under.
 */
export async function enterAtArrival(row, a, { base = null, enter = null, worldClone = null } = {}) {
  enter ??= (await import("./world-crossings.mjs")).enterViaOffice;
  base ??= (await import("./world-apex.mjs")).crossingDeps();
  worldClone ??= (await import("./world.mjs")).WORLD_CLONE;
  let seq = null;
  const deps = {
    ...base,
    // WHERE THE REACH IS MEASURED FROM: the walk's own target. The walk record
    // says this walker has arrived (`arrivalOf`); the point the engine
    // publishes for an arrival is rounded to 0.1 m and can sit up to 0.05 m
    // outside a box's edge (measured: 1,066 of 14,700 rim arrivals on world
    // 17b64ef1), which would refuse an arrival the record has already made.
    standpointOf: async (who) => ({ x: a.target.x, y: a.target.y, name: who }),
    record: async (p) => { const r = await base.record({ ...p, arrival_of: String(row.walk) }); seq = r?.seq ?? seq; return r; },
  };
  const key = { handles: new Set([row.handle]), household: row.household ?? null };
  const answer = await enter(worldClone, {
    mark: row.mark, handle: row.handle, accept: row.accept === true, ...(row.into_mark ? { into: row.into_mark } : {}),
  }, key, deps);
  return { answer, seq: seq == null ? null : String(seq) };
}

// ── NEVER TWICE: the pen's guard ─────────────────────────────────────────────

/**
 * crossing-exec's guard for an enter that carries `arrival_of`: inside the
 * write's own transaction, under the walk's advisory lock, refuse when an
 * enter for this walk is already in the record. The refusal carries that act's
 * id as `arrival_settled`, so the tick settles the row as entered.
 */
export const arrivalOnceGuard = ({ walk, actor }) => async (client) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`arrival:${walk}`]);
  const { rows } = await client.query(
    "SELECT id::text AS id FROM acts WHERE actor = $1 AND action = 'enter' AND payload->>'arrival_of' = $2 ORDER BY id LIMIT 1",
    [actor, String(walk)]);
  if (rows.length) {
    const e = new Error(`walk ${walk} was already entered on arrival, by act ${rows[0].id}`);
    Object.assign(e, { code: 409, defect: e.message, hint: "nothing was written a second time", arrival_settled: rows[0].id });
    throw e;
  }
};

// ── ON THE WALKER'S OWN STANDPOINT ───────────────────────────────────────────

const standing = { at: 0, map: null, inflight: null };

/**
 * The line a walker's own standpoint carries, or `{}`: `enters_on_arrival`
 * while an entry is queued and its walk still stands, `arrival` after a
 * refusal until their next act. One store read per process per tick at most,
 * for every handle at once, so a read costs a Map lookup.
 */
export async function arrivalLineFor(handle, { now = Date.now(), query = actsQuery } = {}) {
  if (!handle || !world2Enabled()) return {};
  if (!standing.map || now - standing.at >= ARRIVAL_TICK_MS) {
    standing.inflight ??= (async () => {
      try {
        const rows = await query(STANDING_SQL, [[...DEPARTURE_ACTIONS], iso(now - REFUSAL_SHOWN_MS)]);
        standing.map = new Map((rows ?? []).map((r) => [r.handle, r]));
      } catch { standing.map ??= new Map(); }
      standing.at = now;
      standing.inflight = null;
    })();
    await standing.inflight;
  }
  return arrivalLine(standing.map.get(handle));
}

/** The standpoint's words for one row. Pure. */
export function arrivalLine(r) {
  if (!r) return {};
  if (r.settled_at == null) return { enters_on_arrival: { mark: r.mark, arrives_at: iso(r.due_at),
    note: `you enter ${r.mark} when you arrive, by its own law at that moment. A new walk before then replaces it` } };
  if (r.outcome === "refused") return { arrival: { mark: r.mark, outcome: "refused", words: r.words ?? null, at: iso(r.settled_at),
    note: `you arrived at ${r.mark} and the entry you asked for was not made. You are standing at it; enter by hand if it will have you` } };
  return {};
}

/** Tests only. */
export function resetArrivalLines() { Object.assign(standing, { at: 0, map: null, inflight: null }); }

// ── THE TICK'S TIMER ─────────────────────────────────────────────────────────

const timer = { handle: null, running: false, last: null };

/**
 * Start the tick: the writer process only, pointed at a store, never on port 0
 * (a suite's office), and not when the operator has said `ARRIVAL_TICK=off`.
 * One run now (the restart's catch-up), then every ARRIVAL_TICK_MS, serial: a
 * tick still running when the next is due lets it pass. Unref'd. Idempotent.
 */
export function startArrivalTick({ port, env = process.env, log = console, tick = arrivalTick } = {}) {
  if (timer.handle) return false;
  if (String(env.ARRIVAL_TICK ?? "").toLowerCase() === "off") { log.log?.("[arrivals] ARRIVAL_TICK=off: entries queued on a walk are not made until it is on"); return false; }
  if (!world2Enabled(env) || Number(port) === 0) return false;
  const run = async () => {
    if (timer.running) return;
    timer.running = true;
    try {
      const r = await tick();
      timer.last = { at: new Date().toISOString(), line: r.line };
      if (r.due) log.log?.(`[arrivals] ${r.line}`);
    } catch (e) {
      timer.last = { at: new Date().toISOString(), error: String(e?.message ?? e).slice(0, 200) };
      log.error?.(`[arrivals] the tick could not read the queue: ${timer.last.error}`);
    } finally { timer.running = false; }
  };
  run();
  timer.handle = setInterval(run, ARRIVAL_TICK_MS);
  timer.handle.unref?.();
  return true;
}

/** Tests only: stop the timer. */
export function stopArrivalTick() { if (timer.handle) clearInterval(timer.handle); Object.assign(timer, { handle: null, running: false, last: null }); }

/** The tick's last run, for an operator. */
export const arrivalTickLast = () => timer.last;
