// chest-lock.mjs — ONE CHEST, ONE WRITER AT A TIME, ACROSS PROCESSES (WLD-27).
//
// Bevel's first review, finding 6: the settlement tick's first stock read the
// chest's count BEFORE its transaction and the office's gives read it in
// another process, so a give of 4 landing between the stock's plan and its
// insert left 24 in a chest of 20. The hold queue serializes one process; the
// stock nonce serializes stock against stock. Neither sees the other writer.
//
// So every write that ADDS to a chest — a give into it, a refill, a whole thing
// put in, and the tick's stock — takes the same Postgres advisory lock for that
// chest INSIDE its own write transaction, re-reads the chest there, and only
// then decides. A transaction-scoped advisory lock is released by its COMMIT or
// ROLLBACK, so nothing is left held if a writer dies. Takes (which only
// subtract) take no lock: they can never overfill.

import { pgHoldingRows, pgAttachmentsFor } from "../world2/tools/guard-reads.mjs";
import { foldUnits, totalOf, isUnitRow } from "./world-stacks.mjs";

/** The lock's key text; Postgres hashes it to the advisory key. */
export const chestLockKey = (chest) => `wld27-chest:${chest}`;
export const CHEST_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))";

/** Whole things a chest holds now, from attachment rows (latest per thing wins). */
export function thingsIn(attachmentRows, chest) {
  const last = new Map();
  for (const r of attachmentRows) last.set(String(r.target), r);
  let n = 0;
  for (const r of last.values()) if (r.policy === "cascade" && String(r.entity) === String(chest)) n += 1;
  return n;
}

/** Inside a transaction: take the chest's lock, then read how full it is. */
export async function lockedChestUse(client, chest) {
  await client.query(CHEST_LOCK_SQL, [chestLockKey(chest)]);
  const units = (await pgHoldingRows(client, {})).filter(isUnitRow);
  const { rows: held } = await pgAttachmentsFor(client);
  return { units: totalOf(foldUnits(units), chest), things: thingsIn(held, chest) };
}

const bounce = (code, defect, hint, extra = {}) => {
  const e = new Error(defect);
  Object.assign(e, { code, defect, hint, ...extra });
  return e;
};

/**
 * The pen guard for an office write that adds `adding` to `chest`: run inside
 * the write's own transaction, before its act is inserted (world2-pen.mjs §
 * penWrite `guard`). Refuses — and so rolls the transaction back, writing
 * nothing — when the chest has no room for it under the lock.
 */
export const chestRoomGuard = ({ chest, capacity, adding }) => async (client) => {
  const used = await lockedChestUse(client, chest);
  const total = used.units + used.things;
  if (total + adding > capacity)
    throw bounce(409, `${chest} has room for ${Math.max(capacity - total, 0)}, not ${adding}`,
      `its capacity is ${capacity} and it holds ${total} now (units of every label and whole things); another hand reached it first. Nothing was recorded.`,
      { room: Math.max(capacity - total, 0) });
};
