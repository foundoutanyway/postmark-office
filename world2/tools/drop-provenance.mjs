// drop-provenance.mjs — A DROPPED UNIT'S MARK IS PROVED AGAINST ITS ACT (WLD-27).
//
// Wright, 2026-10-13T01:19:15Z (AUTHORITY): the World's grammar is shape-only
// — it cannot see the store — so "at settlement, in the office fold/publication
// of the dropped mark, resolve `dropped: act:<N>` from the existing act log. It
// must exist, be the unit DROP act, and match BOTH mark author/act actor and
// candy label." An unproven reference withholds ONLY that mark, named
// `dropped-unit-unproven: act <N>`; the settlement is never failed or held.
//
// The act log is `acts` and the drop is `units:drop` (world-stacks.mjs §
// UNIT_ACTION.drop), class `holding`, actor the dropper, its one move
// `{ from: <dropper>, to: null, label, n: 1 }`. No second provenance store.

export const UNIT_DROP = "units:drop";
export const DROP_REF = /^act:([1-9][0-9]*)$/;

/** Is this pending claim a resident's candy mark (a unit set down)? The town's own candy is not. */
export const isCandyClaim = (c) => (c?.class === "sited" || c?.class == null) && c?.data?.class === "candy" && c?.claimant !== "the-town";

/**
 * The refusal check for one candy claim, given the act its reference names (or
 * null when there is none), or null when it is proved. PURE.
 */
export function dropProvenanceCheck(claim, act) {
  const d = claim?.data ?? {};
  const m = DROP_REF.exec(String(d.dropped ?? ""));
  if (!m) return "dropped-unit-unproven: no act";
  const n = m[1];
  const fail = `dropped-unit-unproven: act ${n}`;
  if (!act) return fail;                                             // fabricated: no such act
  if (act.action !== UNIT_DROP || act.class !== "holding") return fail; // not the unit drop
  if (String(act.actor) !== String(claim.claimant)) return fail;    // another hand's drop
  const p = act.payload ?? {};
  const moved = Array.isArray(p.moves) ? p.moves.find((x) => x?.to == null) : null;
  const label = p.label ?? moved?.label ?? null;
  if (label == null || String(label) !== String(d.label)) return fail; // another label
  if (moved && moved.from != null && String(moved.from) !== String(claim.claimant)) return fail;
  return null;
}

/**
 * Every pending candy claim, checked against `acts` in the clearing's own
 * transaction. `refuse(claim, check)` is the clearing's refuse-alone: the claim
 * is refused with the named check and goes on the window's unfileable list.
 */
export async function checkDroppedUnits(q, pending, { decided = () => false, refuse }) {
  const refused = [];
  for (const c of pending) {
    if (decided(c) || !isCandyClaim(c)) continue;
    const m = DROP_REF.exec(String(c.data?.dropped ?? ""));
    let act = null;
    if (m) {
      const { rows } = await q("SELECT id, action, class, actor, payload FROM acts WHERE id = $1", [Number(m[1])]);
      act = rows[0] ?? null;
    }
    const check = dropProvenanceCheck(c, act);
    if (check) { refuse(c, check); refused.push({ id: c.id, check }); }
  }
  return refused;
}
