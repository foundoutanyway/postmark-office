// soft-steps-chests-drops.test.mjs — the keep tick's chests and drops steps reach
// the one alarm route (POS-627, from review-612's POS-612 re-check).
//
//   node --test test/soft-steps-chests-drops.test.mjs
//
// settlements-backfill.mjs --apply runs four soft steps after the settlement
// rows: carried, chests, amends and drops. Each is non-fatal by design (rows
// written stay written, the run exits 0, `settlements` reads ok), so a step
// failing on every tick alarmed nowhere. POS-612 recorded carried and amends as
// their own keep steps; this does the same for chests (WLD-27's first stock)
// and drops (WLD-27 F0's orphaned set-downs).
//
// THE LINES ARE THE STEPS' OWN. Every line below is produced by the real step
// function (stockedOnTick, chestsAfterCarried, stockChests on a store that
// answers the law query, dropsRecoveredOnTick), so a reworded line reds here
// instead of silently reading "refused" on the box.
//
// ONE MAPPING WAS A DECISION, not a reading (Wright 10-14): public world main
// declares no chest class (the candy heist is the private spire fork), so on
// prod the chests step answers "not stocked — the law at S<n> declares no chest
// class" on every tick. That is the honest empty, like "stocked 0": ok. A store
// with no ingested law at all is a broken prerequisite: refused prereq:law.
//
// THE CAN-FAIL FLIPS: drop `keep_step chests` or `keep_step drops` from
// office-keep.sh; drop either from SOFT_STEPS or from the manifest; read any
// chests or drops line as ok. Each reds a case below.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  softStepStatus, SOFT_STEP_RULES, stockedOnTick, chestsAfterCarried, dropsRecoveredOnTick,
} from "../world2/tools/settlements-backfill.mjs";
import { stockChests } from "../world2/tools/chest-stock.mjs";
import { SOFT_STEPS, STEPS, buildReceipt, appendReceipt, judgeKeep, REASON_RE } from "../deploy/keep-history.mjs";

const OFFICE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A client that answers the law query with `lawRows` and every other query with no rows. */
const lawClient = (lawRows) => ({ query: async (sql) => (/law_projection/.test(sql) ? { rows: lawRows } : { rows: [] }) });
const LAW_ROW = { number: 108, tag_sha: "a".repeat(40), newest: 108, kind: "class", key: "candy", data: {} };

test("chests: the step's own lines, from its own functions, read as ruled", async () => {
  // ok: the stock ran (nothing owed is `stocked 0`)
  const none = await stockedOnTick(lawClient([LAW_ROW, { ...LAW_ROW, key: "chest", data: { dials: {} } }]), { crossing: () => 0 });
  assert.match(none.line, /^chests: stocked 0/);
  assert.equal(softStepStatus(none.line, "chests"), "ok");
  // ok: the law declares no chest class (prod's public world, every tick)
  const noClass = await stockChests(lawClient([LAW_ROW]));
  assert.equal(noClass.line, "chests: not stocked — the law at S108 declares no chest class — nothing to stock");
  assert.equal(softStepStatus(noClass.line, "chests"), "ok", "the honest empty: nothing to stock is not a failure");
  // refused prereq:law: no ingested law at all
  const noLaw = await stockChests(lawClient([]));
  assert.match(noLaw.line, /^chests: not stocked — the store holds no settlement whose law is ingested/);
  assert.equal(softStepStatus(noLaw.line, "chests"), "refused prereq:law");
  // refused prereq:carried: held behind a carried step that did not settle
  const held = await chestsAfterCarried(null, { verdict: "error" });
  assert.match(held.line, /^chests: not stocked this tick — the carried step did not settle/);
  assert.equal(softStepStatus(held.line, "chests"), "refused prereq:carried");
  // refused write-failed: the stock threw
  const threw = await stockedOnTick(null, { stock: async () => { throw new Error("boom"); }, crossing: () => 0 });
  assert.equal(threw.line, "chests: NOT stocked (non-fatal) — boom");
  assert.equal(softStepStatus(threw.line, "chests"), "refused write-failed");
});

test("drops: restored N is ok, undecided drops included (asked again by design); a failed reconcile is refused", async () => {
  const quiet = await dropsRecoveredOnTick(null, { recover: async () => ({ line: "drops: restored 0" }), crossing: () => 0 });
  assert.equal(softStepStatus(quiet.line, "drops"), "ok");
  const busy = await dropsRecoveredOnTick(null, {
    recover: async () => ({ line: "drops: restored 1 (act 9 → 1 lantern back to keith) · 1 undecided, asked again next tick (act 12: store busy)" }), crossing: () => 0 });
  assert.equal(softStepStatus(busy.line, "drops"), "ok", "an undecided drop is the step working, not failing");
  const threw = await dropsRecoveredOnTick(null, { recover: async () => { throw new Error("boom"); }, crossing: () => 0 });
  assert.equal(threw.line, "drops: NOT reconciled (non-fatal) — boom");
  assert.equal(softStepStatus(threw.line, "drops"), "refused write-failed");
});

test("every step: no line is notrun, a line nobody wrote a rule for is refused, and every reason is one the receipt keeps", () => {
  for (const step of ["carried", "chests", "amends", "drops"]) {
    assert.equal(softStepStatus("0 rows written", step), "notrun", step);
    assert.equal(softStepStatus(`${step}: something new`, step), "refused write-failed", step);
  }
  assert.deepEqual(Object.keys(SOFT_STEP_RULES), ["carried", "amends", "chests", "drops"]);
  const reasons = new Set(Object.values(SOFT_STEP_RULES).flat().map(([, w]) => w.split(" ")[1]).filter(Boolean));
  for (const r of [...reasons, "write-failed"]) assert.match(r, REASON_RE, r);
});

test("office-keep.sh records chests and drops as their own keep steps, from the run's own output", () => {
  const sh = readFileSync(join(OFFICE, "deploy", "office-keep.sh"), "utf8").replace(/\r\n/g, "\n");
  const lines = sh.split("\n");
  for (const step of ["carried", "chests", "amends", "drops"]) {
    const want = `keep_step ${step} $(printf '%s\\n' "$settled" | node world2/tools/settlements-backfill.mjs --soft-step ${step} 2>/dev/null || echo notrun)`;
    assert.ok(lines.includes(want), `${step}: ${want}`);
    assert.ok(sh.indexOf(want) > sh.indexOf("keep_step settlements ok"), `${step} is read after the run that printed its line`);
  }
});

test("the roll-call alarms on three scheduled ticks whose chests or drops step was refused, though settlements read ok", () => {
  const manifest = JSON.parse(readFileSync(join(OFFICE, "deploy", "box-rollcall-manifest.json"), "utf8"));
  const keep = manifest.units.find((r) => r.unit === "postmark-office-keep.timer");
  for (const step of ["chests", "drops"]) {
    assert.ok(SOFT_STEPS.includes(step), `${step} is a soft step`);
    assert.ok(STEPS.includes(step), `${step} is in the receipt's step list`);
    assert.ok(keep.outcome.steps.includes(step), `the manifest's keep outcome judges ${step}`);
  }
  const T = Date.parse("2026-10-14T19:07:00Z");
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  for (const [step, reason] of [["chests", "prereq:law"], ["drops", "write-failed"]]) {
    let log = "";
    for (let i = 0; i < 3; i++) {
      const okSteps = SOFT_STEPS.filter((s) => s !== step).map((s) => `${s}\tok\t`).join("\n");
      log = appendReceipt(log, buildReceipt({
        stepsText: `${okSteps}\n${step}\trefused\t${reason}`, source: "scheduled", run: `r${i}`,
        started: iso(T + i * 15 * 60e3), at: iso(T + i * 15 * 60e3 + 60e3), exit: 0 }));
    }
    const alarms = judgeKeep(log, { steps: keep.outcome.steps, n: 3, staleMinutes: 45, now: T + 32 * 60e3 });
    assert.deepEqual(alarms, [`${step} has not been ok on the last 3 scheduled ticks (refused, refused, refused)`], step);
  }
});
