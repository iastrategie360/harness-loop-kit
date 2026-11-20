import { test } from "node:test";
import assert from "node:assert/strict";
import { depotJouet, commandeProuvee } from "./aide.mjs";

const nonProuvee = (cmd) => commandeProuvee(cmd, { prouvee_le: null, exit: null, duree_s: null });

test("gate : le code rendu est celui de la commande, pas celui d'un filtre", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.tests = commandeProuvee("echo 'trois tests rouges'; exit 7"); } });
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["tests"]);
  assert.equal(r.code, 7);
  assert.match(r.sortie, /trois tests rouges/);
  assert.match(r.sortie, /gate tests : ROUGE \(exit 7/);
  assert.match(d.lire("harness", ".travail", "gates", "tests.log"), /trois tests rouges/);
});

test("gate : une commande déclarée avec un pipe garde le rouge de sa première moitié", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.tests = nonProuvee("(echo 'un test rouge'; exit 3) | cat"); } });
  t.after(d.detruire);
  // À l'essai comme à la gate : un rouge masqué par le filtre serait enregistré comme preuve.
  const essai = d.lancer("gate.sh", ["--essai", "tests"]);
  assert.equal(essai.code, 3, essai.sortie + essai.erreur);
  assert.equal(d.config().commandes.tests.prouvee_le, null);
  d.reconfigurer((c) => { c.commandes.tests = commandeProuvee("(echo 'un test rouge'; exit 3) | cat"); });
  const r = d.lancer("gate.sh", ["tests"]);
  assert.equal(r.code, 3);
  assert.match(r.sortie, /gate tests : ROUGE \(exit 3/);
});

test("gate : une commande verte rend 0 et laisse son journal", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.tests = commandeProuvee("echo tout passe"); } });
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["tests"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /gate tests : VERT/);
});

test("gate : une commande jamais prouvée est refusée, et n'est pas lancée", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.tests = nonProuvee("touch lancee.txt"); } });
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["tests"]);
  assert.equal(r.code, 97);
  assert.match(r.erreur, /jamais été prouvée/);
  assert.equal(d.existe("lancee.txt"), false);
});

test("gate : une commande déclarée absente rend 0 en le disant", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["build"]);
  assert.equal(r.code, 0);
  assert.match(r.sortie, /ABSENTE/);
});

test("gate : un nom inconnu est refusé, il ne passe pas pour une commande absente", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  assert.equal(d.lancer("gate.sh", ["test"]).code, 97);
  assert.equal(d.lancer("gate.sh", ["statique:inconnue"]).code, 97);
  assert.equal(d.lancer("gate.sh", []).code, 2);
});

test("gate --essai : un vert enregistre la preuve", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.tests = nonProuvee("true"); } });
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["--essai", "tests"]);
  assert.equal(r.code, 0, r.erreur);
  const c = d.config().commandes.tests;
  assert.equal(c.prouvee_le, "2030-01-15");
  assert.equal(c.exit, 0);
  assert.equal(c.base_rouge, false);
  assert.equal(d.lancer("gate.sh", ["tests"]).code, 0);
});

test("gate --essai : un rouge n'enregistre rien, sauf base rouge déclarée", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.tests = nonProuvee("exit 3"); } });
  t.after(d.detruire);
  let r = d.lancer("gate.sh", ["--essai", "tests"]);
  assert.equal(r.code, 3);
  assert.equal(d.config().commandes.tests.prouvee_le, null);
  r = d.lancer("gate.sh", ["--essai", "tests", "--base-rouge"]);
  assert.equal(r.code, 3);
  const c = d.config().commandes.tests;
  assert.equal(c.base_rouge, true);
  assert.equal(c.exit, 3);
  r = d.lancer("gate.sh", ["tests"]);
  assert.equal(r.code, 3);
  assert.match(r.sortie, /base rouge déclarée le 2030-01-15/);
});

test("gate statique : toutes les vérifications tournent, même après un rouge", (t) => {
  const d = depotJouet({
    config: (c) => {
      c.commandes.statique = [
        { nom: "lint", ...commandeProuvee("echo lint; exit 4") },
        { nom: "types", ...commandeProuvee("echo types > types-lance.txt") },
      ];
    },
  });
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["statique"]);
  assert.equal(r.code, 4);
  assert.equal(d.existe("types-lance.txt"), true);
  assert.match(r.sortie, /statique:lint : exit 4/);
  assert.match(r.sortie, /statique:types : exit 0/);
  assert.equal(d.lancer("gate.sh", ["statique:types"]).code, 0);
});

test("gate : un délai dépassé rend 124", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.tests = commandeProuvee("sleep 20"); } });
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["tests"], { env: { GATE_DELAI_S: "1" } });
  assert.equal(r.code, 124);
  assert.match(r.sortie, /DÉLAI DÉPASSÉ/);
});

test("gate : une configuration invalide arrête tout avant de lancer quoi que ce soit", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.tests = commandeProuvee("touch lancee.txt"); c.inconnue = true; } });
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["tests"]);
  assert.equal(r.code, 1);
  assert.equal(d.existe("lancee.txt"), false);
});

test("gate --liste : dit ce qui est prouvé, absent ou jamais lancé", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.build = commandeProuvee("make"); } });
  t.after(d.detruire);
  const r = d.lancer("gate.sh", ["--liste"]);
  assert.equal(r.code, 0);
  assert.match(r.sortie, /tests\tNON PROUVÉE\ttrue/);
  assert.match(r.sortie, /build\tprouvée le /);
  assert.match(r.sortie, /installer\tabsente/);
});
