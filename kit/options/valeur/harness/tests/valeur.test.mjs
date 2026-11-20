import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { depotJouet, SCHEMAS, lireJson } from "./aide.mjs";
import { auditer } from "../scripts/lib/schema-mini.mjs";

const fait = (cle, plus = {}) => ({
  cle,
  verdict: "ON_LE_FAIT",
  exposition: "Tout utilisateur qui ouvre la page des réglages (src/reglages.py).",
  cout_si_ca_arrive: "Une valeur vide enregistrée, visible à la relecture.",
  reversibilite: "Une ligne à corriger, aucune donnée perdue.",
  cout_de_differer: "Le même coût plus tard.",
  declencheur_reveil: "",
  ligne_backlog: "",
  ...plus,
});
const note = (cle) => fait(cle, {
  verdict: "ON_LE_NOTE",
  declencheur_reveil: "Le module d'export a un second appelant.",
  ligne_backlog: "- `export-sans-garde` : l'export accepte une liste vide. Déclencheur : le module d'export a un second appelant. Origine : 001-jouet.",
});
const reponse = (...items) => ({ resume: "Deux items soumis, un seul porte la valeur.", items });
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

function valider(d, fichier, cles, sortie) {
  return d.lancer("valeur-valider.sh", sortie ? [fichier, sortie] : [fichier], {
    env: cles === undefined ? {} : { CLES_ATTENDUES: cles.join("\n") },
  });
}

test("le schéma du verdict ne porte que des mots-clés connus du validateur", () => {
  auditer(lireJson(join(SCHEMAS, "valeur.json")));
});

test("réponse conforme : le résumé compte chaque verdict, le fichier est normalisé", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  d.ecrire("v.json", JSON.stringify(reponse(fait("a"), note("b"), fait("c", { verdict: "ON_LE_JETTE" }), fait("d", { verdict: "HORS_ARBITRAGE" }))));
  const r = valider(d, "v.json", ["a", "b", "c", "d"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /VALEUR: 4 items · fait 1 · note 1 · jete 1 · hors arbitrage 1/);
  assert.match(r.sortie, /JSON valide : v\.json/);
  assert.match(d.lire("v.json"), /^\{\n {2}"resume"/, "réécrit indenté");
});

test("réponse en prose : le DERNIER bloc json est extrait et posé à côté", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const brouillon = reponse(fait("a"), fait("b"));
  const final = reponse(fait("a"), note("b"));
  d.ecrire("v.md", `Voici mon analyse.\n\n\`\`\`json\n${json(brouillon)}\`\`\`\n\nJe me reprends.\n\n\`\`\`json\n${json(final)}\`\`\`\n`);
  const r = valider(d, "v.md", ["a", "b"]);
  assert.equal(r.code, 0, r.erreur);
  assert.equal(d.lireJson("v.md.json").items[1].verdict, "ON_LE_NOTE");
  assert.equal(valider(d, "v.md", ["a", "b"], "ailleurs.json").code, 0);
  assert.ok(d.existe("ailleurs.json"));
});

test("égalité d'ensemble : clé manquante, clé jamais soumise, clé en double", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  d.ecrire("v.md", `\`\`\`json\n${json(reponse(fait("a"), fait("b")))}\`\`\`\n`);

  let r = valider(d, "v.md", ["a", "b", "c"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /items soumis sans verdict :\n {2}c\n/);
  r = valider(d, "v.md", ["a"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /jamais soumis :\n {2}b\n/);
  // Le bon NOMBRE de verdicts sur les mauvais items : compter ne suffit pas.
  r = valider(d, "v.md", ["a", "z"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /sans verdict :\n {2}z\n/);
  assert.match(r.erreur, /jamais soumis :\n {2}b\n/);
  assert.equal(d.existe("v.md.json"), false, "un refus ne pose aucun fichier normalisé");

  d.ecrire("double.json", JSON.stringify(reponse(fait("a"), note("a"))));
  r = valider(d, "double.json", ["a"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /deux verdicts/);
});

test("forme : un report sans déclencheur, un correctif avec ligne de backlog, un tiret long", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const cas = {
    "report sans déclencheur": reponse(fait("a", { verdict: "ON_LE_NOTE", ligne_backlog: note("a").ligne_backlog })),
    "report sans ligne de backlog": reponse(fait("a", { verdict: "ON_LE_NOTE", declencheur_reveil: "Le premier compte payant existe." })),
    "correctif qui porte une ligne de backlog": reponse(fait("a", { ligne_backlog: note("a").ligne_backlog })),
    "rejet qui porte un déclencheur": reponse(fait("a", { verdict: "ON_LE_JETTE", declencheur_reveil: "Un jour peut-être." })),
    "tiret long": reponse(fait("a", { exposition: "Tout le monde \u2014 ou presque." })),
    "verdict inventé": reponse(fait("a", { verdict: "PLUS_TARD" })),
    "champ en trop": reponse(fait("a", { avis: "à mon sens" })),
    "lot vide": { resume: "Rien à arbitrer dans ce lot.", items: [] },
  };
  for (const [nom, contenu] of Object.entries(cas)) {
    const original = JSON.stringify(contenu);
    d.ecrire("v.json", original);
    const r = valider(d, "v.json", ["a"]);
    assert.equal(r.code, 1, nom);
    assert.match(r.erreur, /hors schéma/, nom);
    assert.equal(d.lire("v.json"), original, `${nom} : l'entrée refusée n'est pas réécrite`);
  }
});

test("réponse vide ou illisible : refus ; sans clés attendues : la forme seule, en le disant", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  d.ecrire("vide.md", "");
  assert.equal(valider(d, "vide.md", ["a"]).code, 1);
  d.ecrire("prose.md", "Je pense que tout peut attendre.\n");
  const r = valider(d, "prose.md", ["a"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /pas du JSON lisible/);
  assert.equal(valider(d, "absent.json", ["a"]).code, 1);
  assert.equal(d.lancer("valeur-valider.sh", []).code, 2);

  d.ecrire("v.json", JSON.stringify(reponse(fait("a"))));
  const s = valider(d, "v.json");
  assert.equal(s.code, 0, s.erreur);
  assert.match(s.erreur, /seule la forme est contrôlée/);
});

// Les gestes que harness/options/valeur.md demande au superviseur, joués sur un vrai état.
test("stage CODE : un finding différé n'est plus à corriger, puis se réveille en item neuf", (t) => {
  const d = depotJouet({ config: (c) => { c.options.valeur.actif = true; } });
  t.after(d.detruire);
  const etat = (...args) => {
    const r = d.lancer("etat.mjs", args);
    assert.equal(r.code, 0, `${args.join(" ")} : ${r.erreur}`);
    return r;
  };
  const ledger = () => d.lireJson("harness", "state", "001-jouet.json").review_ledger.code.findings;
  etat("init", "001-jouet", "--titre", "Jouet", "--regard-client", "non", "--perimetre", "src/**");
  etat("stage", "001-jouet", "SPEC");
  etat("stage", "001-jouet", "CHALLENGE");
  etat("gate", "001-jouet", "spec", "auto", "--motif", "challenge solide");
  etat("stage", "001-jouet", "PLAN");
  etat("stage", "001-jouet", "CODE");

  const F = { cle: "src/export.py#liste-vide", titre: "L'export accepte une liste vide", severite: "P2", fichier: "src/export.py" };
  const round = () => {
    const f = d.ecrire("findings.json", JSON.stringify([F]));
    return JSON.parse(etat("ledger-round", "001-jouet", "--findings", f).sortie);
  };
  assert.deepEqual(round().a_corriger, [F.cle]);

  assert.equal(d.lancer("etat.mjs", ["finding", "001-jouet", F.cle, "differe_valeur"]).code, 1, "un report sans note est refusé");
  etat("finding", "001-jouet", F.cle, "differe_valeur", "--note", "Différé par arbitrage de valeur du 2030-01-15. Ligne de backlog : `export-sans-garde`. Déclencheur de réveil : le module d'export a un second appelant.");
  etat("ecrire", "001-jouet", "--patch", JSON.stringify({
    review_ledger: { code: { findings: { [F.cle]: { valeur: { verdict: "ON_LE_NOTE", date: "2030-01-15T10:00:00Z", declencheur: "Le module d'export a un second appelant." } } } } },
  }));
  assert.equal(ledger()[F.cle].valeur.verdict, "ON_LE_NOTE");

  // Re-signalé au round suivant : déjà tranché, rien à corriger, le round est propre.
  const b = round();
  assert.deepEqual(b.deja_tranches, [F.cle]);
  assert.deepEqual(b.a_corriger, []);
  assert.equal(b.propre, true);

  // Le déclencheur a tiré : le finding redevient un item neuf, sans verdict de valeur.
  etat("finding", "001-jouet", F.cle, "ouvert", "--note", "déclencheur de réveil tiré : un second appelant existe");
  assert.equal(ledger()[F.cle].statut, "ouvert");
  assert.equal("valeur" in ledger()[F.cle], false);
  assert.deepEqual(round().a_corriger, [F.cle]);
  assert.equal(d.lancer("etat.mjs", ["valider", "001-jouet"]).code, 0);
});
