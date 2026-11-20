import { test } from "node:test";
import assert from "node:assert/strict";
import { depotJouet, commandeProuvee } from "./aide.mjs";

test("valider : la configuration d'exemple passe", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const r = d.lancer("lib/config.mjs", ["valider"]);
  assert.equal(r.code, 0, r.erreur);
});

test("valider : sans configuration, le message renvoie vers l'installateur", (t) => {
  const d = depotJouet({ config: null });
  t.after(d.detruire);
  const r = d.lancer("lib/config.mjs", ["valider"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /harness-install/);
});

test("valider : une clé inconnue ou une valeur hors liste est refusée", (t) => {
  const d = depotJouet({ config: (c) => { c.git.forge = "autre-forge"; c.surprise = 1; } });
  t.after(d.detruire);
  const r = d.lancer("lib/config.mjs", ["valider"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /\/git\/forge/);
  assert.match(r.erreur, /\/surprise/);
});

test("la gate de merge ne peut pas être rendue automatique", (t) => {
  const d = depotJouet({ config: (c) => { c.gates.merge = "auto"; } });
  t.after(d.detruire);
  assert.equal(d.lancer("lib/config.mjs", ["valider"]).code, 1);
});

test("lire : une valeur, une liste en lignes, rien pour null", (t) => {
  const d = depotJouet({ config: (c) => { c.chemins.contexte = ["README.md", "docs/VISION.md"]; } });
  t.after(d.detruire);
  assert.equal(d.lancer("lib/config.mjs", ["lire", "git.branche_integration"]).sortie.trim(), "main");
  assert.equal(d.lancer("lib/config.mjs", ["lire", "chemins.contexte", "--lignes"]).sortie, "README.md\ndocs/VISION.md\n");
  assert.equal(d.lancer("lib/config.mjs", ["lire", "git.branche_production"]).sortie, "");
  assert.equal(d.lancer("lib/config.mjs", ["lire", "cle.absente"]).sortie, "");
});

test("options : seules les options actives sortent", (t) => {
  const d = depotJouet({ config: (c) => { c.options.valeur.actif = true; c.options.note_story.actif = true; } });
  t.after(d.detruire);
  assert.equal(d.lancer("lib/config.mjs", ["options"]).sortie, "valeur\nnote_story\n");
});

test("prouver : enregistre la date, le code et la durée", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const r = d.lancer("lib/config.mjs", ["prouver", "tests", "--exit", "0", "--duree", "2.5"]);
  assert.equal(r.code, 0, r.erreur);
  assert.deepEqual(d.config().commandes.tests, { cmd: "true", prouvee_le: "2030-01-15", exit: 0, duree_s: 2.5, base_rouge: false });
});

test("prouver : une base rouge se déclare, et un vert la lève", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  d.lancer("lib/config.mjs", ["prouver", "tests", "--exit", "1", "--duree", "1", "--base-rouge"]);
  assert.equal(d.config().commandes.tests.base_rouge, true);
  d.lancer("lib/config.mjs", ["prouver", "tests", "--exit", "0", "--duree", "1"]);
  assert.equal(d.config().commandes.tests.base_rouge, false);
});

test("prouver : une commande absente (null) ou inconnue est refusée", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  assert.equal(d.lancer("lib/config.mjs", ["prouver", "build", "--exit", "0", "--duree", "1"]).code, 1);
  assert.equal(d.lancer("lib/config.mjs", ["prouver", "inconnue", "--exit", "0", "--duree", "1"]).code, 1);
});

test("prouver : une commande statique se désigne par son nom", (t) => {
  const d = depotJouet({ config: (c) => { c.commandes.statique = [{ nom: "lint", ...commandeProuvee("true", { prouvee_le: null, exit: null, duree_s: null }) }]; } });
  t.after(d.detruire);
  const r = d.lancer("lib/config.mjs", ["prouver", "statique:lint", "--exit", "0", "--duree", "3"]);
  assert.equal(r.code, 0, r.erreur);
  assert.equal(d.config().commandes.statique[0].prouvee_le, "2030-01-15");
});
