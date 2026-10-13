// mists-forecast.mjs — WHEN THE MISTS REACH A MARK (WLD-38, the doorstep and
// placement half; the gate half shipped in World#194).
//
// Wright, AUTHORITY 2026-10-13T05:16:12Z: the forecast is the EARLIEST ACTUAL
// integer crossing at which the advancing Mists reach a mark — by the World
// engine's own interpolation, crossing by crossing over the authored schedule,
// never the next keyframe — with the FRINGE (sight shortened) and the WALL
// (hidden) reported separately. An unreadable forecast is NONFATAL and named
// `mists-forecast-unavailable: <why>`, never a false "clear". A mark the wall
// already stands over gets a warning, not a veto.
//
// ── ONE COMPUTATION, NOTHING STORED ─────────────────────────────────────────
//
// The engine owns the season: `mistsAt(c, mists)` interpolates the front per
// side between keyframes (and holds it after the last), and `mistsHere(p, m)`
// says, for a point, whether it is behind the wall (`inWall`) and how far it
// stands from it (`wallM`). The fringe is `fringe_m` wide: a point not in the
// wall but nearer to it than `fringeM` is in the fringe. Clearings are the
// engine's own exceptions — `mistsHere` already counts them as clear ground.
// This module adds no season, no schedule and no law; it asks the engine.
//
// A mark is its FOOTPRINT, not its centre: its outline ring (or its extent
// box), every corner and every side sampled every few metres. The wall is one
// region around the clear ground, so a footprint whose boundary stands clear
// has no wall inside it, and the nearest wall to any inside point lies past the
// boundary — so the boundary answers both the wall and the fringe.
//
// Every answer is computed at the read from the record's schedule and the
// marks as they stand. No notice is kept, nothing is delivered, no mark moves.

import { crossingSailsAt, currentCrossing } from "./crossings.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export const MISTS_FORECAST_UNAVAILABLE = "mists-forecast-unavailable";
const unavailable = (why) => ({ unavailable: `${MISTS_FORECAST_UNAVAILABLE}: ${why}` });

/** Sample a closed ring: every corner, and points every `stepM` metres along each side. */
export function samplesOf(ring, stepM = 5) {
  const out = [];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / stepM));
    for (let k = 0; k < n; k += 1) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Where a footprint stands at one Mists state: "wall", "fringe" or "clear". */
export function footprintState(eng, m, samples) {
  let fringe = false;
  for (const p of samples) {
    const h = eng.mistsHere(p, m);
    if (h.inWall) return "wall";
    if (Number(m.fringeM) > 0 && h.wallM < m.fringeM) fringe = true;
  }
  return fringe ? "fringe" : "clear";
}

const scheduleOf = (mists) => (Array.isArray(mists?.schedule) ? mists.schedule : [])
  .map((k) => Number(k?.crossing)).filter(Number.isInteger).sort((a, b) => a - b);

/**
 * The first crossing, from `now` on, at which the fringe and the wall reach
 * this footprint — `null` for each that never does within the authored
 * schedule (after its last keyframe the front holds, so nothing changes). A
 * reach at or before `now` is the present, not a future arrival.
 */
export function reachOf(eng, mists, samples, now) {
  const keys = scheduleOf(mists);
  if (!keys.length || !samples.length) return { fringe: null, wall: null };
  const last = keys[keys.length - 1];
  let fringe = null, wall = null;
  for (let c = Math.max(now, keys[0]); c <= Math.max(last, now); c += 1) {
    const m = eng.mistsAt(c, mists);
    if (!m) continue;
    const st = footprintState(eng, m, samples);
    if (st !== "clear" && fringe == null) fringe = c;
    if (st === "wall") { wall = c; break; }
  }
  return { fringe, wall };
}

const day = (c) => crossingSailsAt(c).slice(0, 10);
const when = (c, now) => ({ crossing: c, date: day(c), now: c <= now });

/** The household's sentences for one mark — fringe and wall said apart; the mark stays theirs. */
export function sentencesFor(id, { fringe, wall }) {
  const says = [];
  if (fringe && (!wall || fringe.crossing < wall.crossing))
    says.push(fringe.now
      ? `${id} stands in the fringe of the Mists now: sight is shorter there, nothing is hidden, and it stays yours`
      : `the fringe of the Mists reaches ${id} from crossing ${fringe.crossing} (${fringe.date}): sight will be shorter there, nothing hidden, and it stays yours`);
  if (wall)
    says.push(wall.now
      ? `the wall of the Mists stands over ${id} now; it stays yours and comes back when they lift`
      : `the wall of the Mists reaches ${id} from crossing ${wall.crossing} (${wall.date}); it stays yours and comes back when they lift`);
  return says;
}

/** Import the World engine from a clone; null when it cannot be read. */
export async function mistsEngine(worldClone) {
  try {
    const eng = await import(pathToFileURL(join(String(worldClone), "tools", "world-engine.mjs")).href);
    return typeof eng.mistsAt === "function" && typeof eng.mistsHere === "function" ? eng : null;
  } catch { return null; }
}

/**
 * THE FORECAST for a list of `{ id, ring }` footprints. `skeleton` is the
 * world's skeleton (`undefined`/throwing reader = unreadable; one without
 * `mists` = no season at all). `nowMs` is the one clock for the read.
 *
 * Answers one of:
 *   · `{ season: false }` — the record carries no Mists: nothing to forecast;
 *   · `{ unavailable: "mists-forecast-unavailable: <why>" }` — it could not be
 *     read; never an empty, safe-looking answer;
 *   · `{ as_of: { crossing, date }, season_ends: N, reaches: [...] }` — every
 *     footprint the fringe or the wall reaches within the schedule, earliest
 *     crossings first. An empty `reaches` is a forecast that read and found
 *     nothing, which is different from no forecast.
 */
export async function forecastMists({ engine, skeleton, footprints = [], nowMs = Date.now() }) {
  if (skeleton === undefined) return unavailable("the world's skeleton could not be read");
  if (!skeleton?.mists) return { season: false };
  const eng = engine ?? null;
  if (!eng) return unavailable("the World engine's Mists reading could not be loaded");
  const keys = scheduleOf(skeleton.mists);
  if (!keys.length) return unavailable("the Mists record carries no schedule the engine can read");
  const now = currentCrossing(nowMs);
  const reaches = [];
  try {
    for (const f of footprints) {
      const samples = samplesOf(f.ring ?? []);
      if (!samples.length) continue;
      const r = reachOf(eng, skeleton.mists, samples, now);
      if (r.fringe == null && r.wall == null) continue;
      const out = { mark: f.id, fringe: r.fringe == null ? null : when(r.fringe, now), wall: r.wall == null ? null : when(r.wall, now) };
      reaches.push({ ...out, says: sentencesFor(f.id, out) });
    }
  } catch (e) {
    return unavailable(`the engine could not answer (${String(e?.message ?? e).slice(0, 120)})`);
  }
  reaches.sort((a, b) => (a.fringe?.crossing ?? a.wall?.crossing) - (b.fringe?.crossing ?? b.wall?.crossing) || String(a.mark).localeCompare(String(b.mark)));
  return { as_of: { crossing: now, date: day(now) }, season_ends: keys[keys.length - 1], reaches };
}

// ── THE HOUSEHOLD'S DOORSTEP ────────────────────────────────────────────────

/**
 * The forecast for every PUBLISHED mark a household's residents made — the
 * marks on the town's map, which anyone may already see, so this block shows
 * nothing a stranger could not read off the map; no draft is read. Residents
 * come from the household registry (every spelling the house answers to
 * resolves to the same block), not from one handle.
 *
 * Answers the doorstep block, or `null` when there is nothing to say: no world
 * this office is pointed at, no Mists on the record, or none of the house's
 * marks reached within the schedule. A world that IS there and cannot be read
 * answers `unavailable` — unknown is never empty.
 */
export async function householdMistsForecast(handle, { nowMs = Date.now(), deps = null } = {}) {
  const d = deps ?? await liveDeps();
  if (!d.pointed()) return null;
  const block = (body) => ({ serves: "world.mists", args: { handle }, ...body });
  let marks, skeleton, residents;
  try {
    residents = new Set([String(handle), ...((await d.household(handle))?.residents ?? [])]);
    marks = (d.publishedMarks() ?? []).filter((m) => m?.id && residents.has(String(m.by ?? String(m.id).split("/")[0])));
  } catch (e) { return block(unavailable(`the household's marks could not be read (${String(e?.message ?? e).slice(0, 120)})`)); }
  try { skeleton = d.skeleton() ?? undefined; } catch { skeleton = undefined; }
  if (!marks.length && skeleton !== undefined) return null;
  const engine = skeleton?.mists ? await d.engine() : null;
  const footprints = [];
  for (const m of marks) {
    const ring = await d.ringOf(m).catch(() => null);
    if (ring?.length) footprints.push({ id: String(m.id), ring });
  }
  const f = await forecastMists({ engine, skeleton, footprints, nowMs });
  if (f.unavailable) return block({ unavailable: f.unavailable });
  if (f.season === false || !f.reaches.length) return null;
  return block(f);
}

/** The live collaborators: the published world, the registry, the engine. Every one is injectable. */
async function liveDeps() {
  const [{ existsSync }, { WORLD_CLONE, groundRingOf, parcelDial }, branches, { householdOf }] = await Promise.all([
    import("node:fs"), import("./world.mjs"), import("./world-branches.mjs"), import("./households.mjs")]);
  return {
    pointed: () => existsSync(join(String(WORLD_CLONE), ".git")) || existsSync(join(String(WORLD_CLONE), "WORLD")),
    household: (h) => householdOf(h),
    publishedMarks: () => branches.publishedState(WORLD_CLONE).state?.marks ?? [],
    skeleton: () => branches.publishedSkeleton(WORLD_CLONE).skeleton ?? null,
    engine: () => mistsEngine(WORLD_CLONE),
    ringOf: async (m) => {
      if (m?.points || m?.extent) return groundRingOf(m);
      if (m?.kind === "parcel" && m?.at) { const box = await parcelDial(); return groundRingOf({ ...m, extent: box }); }
      return null;
    },
  };
}
