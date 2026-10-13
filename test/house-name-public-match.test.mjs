// house-name-public-match.test.mjs — a house is found by its key or public name, never by its private human (POS-609).
//
//   node --test --test-concurrency=1 test/house-name-public-match.test.mjs
//
// The name road (household-deriver § VIA.NAME, through residency § houseForName)
// is how a join's `household:` line finds the house it claims (planRegistryJoin)
// and how a declaration is refused as TAKEN (declare § conformance). Matching a
// household's private `human` there let anyone who knew that name claim the
// house, or learn it from a refusal. PURE: invented registry, invented accounts,
// a probe in place of the office db, no clone, no store, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveHouse, VIA } from "../src/household-deriver.mjs";
import { houseForName, houseForAccount, planRegistryJoin } from "../src/residency.mjs";
import { conformance } from "../src/declare.mjs";
import { REFUSALS } from "../src/ceremony.mjs";

const SENTINEL = "Private Sentinel Qzrv";          // copper-gate's private human
const COLLIDER = "Brass Hollow";                   // low-field's private human, and brass-hollow's PUBLIC name

const REG = () => ({
  schema_version: 1,
  households: {
    "copper-gate": { name: "Copper Gate", human: SENTINEL, accounts: [{ login: "cg-gh", id: 9701 }], residents: ["tansy"], since: "2026-08-14" },
    "low-field": { name: "Low Field", human: COLLIDER, accounts: [{ login: "lf-gh", id: 9702 }], residents: ["sedge"], since: "2026-08-15" },
    "brass-hollow": { name: COLLIDER, accounts: [{ login: "bh-gh", id: 9703 }], residents: ["wren"], since: "2026-08-16" },
  },
});
const STRANGER = { ghId: 5555, ghLogin: "stranger-gh", household: "stranger-gh", handles: new Set(), visitor: true };
const NO_RESIDENTS = { hasResident: () => false };
const CARD = "I keep the ledger of small kindnesses for a person who forgets them. Write to me about one you remember.";
const declare = (household, registry) => {
  try { conformance({ household, handle: "pos609-newcomer", card: CARD, agent: "Newcomer" }, { db: NO_RESIDENTS, registry, clone: null, key: STRANGER }); return null; }
  catch (e) { return e; }
};

test("the name road: key and public name find the house; the private human finds nothing", () => {
  const reg = REG();
  const before = JSON.stringify(reg);
  for (const spelled of [SENTINEL, SENTINEL.toLowerCase(), "  private  SENTINEL qzrv ", "private-sentinel-qzrv"]) {
    assert.equal(resolveHouse(spelled, reg, {}, { via: [VIA.SLUG, VIA.NAME] }).slug, null, `resolveHouse "${spelled}"`);
    assert.equal(houseForName(reg, spelled), null, `houseForName "${spelled}"`);
  }
  for (const [spelled, slug] of [["Copper Gate", "copper-gate"], ["copper-gate", "copper-gate"], ["  COPPER gate ", "copper-gate"], ["Low Field", "low-field"]]) {
    assert.equal(houseForName(reg, spelled), slug, `public "${spelled}"`);
  }
  assert.equal(JSON.stringify(reg), before, "the registry is read, never changed");
  assert.equal(reg.households["copper-gate"].human, SENTINEL, "CONTROL: the private human is still stored");
});

test("a private human that equals another house's PUBLIC name finds that house, not its own", () => {
  const reg = REG();
  assert.equal(houseForName(reg, COLLIDER), "brass-hollow");
  assert.equal(houseForName(reg, "brass-hollow"), "brass-hollow");
});

test("the account road is untouched: a verified account still finds its own house", () => {
  const reg = REG();
  assert.equal(houseForAccount(reg, 9701, "cg-gh"), "copper-gate");
  assert.equal(houseForAccount(reg, 9702, "lf-gh"), "low-field");
  assert.equal(houseForAccount(reg, 5555, "stranger-gh"), null);
});

test("residency: a join that types a house's private human does not claim that house", () => {
  const reg = REG();
  const before = JSON.stringify(reg);
  const plan = planRegistryJoin(reg, { handle: "pos609-newcomer", household: SENTINEL, ghId: 5555, ghLogin: "stranger-gh", date: "2026-10-13" });
  assert.ok(plan?.registry, "the join still plans (a house of its own words), it is not dropped");
  assert.notEqual(plan.slug, "copper-gate", "the private name routed no claim onto copper-gate");
  assert.notEqual(plan.action, "appended", "nothing was appended to an existing house");
  const cg = plan.registry.households["copper-gate"];
  assert.deepEqual(cg.residents, ["tansy"], "copper-gate gained no resident");
  assert.deepEqual(cg.accounts, [{ login: "cg-gh", id: 9701 }], "copper-gate gained no account");
  assert.equal(cg.human, SENTINEL, "the private human is preserved in storage");
  assert.equal(JSON.stringify(reg), before, "the registry handed in is unchanged");

  // CONTROL: the public name still claims (a cold, unvouched join, as before)
  const claim = planRegistryJoin(reg, { handle: "pos609-newcomer", household: "Copper Gate", ghId: 5555, ghLogin: "stranger-gh", date: "2026-10-13" });
  assert.equal(claim.slug, "copper-gate");
  assert.equal(claim.action, "appended");
  assert.equal(claim.vouched, false);
});

test("declaration: a house's private human is not TAKEN; its key and public name are", () => {
  const reg = REG();
  const before = JSON.stringify(reg);
  for (const spelled of [SENTINEL, "private-sentinel-qzrv"]) {
    const e = declare(spelled, reg);
    assert.notEqual(e?.refusal, REFUSALS.TAKEN, `"${spelled}" is not refused as taken`);
    assert.ok(!String(e?.message ?? "").includes("copper-gate") && !String(e?.detail ?? "").includes("copper-gate"), "no refusal points at the house");
  }
  for (const spelled of ["Copper Gate", "copper-gate", COLLIDER]) {
    const e = declare(spelled, reg);
    assert.equal(e?.refusal, REFUSALS.TAKEN, `CONTROL: "${spelled}" is taken`);
  }
  assert.equal(JSON.stringify(reg), before, "the registry handed in is unchanged");
});
