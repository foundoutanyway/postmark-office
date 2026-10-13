// drop-recovery.mjs — A SET-DOWN UNIT IS NEVER LOST AND NEVER COUNTED TWICE (WLD-27, F0).
//
// Wright's independent review (AUTHORITY 2026-10-13T03:01:29Z): a unit set down
// is a `units:drop` act, then its mark is filed. If the office dies between the
// two, or the compensation's own write fails, the act stands alone: the unit has
// left the dropper's hands and is on no ground. And `leaveMarkViaOffice` can
// throw AFTER its claim committed, so "the call threw" is not "nothing was
// filed". The ruling: "the office tick reconciles a committed `units:drop` older
// than one tick with neither a claim for that act nor `drop-undone`, by
// recording `drop-undone` back to the original dropper, with a receipt line" —
// and the immediate compensation asks what actually committed before it undoes.
//
// ── ONE DECISION PER DROP, TAKEN ONCE ───────────────────────────────────────
//
// Three writers decide a drop's fate: the mark's filing (its claim), the door's
// immediate compensation, and the tick's recovery. All three take the same
// transaction-scoped advisory lock for that drop act, `wld27-drop:<act id>`,
// and decide under it:
//   · the filing refuses when an undo is already on the record (dropLiveGuard);
//   · an undo refuses when the mark is filed — a claim whose own record names
//     this drop act (data.dropped = act:<id>, the dropper, the label), in any
//     status including a private draft, or a mark act whose payload names it;
//   · an undo carries the nonce `drop-undone:<act id>` under the dropper's own
//     actor and household, so `acts_world_nonce_once` (052) keeps a second one
//     out even past the lock — replay, two ticks, compensation beside recovery.
// No second provenance store: the drop act, its claim and its undo are the
// record. The ids stay exact decimal text end to end.

import { UNIT_ACTION } from "./world-stacks.mjs";

/** The drop's lock key text (hashed by Postgres to the advisory key). */
export const dropLockKey = (actId) => `wld27-drop:${String(actId)}`;
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))";

/** The undo's nonce: one per drop act, ever. */
export const undoNonce = (actId) => `${UNIT_ACTION.dropUndone}:${String(actId)}`;

/** The mark a drop files is `<dropper>/<label>-<act id>` (world-stacks.mjs § droppedUnitMark). */
export const dropMarkId = ({ actor, label, actId }) => `${actor}/${label}-${String(actId)}`;

/**
 * THE TICK'S CADENCE. The live office tick is `postmark-office-keep.timer`
 * (deploy/), `OnCalendar=*:07,22,37,52` — every 15 minutes — running
 * office-keep.sh, whose settlements-backfill `--apply` step calls the recovery
 * (settlements-backfill.mjs § dropsRecoveredOnTick). "Older than one tick" is
 * this interval; test/drop-recovery.test.mjs pins it to the timer file.
 */
export const TICK_MS = 15 * 60 * 1000;

const UNDONE_SQL = `SELECT id FROM acts WHERE action = $1 AND payload->>'undoes' = $2 LIMIT 1`;
// THE MARK IS KNOWN BY THE ACT IT NAMES (Bevel's follow-up review, A): a claim
// is this drop's mark when its own record says so — `data.dropped` is exactly
// `act:<id>`, its claimant is the dropper, its label the drop's label — in ANY
// status. Never by a slug predicted from the act: a mark filed under another
// name is still this unit, and an unrelated mark that happens to carry the
// predicted name is not. A mark act counts only on the same proof in its own
// payload (the leave's declaration carries `dropped` and `label`).
const CLAIM_SQL = `
  SELECT id::text, slug, status FROM claims
   WHERE data->>'dropped' = $1 AND claimant = $2 AND data->>'label' = $3
   ORDER BY submitted_at LIMIT 1`;
const MARK_ACT_SQL = `
  SELECT id::text, object FROM acts
   WHERE class = 'mark' AND action IN ('leave-mark', 'amend')
     AND payload->>'dropped' = $1 AND actor = $2 AND payload->>'label' = $3
   ORDER BY id LIMIT 1`;

/** Declare the dropper's household for this transaction, so its private drafts are visible to the checks. */
async function declareDropperHousehold(client, actor) {
  const [{ actHouseholdFor }, { sessionKeysVia, sessionKeyString }] = await Promise.all([
    import("./world2-claims.mjs"), import("./household-deriver.mjs")]);
  const hh = await actHouseholdFor(client, { actor });
  if (hh == null) return;
  const keys = await sessionKeysVia(client, hh).catch(() => [hh]);
  await client.query("SELECT set_config('app.household', $1, true)", [hh]);
  await client.query("SELECT set_config('app.household_keys', $1, true)", [sessionKeyString(keys) ?? hh]);
}

/**
 * Inside a transaction: is this drop's mark filed? A claim whose own record
 * names this drop act (CLAIM_SQL) in ANY status — the dropper's household is
 * declared first, so a private draft is seen too — or a mark act whose payload
 * names it. Answers `{ slug, claim, status }` (the slug the mark ACTUALLY has)
 * or null.
 */
export async function filedMarkOf(client, { actId, actor, label }) {
  const ref = `act:${String(actId)}`;
  await declareDropperHousehold(client, actor);
  const { rows: [c] } = await client.query(CLAIM_SQL, [ref, String(actor), String(label)]);
  if (c) return { slug: c.slug, claim: c.id, status: c.status };
  const { rows: [a] } = await client.query(MARK_ACT_SQL, [ref, String(actor), String(label)]);
  return a ? { slug: a.object, mark_act: a.id, status: "acted" } : null;
}

const bounce = (code, defect, hint, extra = {}) => Object.assign(new Error(defect), { code, defect, hint, ...extra });

/**
 * THE FILING'S GUARD (the claim side): under the drop's lock, refuse to file
 * the mark of a drop that was already undone — the unit is back in hands.
 */
export const dropLiveGuard = ({ actId }) => async (client) => {
  await client.query(LOCK_SQL, [dropLockKey(actId)]);
  const { rows } = await client.query(UNDONE_SQL, [UNIT_ACTION.dropUndone, String(actId)]);
  if (rows.length) throw bounce(409, `the set-down of act ${actId} was already undone`,
    "the unit came back to your hands before this mark was filed; set it down again. Nothing was recorded.");
};

/**
 * THE UNDO'S GUARD (the compensation and the recovery): under the drop's lock,
 * refuse when the mark is filed or the drop is already undone. `undoneAlready`
 * and `filed` ride the refusal so the caller can say what actually committed.
 */
export const dropUndoGuard = ({ actId, actor, label }) => async (client) => {
  await client.query(LOCK_SQL, [dropLockKey(actId)]);
  const { rows: undone } = await client.query(UNDONE_SQL, [UNIT_ACTION.dropUndone, String(actId)]);
  if (undone.length) throw bounce(409, `the set-down of act ${actId} is already undone`, "the unit is already back. Nothing was recorded.", { undoneAlready: String(undone[0].id) });
  const filed = await filedMarkOf(client, { actId, actor, label });
  if (filed) throw bounce(409, `the set-down of act ${actId} was filed as ${filed.slug} (${filed.status})`,
    "its mark committed, so the unit is on the ground, not back in hands. Nothing was recorded.", { filed });
};

/** The undo act's row, in the hold lane's unit shape, for either writer. */
export function undoEntry({ actId, actor, label, household, why, by = "door" }) {
  return {
    actor, action: UNIT_ACTION.dropUndone, object: null, cls: "holding", household,
    nonce: undoNonce(actId),
    payload: { units: true, moves: [{ from: null, to: actor, label, n: 1 }], label, undoes: String(actId), why: String(why).slice(0, 300), by },
    effect: by === "tick"
      ? `the set-down of act ${actId} was never filed, so 1 ${label} came back to ${actor} (the office tick found it orphaned)`
      : `the set-down's mark could not be filed, so 1 ${label} came back to ${actor}`,
  };
}

// ── THE TICK ─────────────────────────────────────────────────────────────────

const ORPHANS_SQL = `
  SELECT d.id::text AS id, d.actor, d.household, d.at, d.payload
    FROM acts d
   WHERE d.class = 'holding' AND d.action = $1 AND d.at < $2
     AND NOT EXISTS (SELECT 1 FROM acts u WHERE u.action = $3 AND u.payload->>'undoes' = d.id::text)
   ORDER BY d.id`;
const INSERT_UNDO_SQL = `
  INSERT INTO acts (at, crossing, actor, action, object, class, payload, effect, household, nonce)
  VALUES (now(), $1, $2, $3, NULL, 'holding', $4::jsonb, $5, $6, $7)
  ON CONFLICT DO NOTHING
  RETURNING id::text`;

const labelOf = (p) => p?.label ?? (Array.isArray(p?.moves) ? p.moves[0]?.label : null) ?? null;

/**
 * Every `units:drop` older than one tick with no undo, each decided in its own
 * transaction under its own lock: filed → left alone (the line says so, once
 * per tick); not filed → undone back to its dropper, by the nonce, once.
 * `now` is injectable. Answers `{ restored, filed, skipped, line }`.
 */
export async function recoverOrphanDrops(client, { now = Date.now(), crossing = null, olderThanMs = TICK_MS } = {}) {
  const cutoff = new Date(now - olderThanMs).toISOString();
  const { rows } = await client.query(ORPHANS_SQL, [UNIT_ACTION.drop, cutoff, UNIT_ACTION.dropUndone]);
  const restored = [], filed = [], skipped = [];
  for (const d of rows) {
    const p = typeof d.payload === "string" ? JSON.parse(d.payload) : (d.payload ?? {});
    const label = labelOf(p);
    if (!label) { skipped.push({ act: d.id, why: "the drop names no label" }); continue; }
    await client.query("BEGIN");
    try {
      await dropUndoGuard({ actId: d.id, actor: d.actor, label })(client);
      const e = undoEntry({ actId: d.id, actor: String(d.actor), label, household: d.household, why: "orphaned: no claim and no undo after one tick", by: "tick" });
      const { rows: ins } = await client.query(INSERT_UNDO_SQL, [crossing, e.actor, e.action, JSON.stringify(e.payload), e.effect, e.household, e.nonce]);
      await client.query("COMMIT");
      if (ins.length) restored.push({ act: d.id, actor: e.actor, label, undo: ins[0].id });
      else skipped.push({ act: d.id, why: "already undone (the nonce was spent)" });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err?.filed) filed.push({ act: d.id, ...err.filed });
      else if (err?.undoneAlready) skipped.push({ act: d.id, why: "already undone" });
      else throw err;
    }
  }
  const line = [
    `drops: restored ${restored.length}${restored.length ? ` (${restored.map((r) => `act ${r.act} → 1 ${r.label} back to ${r.actor}`).join(", ")})` : ""}`,
    ...(skipped.length ? [`${skipped.length} skipped (${skipped.map((s) => `act ${s.act}: ${s.why}`).join("; ")})`] : []),
  ].join(" · ");
  return { restored, filed, skipped, line };
}

// ── THE CARRY COUNT, DURABLY ────────────────────────────────────────────────

const LABEL_OF_DROP = `COALESCE(d.payload->>'label', d.payload->'moves'->0->>'label')`;
const STILL_OUT_SQL = `
  SELECT count(*)::int AS n FROM acts d
   WHERE d.class = 'holding' AND d.action = $1 AND d.actor = $2
     AND NOT EXISTS (SELECT 1 FROM acts u WHERE u.action = $3 AND u.payload->>'undoes' = d.id::text)
     AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.data->>'dropped' = 'act:' || d.id::text
                       AND c.claimant = d.actor AND c.data->>'label' = ${LABEL_OF_DROP})
     AND NOT EXISTS (SELECT 1 FROM acts m WHERE m.class = 'mark' AND m.action IN ('leave-mark', 'amend')
                       AND m.payload->>'dropped' = 'act:' || d.id::text AND m.actor = d.actor
                       AND m.payload->>'label' = ${LABEL_OF_DROP})`;

/**
 * How many of `actor`'s set-downs are still OUT — neither filed nor undone —
 * read from the store (one query; the dropper's household declared so a
 * private draft counts as filed). Each may yet come back, so the carry cap
 * counts it as held until it is known: the in-memory reservation dies with the
 * process, this does not.
 */
export async function dropsStillOut(client, actor) {
  await declareDropperHousehold(client, actor);
  const { rows: [r] } = await client.query(STILL_OUT_SQL, [UNIT_ACTION.drop, String(actor), UNIT_ACTION.dropUndone]);
  return r?.n ?? 0;
}
