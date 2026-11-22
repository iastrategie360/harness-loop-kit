import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { depotJouet, commandeProuvee, ICI } from "./aide.mjs";

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

// Option jev (1.2.0) : sa clé n'est pas requise, et ses seuils se contrôlent ensemble.
test("valider : la configuration d'exemple de 1.1.0, sans clé options.jev, reste valide", (t) => {
  const ancienne = JSON.parse(readFileSync(join(ICI, "fixtures", "config", "projet-1.1.0.json"), "utf8"));
  assert.equal(ancienne.kit.version, "1.1.0", "la fixture est bien celle de 1.1.0");
  assert.equal(Object.hasOwn(ancienne.options, "jev"), false);
  const d = depotJouet({ config: (c) => { for (const k of Object.keys(c)) delete c[k]; Object.assign(c, ancienne); } });
  t.after(d.detruire);
  const r = d.lancer("lib/config.mjs", ["valider"]);
  assert.equal(r.code, 0, r.erreur);
  assert.equal(d.lancer("lib/config.mjs", ["options"]).sortie, "");
});

test("valider : des seuils jev égaux, inversés ou hors bornes, et un alias de modèle, sont refusés", (t) => {
  const cas = [
    [(j) => { j.seuil_bas = 0.8; j.seuil_haut = 0.8; }, /\/options\/jev\/seuil_bas : doit être strictement inférieur à seuil_haut/],
    [(j) => { j.seuil_bas = 0.9; j.seuil_haut = 0.6; }, /\/options\/jev\/seuil_bas : doit être strictement inférieur/],
    [(j) => { j.seuil_bas = 0; }, /\/options\/jev\/seuil_bas/],
    [(j) => { j.seuil_haut = 1.2; }, /\/options\/jev\/seuil_haut/],
    [(j) => { j.modele = "jev-latest"; }, /\/options\/jev\/modele/],
    [(j) => { j.delai_ms = 0; }, /\/options\/jev\/delai_ms/],
    [(j) => { j.inconnue = 1; }, /\/options\/jev\/inconnue/],
  ];
  for (const [modifier, attendu] of cas) {
    const d = depotJouet({ config: (c) => modifier(c.options.jev) });
    t.after(d.detruire);
    const r = d.lancer("lib/config.mjs", ["valider"]);
    assert.equal(r.code, 1, `accepté à tort : ${JSON.stringify(d.config().options.jev)}`);
    assert.match(r.erreur, attendu);
  }
  const ok = depotJouet({ config: (c) => { c.options.jev.seuil_bas = 0.6; c.options.jev.seuil_haut = 0.61; } });
  t.after(ok.detruire);
  assert.equal(ok.lancer("lib/config.mjs", ["valider"]).code, 0);
});

test("la fixture 1.1.0 est la configuration d'exemple de 1.1.0, recopiée sans retouche", () => {
  const texte = readFileSync(join(ICI, "fixtures", "config", "projet-1.1.0.json"), "utf8");
  assert.match(texte, /"version": "1\.1\.0"/);
  assert.doesNotMatch(texte, /"jev"/);
});
