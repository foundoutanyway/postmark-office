// chest-stock.mjs — THE FIRST STOCK OF A CHEST, at the settlement that admits it
// (WLD-27; Wright, 2026-10-12T23:59Z, 2026-10-13T00:01Z and 00:09Z).
//
// "A resident's chest mark is born at settlement. At the settlement admitting
// it, town stocking adds min(30, capacity) of that resident's label, once.
// Admission/replay must not repeatedly stock the same chest." And: "If the
// placer has NO candy label, ADMIT the chest UNSTOCKED … the receipt names
// `chest-unstocked: <handle> has no candy label` … When that resident registers
// later, stock at the NEXT settlement that finds the label, exactly once with
// the SAME replay guard."
//
// ── WHO RUNS IT ─────────────────────────────────────────────────────────────
//
// `settlements-backfill.mjs --apply` on the office tick, right after the
// settlement rows and the carried rows (`stockedOnTick`, beside
// `carriedOnTick`), as `office_api` — the pen that writes `acts`. The clearing
// itself cannot: `clearing_job` holds no INSERT on `acts` (002_grants.sql). So a
// chest is stocked by the tick that first sees the settlement which admitted
// it, and the act names that settlement.
//
// ── WHY IT IS ONCE ──────────────────────────────────────────────────────────
//
// Two walls, either alone sufficient:
//   1. the plan skips every chest the record already shows a `units:stock` act
//      for (world-stacks.mjs § planChestStock), and
//   2. the act carries the nonce `stock:<chest id>` under the town's own pen
//      (actor postmark-pen, household the-town), and `acts_world_nonce_once`
//      (052) is UNIQUE on (household, actor, action, nonce): a second insert —
//      a replay, a retry, two ticks racing — is `ON CONFLICT DO NOTHING`.
// An unstocked admission writes NO act, so it never counts as the first stock.
//
// ── WHAT IT READS ───────────────────────────────────────────────────────────
//
// The labels and the chest dials from the CLASS LAYER AT THE PIN (law-classes
// § LAW_AT_BLESSING_SQL: the newest settlement whose law is ingested) — the
// candy class's `labels: [{label, name, creator}]` is the one source; the
// standing chests from `marks` (data->>'class' = 'chest'); the unit acts from
// `acts`. It writes nothing but the stock acts, and never a ledger line.

import { LAW_AT_BLESSING_SQL, lawSnapshotFromRows } from "../../src/law-classes.mjs";
import { UNIT_ACTION, foldUnits, stockedChests, candyLabels, planChestStock } from "../../src/world-stacks.mjs";

export const TOWN_PEN = "postmark-pen";
export const TOWN_HOUSEHOLD = "the-town";
export const stockNonce = (chest) => `${UNIT_ACTION.stock}:${chest}`; // act-nonce.mjs § keptNonce's spelling

const CHESTS_SQL = `SELECT slug, owner, data FROM marks WHERE status = 'standing' AND data->>'class' = 'chest' ORDER BY slug`;
const UNITS_SQL = `SELECT id, class, action, object, payload FROM acts WHERE class = 'holding' AND action LIKE 'units:%' ORDER BY at, id`;
const NEWEST_SQL = `SELECT number FROM settlements ORDER BY number DESC LIMIT 1`;
const INSERT_SQL = `
  INSERT INTO acts (at, crossing, actor, action, object, class, payload, effect, household, nonce)
  VALUES (now(), $1, $2, $3, $4, 'holding', $5::jsonb, $6, $7, $8)
  ON CONFLICT DO NOTHING
  RETURNING id`;

/** The plan, from the store, without writing. */
export async function planFromStore(client) {
  const law = lawSnapshotFromRows((await client.query(LAW_AT_BLESSING_SQL)).rows);
  if (!law) return { unreadable: "the store holds no settlement whose law is ingested — the candy labels cannot be read, so nothing is stocked" };
  const candy = law.classes.get("candy") ?? null;
  const chestRec = law.classes.get("chest") ?? null;
  if (!chestRec) return { unreadable: `the law at S${law.pin.settlement} declares no chest class — nothing to stock` };
  const dials = typeof chestRec.dials === "string" ? JSON.parse(chestRec.dials) : (chestRec.dials ?? {});
  const chests = (await client.query(CHESTS_SQL)).rows.map((r) => {
    const d = typeof r.data === "string" ? JSON.parse(r.data) : (r.data ?? {});
    return { id: String(r.slug), by: String(d.by ?? r.owner ?? String(r.slug).split("/")[0]), capacity: d.capacity ?? null };
  });
  const units = (await client.query(UNITS_SQL)).rows;
  const newest = (await client.query(NEWEST_SQL)).rows[0]?.number ?? null;
  const plan = planChestStock({ chests, labels: candyLabels(candy), stocked: stockedChests(units), fold: foldUnits(units), dials });
  return { ...plan, settlement: newest == null ? null : Number(newest), law: law.pin };
}

/**
 * Stock what the plan says, in one transaction. Answers
 * `{ stocked: [...], skipped: [...], unstocked: [...], refused: [...], line }`.
 * `crossing` is the town clock to stamp (the caller's currentCrossing()).
 */
export async function stockChests(client, { crossing = null } = {}) {
  const plan = await planFromStore(client);
  if (plan.unreadable) return { stocked: [], skipped: [], unstocked: [], refused: [], line: `chests: not stocked — ${plan.unreadable}` };
  const stocked = [], skipped = [];
  await client.query("BEGIN");
  try {
    for (const s of plan.stock) {
      if (s.n <= 0) { skipped.push({ chest: s.chest, why: "already full" }); continue; }
      const payload = { units: true, moves: [{ from: null, to: s.chest, label: s.label, n: s.n }], label: s.label,
        capacity: s.capacity, creator: s.handle, settlement: plan.settlement, first_stock: true };
      const effect = `the town stocked ${s.chest} with ${s.n} ${s.label} at the settlement that admitted it (S${plan.settlement})`;
      const { rows } = await client.query(INSERT_SQL, [crossing, TOWN_PEN, UNIT_ACTION.stock, s.chest, JSON.stringify(payload), effect, TOWN_HOUSEHOLD, stockNonce(s.chest)]);
      if (rows.length) stocked.push({ ...s, act: Number(rows[0].id) }); else skipped.push({ chest: s.chest, why: "already stocked (the nonce was spent)" });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
  const parts = [
    `chests: stocked ${stocked.length}${stocked.length ? ` (${stocked.map((s) => `${s.chest} +${s.n} ${s.label}`).join(", ")})` : ""}`,
    ...plan.unstocked.map((u) => u.line),
    ...plan.refused.map((r) => r.line),
  ];
  return { stocked, skipped, unstocked: plan.unstocked, refused: plan.refused, settlement: plan.settlement, line: parts.join(" · ") };
}
