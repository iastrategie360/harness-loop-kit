import { test } from "node:test";
import assert from "node:assert/strict";
import { depotJouet, FAUX } from "./aide.mjs";

const AVEC_FAUX = { PATH: `${FAUX}:${process.env.PATH}` };
const sansForge = (c) => { c.git.forge = "aucune"; };

test("preflight : tout est là, et les réserves sont dites", (t) => {
  const d = depotJouet({ config: sansForge, env: AVEC_FAUX });
  t.after(d.detruire);
  const r = d.lancer("preflight.sh", []);
  assert.equal(r.code, 0, r.sortie + r.erreur);
  assert.match(r.sortie, /OK {6}harness\/projet\.json valide/);
  assert.match(r.sortie, /OK {6}codex authentifié/);
  assert.match(r.sortie, /NOTE {4}relecteur\.accord_envoi_externe est à false/);
  assert.match(r.sortie, /NOTE {4}commandes jamais prouvées : tests/);
  assert.match(r.sortie, /NOTE {4}le dépôt distant « origin » n'existe pas/);
  d.git("remote", "add", "origin", "https://example.invalid/jouet.git");
  assert.doesNotMatch(d.lancer("preflight.sh", []).sortie, /le dépôt distant/);
  assert.match(r.sortie, /preflight : tout est là\./);
});

test("preflight : un relecteur non authentifié est un manque", (t) => {
  const d = depotJouet({ config: sansForge, env: AVEC_FAUX });
  t.after(d.detruire);
  let r = d.lancer("preflight.sh", [], { env: { FAUX_CODEX_MODE: "non-authentifie" } });
  assert.equal(r.code, 1);
  assert.match(r.sortie, /MANQUE {2}codex n'est pas authentifié/);
  r = d.lancer("preflight.sh", ["--sans-relecteur"], { env: { FAUX_CODEX_MODE: "non-authentifie" } });
  assert.equal(r.code, 0, r.sortie);
});

test("preflight : sans configuration, seul le mode installation passe", (t) => {
  const d = depotJouet({ config: null, env: AVEC_FAUX });
  t.after(d.detruire);
  let r = d.lancer("preflight.sh", []);
  assert.equal(r.code, 1);
  assert.match(r.sortie, /MANQUE {2}harness\/projet\.json \(lancer \/harness-install\)/);
  r = d.lancer("preflight.sh", ["--installation"]);
  assert.equal(r.code, 0, r.sortie + r.erreur);
});

test("preflight : une configuration invalide est un manque, une option inconnue rend 2", (t) => {
  const d = depotJouet({ config: (c) => { sansForge(c); c.inconnue = true; }, env: AVEC_FAUX });
  t.after(d.detruire);
  const r = d.lancer("preflight.sh", []);
  assert.equal(r.code, 1);
  assert.match(r.sortie, /MANQUE {2}harness\/projet\.json invalide/);
  assert.equal(d.lancer("preflight.sh", ["--nimporte"]).code, 2);
});
