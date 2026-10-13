// mark-stake-lock.mjs — NO STAKE LANDS BEHIND A MARK THAT HAS LEFT (WLD-27, A).
//
// Wright's independent review (AUTHORITY 2026-10-13T05:20:23Z, A): "the stake
// door refuses a mark whose exit act is recorded. The exit commits before
// lateReturns, so no stake can land after it" — and the public withdraw door
// "has the same read-then-write gap". Before this file, a stake that passed its
// door's checks could reach the ledger after a dropped unit's exit was
// recorded (world-units.mjs § markExit) and after the late-return pass had
// read the holders, or after the public withdraw door had read no escrow; the
// stamps then stood behind a mark that had already left.
//
// ── ONE LOCK PER MARK, TAKEN BY EVERY SIDE OF THE RACE ──────────────────────
//
// `wld27-mark:<id>`, a transaction-scoped Postgres advisory lock — the shape
// drop-recovery.mjs (`wld27-drop:<id>`) and chest-lock.mjs already use, so no
// grant, table or migration. The ledger is the town clone's file, written by
// world-stake-exec.mjs under the town's flock; the record of a mark leaving is
// an act in the store. The lock is what orders the two:
//
//   · THE STAKE (world-stake-exec.mjs, under the town flock): takes the lock,
//     asks the record whether the mark has left — a dropped unit's exit act, or
//     a withdrawal that is the mark's newest mark act — and refuses before the
//     engine runs if it has; otherwise it appends the ledger line and only then
//     releases. A stake that was admitted is ON THE LEDGER FILE before anyone
//     else holds the lock.
//   · THE EXIT (world-units.mjs § lateReturns): its exit act commits first;
//     then it takes and releases the lock once (`stakeBarrier`) before reading
//     the holders. A stake admitted before the exit committed has finished its
//     line by then, so the read sees it and returns it; a stake asking after
//     the exit committed is refused. The barrier holds nothing while the
//     returns run, so an unstake inside the hold turn never waits on it.
//   · THE PUBLIC WITHDRAWAL (world.mjs § withdrawMarkViaOffice): reads the
//     escrow UNDER the lock inside the withdrawal's own write transaction
//     (`withdrawEscrowGuard`), so a stake either landed before the read (the
//     withdrawal is refused) or asks after the withdrawal committed (refused).
//   · THE PROMOTION (world2-claims.mjs § promoteDraftOnStake): asks the same
//     exit question under the same lock inside its own transaction, so a stake
//     on an exited unit's draft never puts it forward.
//
// LOCK ORDER, everywhere: the candle (shared) → a drop's lock → a mark's lock.
// The exec and the barrier take only the mark's; the tick only a drop's.
//
// No distributed transaction is claimed: the ledger push that follows the
// append can still fail, and penTransaction then rolls the line back — a
// withdrawal refused because of a stake that did not land after all is the
// safe direction, and is retried.

import { UNIT_ACTION } from "./world-stacks.mjs";

export const markLockKey = (id) => `wld27-mark:${String(id)}`;
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))";

// `acts_object_idx (object, id)` (001) answers both: one mark's acts by id.
const EXIT_SQL = `
  SELECT id::text, action, actor FROM acts
   WHERE object = $1 AND class = 'holding' AND action IN ($2, $3)
   ORDER BY id LIMIT 1`;
const NEWEST_MARK_ACT_SQL = `
  SELECT id::text, action FROM acts
   WHERE object = $1 AND class = 'mark' AND action IN ('leave-mark', 'amend', 'withdraw')
   ORDER BY id DESC LIMIT 1`;

const ROUTE = { [UNIT_ACTION.takeBack]: "taken back", [UNIT_ACTION.consumeInPlace]: "consumed where it stood" };

/** A dropped unit's recorded exit — `{ act, action, by }` — or null. */
export async function exitOf(client, id) {
  const { rows: [r] } = await client.query(EXIT_SQL, [String(id), UNIT_ACTION.takeBack, UNIT_ACTION.consumeInPlace]);
  return r ? { act: r.id, action: r.action, by: r.actor } : null;
}

/**
 * Has this mark left the record? Its dropped unit's exit, or — with
 * `withdrawn` — a withdrawal that is its newest mark act (a mark left again
 * after a withdrawal, or put forward again, stands and is stakeable). The
 * withdrawal half is asked only where the mark's own deed is already on the
 * record: a staked draft's leave act is released by its promotion, before the
 * ledger runs, so the exec sees it; the door's earlier checks would not.
 */
export async function leftOf(client, id, { withdrawn = true } = {}) {
  const exit = await exitOf(client, id);
  if (exit) return { left: "exit", ...exit };
  if (!withdrawn) return null;
  const { rows: [m] } = await client.query(NEWEST_MARK_ACT_SQL, [String(id)]);
  return m?.action === "withdraw" ? { left: "withdrawn", act: m.id } : null;
}

const bounce = (code, defect, hint, extra = {}) => Object.assign(new Error(defect), { code, defect, hint, ...extra });

/** The refusal a stake on a mark that has left gets, before any stamp moves or any claim is put forward. */
export function leftRefusal(id, left) {
  return left.left === "exit"
    ? bounce(409, `"${id}" has left the world — its unit was ${ROUTE[left.action] ?? "taken"} (act ${left.act})`,
      "a dropped unit's mark stops being a mark when it is taken back or consumed, and nothing can be staked on it after that. Nothing was staked and your stamps are untouched.",
      { stakeLeft: left })
    : bounce(409, `"${id}" was withdrawn (act ${left.act})`,
      "a withdrawn mark has nothing for stamps to stand behind; leave it again to bring it back. Nothing was staked and your stamps are untouched.",
      { stakeLeft: left });
}

/** Under the mark's lock in `client`'s transaction: refuse a stake on a mark that has left. */
export const stakeGuard = (id, { withdrawn = false } = {}) => async (client) => {
  await client.query(LOCK_SQL, [markLockKey(id)]);
  const left = await leftOf(client, id, { withdrawn });
  if (left) throw leftRefusal(id, left);
};

/**
 * THE STAKE'S SIDE, for world-stake-exec.mjs: on its own connection, take the
 * mark's lock, ask the record, and run `apply` (the engine's synchronous
 * ledger append) while still holding it. An office pointed at no record has
 * no act that could say a mark left, so it stakes as before; an office pointed
 * at one it cannot reach refuses — an unanswered question is not a "no".
 */
export async function stakeUnderMarkLock(id, apply, { env = process.env } = {}) {
  const { world2Enabled } = await import("./world2-acts.mjs");
  if (!world2Enabled(env)) return apply();
  const { default: pg } = await import("pg");
  const { storePoolOptions } = await import("./store-pool.mjs");
  const c = new pg.Client(storePoolOptions(env, { name: "stake-exec", max: 1 }));
  try { await c.connect(); }
  catch (e) {
    throw bounce(503, "the record could not be asked whether this mark has left",
      `nothing was staked and your stamps are untouched — try again (${String(e?.message ?? e).slice(0, 120)})`);
  }
  try {
    await c.query("BEGIN");
    await stakeGuard(id, { withdrawn: true })(c);
    const out = await apply();
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { await c.end().catch(() => {}); }
}

/**
 * THE EXIT'S SIDE: take and release the mark's lock once. Every stake admitted
 * before this returns has its line on the ledger file; every stake asking
 * after it finds the exit already committed. Called AFTER the exit act commits.
 */
export async function stakeBarrier(id, { write = null } = {}) {
  const w = write ?? (await import("./world2-pen.mjs")).officeWrite;
  await w((c) => c.query(LOCK_SQL, [markLockKey(id)]));
}

/**
 * THE PUBLIC WITHDRAWAL'S SIDE, as its write transaction's guard: under the
 * mark's lock, the escrow is read again and a staked mark is refused. `escrow`
 * answers the stamps standing on the mark, or throws when the ledger cannot be
 * read — and an unreadable ledger refuses, never reads as "nothing staked".
 */
export const withdrawEscrowGuard = ({ mark, escrow }) => async (client) => {
  // THE CANDLE FIRST, shared, as the docket half of this same withdrawal takes
  // it anyway: every transaction that holds both takes the candle before the
  // mark (the promotion does), so none waits on the other in reverse.
  const { DOOR_SHARES_THE_CANDLE } = await import("../world2/tools/candle-lock.mjs");
  await client.query(DOOR_SHARES_THE_CANDLE);
  await client.query(LOCK_SQL, [markLockKey(mark)]);
  let n;
  try { n = await escrow(mark); }
  catch (e) {
    throw bounce(503, `the stakes on "${mark}" could not be read`,
      `a mark is withdrawn only when nothing is staked on it, and the ledger did not answer — your mark is exactly as it was; try again (${String(e?.defect ?? e?.message ?? e).slice(0, 120)})`);
  }
  if (Number(n) > 0) throw bounce(409, `${n}✦ stand in escrow on "${mark}" — a staked mark cannot be withdrawn`,
    "a stake landed while the withdrawal was being made — your own stake comes back with world_unstake; another's must be unstaked by its owner. Nothing was withdrawn.");
};
