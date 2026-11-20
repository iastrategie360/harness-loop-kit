import { test } from "node:test";
import assert from "node:assert/strict";
import { depotJouet } from "./aide.mjs";

const INIT = ["init", "001-jouet", "--titre", "Une story jouet", "--regard-client", "non", "--perimetre", "src/**"];

function story(options = {}) {
  const d = depotJouet(options);
  const r = d.lancer("etat.mjs", INIT);
  assert.equal(r.code, 0, r.erreur);
  return d;
}

function etat(d, id = "001-jouet") {
  return d.lireJson("harness", "state", `${id}.json`);
}

function ok(d, args) {
  const r = d.lancer("etat.mjs", args);
  assert.equal(r.code, 0, `${args.join(" ")} : ${r.erreur}`);
  return r;
}

// Amène la story jusqu'au stage CODE par le chemin léger.
function jusquAuCode(d) {
  ok(d, ["stage", "001-jouet", "SPEC"]);
  ok(d, ["stage", "001-jouet", "CHALLENGE"]);
  ok(d, ["gate", "001-jouet", "spec", "auto", "--motif", "challenge solide"]);
  ok(d, ["stage", "001-jouet", "PLAN"]);
  ok(d, ["stage", "001-jouet", "CODE"]);
}

test("init : état complet, valide, rigueur légère par défaut", (t) => {
  const d = story();
  t.after(d.detruire);
  const e = etat(d);
  assert.equal(e.stage, "INIT");
  assert.equal(e.rigueur, "legere");
  assert.equal(e.regard_client, false);
  assert.equal(e.max_tours, 100);
  assert.equal(e.branche, "feat/001-jouet");
  assert.deepEqual(e.review_ledger, { code: { rounds: 0, findings: {} } });
  assert.deepEqual(Object.keys(e.gates), ["spec", "plan", "scope", "arbitrage", "merge"]);
  assert.equal(Object.keys(e).length, 24);
  ok(d, ["valider", "001-jouet"]);
});

test("init : le regard client et le périmètre ne se devinent pas", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  assert.equal(d.lancer("etat.mjs", ["init", "002-x", "--titre", "T", "--perimetre", "src/**"]).code, 2);
  assert.equal(d.lancer("etat.mjs", ["init", "002-x", "--titre", "T", "--regard-client", "oui"]).code, 2);
  assert.equal(d.lancer("etat.mjs", ["init", "Mauvais Id", "--titre", "T", "--regard-client", "oui", "--perimetre", "a"]).code, 2);
  assert.equal(d.existe("harness", "state", "002-x.json"), false);
});

test("init : une story existante n'est jamais écrasée", (t) => {
  const d = story();
  t.after(d.detruire);
  assert.equal(d.lancer("etat.mjs", INIT).code, 1);
});

test("stage : on ne saute ni la spec, ni le challenge, ni la gate de spec", (t) => {
  const d = story();
  t.after(d.detruire);
  assert.equal(d.lancer("etat.mjs", ["stage", "001-jouet", "PLAN"]).code, 1);
  ok(d, ["stage", "001-jouet", "SPEC"]);
  ok(d, ["stage", "001-jouet", "CHALLENGE"]);
  const r = d.lancer("etat.mjs", ["stage", "001-jouet", "PLAN"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /gate de spec/);
});

test("stage : en rigueur légère la contre-review du plan se saute, en rigueur complète non", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  assert.equal(etat(d).stage, "CODE");

  const c = depotJouet();
  t.after(c.detruire);
  ok(c, INIT);
  ok(c, ["rigueur", "001-jouet", "complete", "--motif", "migration de données"]);
  ok(c, ["stage", "001-jouet", "SPEC"]);
  ok(c, ["stage", "001-jouet", "CHALLENGE"]);
  ok(c, ["gate", "001-jouet", "spec", "auto", "--motif", "challenge solide"]);
  ok(c, ["stage", "001-jouet", "PLAN"]);
  assert.equal(c.lancer("etat.mjs", ["stage", "001-jouet", "CODE"]).code, 1);
  ok(c, ["stage", "001-jouet", "PLAN_REVIEW"]);
  ok(c, ["stage", "001-jouet", "CODE"]);
});

test("rigueur : pas de régime complet sans déclencheur nommé, et on ne redescend pas", (t) => {
  const d = story();
  t.after(d.detruire);
  assert.equal(d.lancer("etat.mjs", ["rigueur", "001-jouet", "complete"]).code, 2);
  ok(d, ["rigueur", "001-jouet", "complete", "--motif", "accès et identité"]);
  assert.equal(d.lancer("etat.mjs", ["rigueur", "001-jouet", "legere"]).code, 2);
  assert.equal(d.lancer("etat.mjs", ["ecrire", "001-jouet", "--patch", '{"rigueur":"legere"}']).code, 1);
  assert.equal(etat(d).rigueur, "complete");
});

test("stage : revenir en arrière exige un motif", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  assert.equal(d.lancer("etat.mjs", ["stage", "001-jouet", "PLAN"]).code, 1);
  ok(d, ["stage", "001-jouet", "PLAN", "--motif", "le plan oubliait un fichier"]);
  assert.equal(etat(d).stage, "PLAN");
});

test("stage : le regard client ne se saute que s'il est déclaré inutile", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  ok(d, ["init", "001-jouet", "--titre", "T", "--regard-client", "oui", "--perimetre", "src/**"]);
  jusquAuCode(d);
  ok(d, ["stage", "001-jouet", "QA"]);
  ok(d, ["stage", "001-jouet", "PR"]);
  const r = d.lancer("etat.mjs", ["attendre", "001-jouet", "merge", "--motif", "PR prête"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /REGARD/);
  ok(d, ["stage", "001-jouet", "REGARD"]);
  ok(d, ["attendre", "001-jouet", "merge", "--motif", "PR prête"]);
  assert.equal(etat(d).stage, "waiting_gate_merge");
});

test("stage : la note de story est exigée quand l'option est active", (t) => {
  const d = story({ config: (c) => { c.options.note_story.actif = true; } });
  t.after(d.detruire);
  jusquAuCode(d);
  ok(d, ["stage", "001-jouet", "QA"]);
  ok(d, ["stage", "001-jouet", "PR"]);
  assert.equal(d.lancer("etat.mjs", ["attendre", "001-jouet", "merge", "--motif", "PR prête"]).code, 1);
  ok(d, ["stage", "001-jouet", "NOTE"]);
  ok(d, ["attendre", "001-jouet", "merge", "--motif", "PR prête"]);
});

test("gate de spec humaine : le passage automatique est refusé, seul approuver la franchit", (t) => {
  const d = story({ config: (c) => { c.gates.spec = "humaine"; } });
  t.after(d.detruire);
  ok(d, ["stage", "001-jouet", "SPEC"]);
  ok(d, ["stage", "001-jouet", "CHALLENGE"]);
  assert.equal(d.lancer("etat.mjs", ["gate", "001-jouet", "spec", "auto", "--motif", "x"]).code, 1);
  assert.equal(d.lancer("etat.mjs", ["stage", "001-jouet", "PLAN"]).code, 1);
  ok(d, ["attendre", "001-jouet", "spec", "--motif", "spec à relire"]);
  const attente = etat(d);
  assert.equal(attente.stage, "waiting_gate_spec");
  assert.equal(attente.previous_stage, "CHALLENGE");
  assert.equal(d.lancer("etat.mjs", ["approuver", "001-jouet"]).code, 2);
  ok(d, ["approuver", "001-jouet", "--par", "Camille"]);
  const e = etat(d);
  assert.equal(e.stage, "PLAN");
  assert.equal(e.previous_stage, null);
  assert.equal(e.gates.spec.etat, "approuvee");
  assert.equal(e.gates.spec.par, "Camille");
});

test("renvoyer : une gate de spec renvoyée reste humaine", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, ["stage", "001-jouet", "SPEC"]);
  ok(d, ["stage", "001-jouet", "CHALLENGE"]);
  ok(d, ["attendre", "001-jouet", "spec", "--motif", "deux questions ouvertes"]);
  ok(d, ["renvoyer", "001-jouet", "SPEC", "--par", "Camille", "--motif", "le périmètre est trop large"]);
  assert.equal(etat(d).stage, "SPEC");
  ok(d, ["stage", "001-jouet", "CHALLENGE"]);
  assert.equal(d.lancer("etat.mjs", ["gate", "001-jouet", "spec", "auto", "--motif", "x"]).code, 1);
});

test("gate de merge : approuver exige la preuve que la PR est mergée", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  assert.equal(d.lancer("etat.mjs", ["attendre", "001-jouet", "merge", "--motif", "trop tôt"]).code, 1);
  ok(d, ["stage", "001-jouet", "QA"]);
  ok(d, ["stage", "001-jouet", "PR"]);
  ok(d, ["attendre", "001-jouet", "merge", "--motif", "PR prête"]);
  assert.equal(d.lancer("etat.mjs", ["approuver", "001-jouet", "--par", "Camille"]).code, 1);
  assert.equal(etat(d).stage, "waiting_gate_merge");
  ok(d, ["approuver", "001-jouet", "--par", "Camille", "--pr-mergee"]);
  assert.equal(etat(d).stage, "DONE");
});

test("gates de scope et d'arbitrage : l'approbation rend la main au stage d'origine", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  ok(d, ["attendre", "001-jouet", "scope", "--motif", "le correctif touche un périmètre interdit"]);
  ok(d, ["approuver", "001-jouet", "--par", "Camille"]);
  assert.equal(etat(d).stage, "CODE");
  ok(d, ["attendre", "001-jouet", "arbitrage", "--motif", "désaccord tenace"]);
  ok(d, ["approuver", "001-jouet", "--par", "Camille"]);
  assert.equal(etat(d).stage, "CODE");
});

test("tour : compte, s'arrête sur une attente, s'arrête au plafond", (t) => {
  const d = story({ config: (c) => { c.boucle.max_tours = 2; } });
  t.after(d.detruire);
  assert.equal(d.lancer("etat.mjs", ["tour", "001-jouet"]).code, 0);
  assert.equal(d.lancer("etat.mjs", ["tour", "001-jouet"]).code, 0);
  assert.equal(etat(d).tours, 2);
  assert.equal(d.lancer("etat.mjs", ["tour", "001-jouet"]).code, 11);
  const e = etat(d);
  assert.equal(e.stage, "stopped_max_tours");
  assert.equal(e.previous_stage, "INIT");
  assert.equal(e.tours, 2);
  assert.equal(d.lancer("etat.mjs", ["tour", "001-jouet"]).code, 10);
  ok(d, ["reprendre", "001-jouet"]);
  const r = etat(d);
  assert.equal(r.stage, "INIT");
  assert.equal(r.tours, 0);
});

test("echec : trois échecs du MÊME pas arrêtent la story, un succès remet à zéro", (t) => {
  const d = story();
  t.after(d.detruire);
  assert.equal(d.lancer("etat.mjs", ["echec", "001-jouet", "challenge"]).code, 0);
  assert.equal(d.lancer("etat.mjs", ["echec", "001-jouet", "challenge"]).code, 0);
  assert.equal(d.lancer("etat.mjs", ["echec", "001-jouet", "autre-pas"]).code, 0);
  assert.equal(etat(d).echecs_consecutifs, 1);
  ok(d, ["succes", "001-jouet"]);
  assert.equal(etat(d).echecs_consecutifs, 0);
  d.lancer("etat.mjs", ["echec", "001-jouet", "challenge"]);
  d.lancer("etat.mjs", ["echec", "001-jouet", "challenge"]);
  assert.equal(d.lancer("etat.mjs", ["echec", "001-jouet", "challenge"]).code, 12);
  const e = etat(d);
  assert.equal(e.stage, "stopped_error");
  assert.equal(e.previous_stage, "INIT");
  assert.equal(e.blocages.length, 1);
});

test("ecrire : fusionne les objets, refuse les clés protégées et les clés inconnues", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, ["ecrire", "001-jouet", "--patch", '{"pr":{"numero":12},"extensions":{"valeur":{"appels":1}}}']);
  const e = etat(d);
  assert.deepEqual(e.pr, { numero: 12, url: null });
  assert.deepEqual(e.extensions, { valeur: { appels: 1 } });
  assert.equal(d.lancer("etat.mjs", ["ecrire", "001-jouet", "--patch", '{"stage":"DONE"}']).code, 1);
  assert.equal(d.lancer("etat.mjs", ["ecrire", "001-jouet", "--patch", '{"tours":0}']).code, 1);
  const r = d.lancer("etat.mjs", ["ecrire", "001-jouet", "--patch", '{"cle_inventee":true}']);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /cle_inventee/);
  assert.equal(Object.hasOwn(etat(d), "cle_inventee"), false, "un état refusé n'est pas écrit");
});

test("noter et ajouter : décisions datées, notes libres, périmètre précisé", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, ["noter", "001-jouet", "decisions", "on garde le format existant", "--par", "superviseur"]);
  ok(d, ["noter", "001-jouet", "notes", "à revoir après le plan"]);
  ok(d, ["ajouter", "001-jouet", "perimetre", '"tests/**"']);
  const e = etat(d);
  assert.equal(e.decisions[0].note, "on garde le format existant");
  assert.equal(e.decisions[0].date, "2030-01-15T10:00:00Z");
  assert.deepEqual(e.notes, ["à revoir après le plan"]);
  assert.deepEqual(e.perimetre, ["src/**", "tests/**"]);
});

function round(d, findings) {
  const f = d.ecrire("findings.json", JSON.stringify(findings));
  const r = ok(d, ["ledger-round", "001-jouet", "--findings", f]);
  return JSON.parse(r.sortie);
}

const F1 = { cle: "src/a.js#valeur-nulle", titre: "Valeur nulle non gérée", severite: "P1", fichier: "src/a.js" };
const F2 = { cle: "src/b.js#delai", titre: "Délai jamais annulé", severite: "P2", fichier: "src/b.js" };

test("ledger : un finding absent au round suivant est corrigé, un présent survit", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  let b = round(d, [F1, F2]);
  assert.deepEqual(b.a_corriger, [F1.cle, F2.cle]);
  assert.equal(b.propre, false);
  b = round(d, [F1]);
  assert.deepEqual(b.corriges, [F2.cle]);
  assert.deepEqual(b.a_corriger, [F1.cle]);
  const l = etat(d).review_ledger.code;
  assert.equal(l.rounds, 2);
  assert.equal(l.findings[F1.cle].survived, 1);
  assert.equal(l.findings[F2.cle].statut, "corrige");
  b = round(d, []);
  assert.equal(b.propre, true);
});

test("ledger : un finding qui survit deux fois part à l'arbitre, puis à l'humain", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  round(d, [F1]);
  round(d, [F1]);
  let b = round(d, [F1]);
  assert.deepEqual(b.a_escalader, [{ cle: F1.cle, vers: "arbitre" }]);
  assert.deepEqual(b.a_corriger, []);
  ok(d, ["escalade", "001-jouet", F1.cle, "arbitre", "--verdict", "finding_valide"]);
  b = round(d, [F1]);
  assert.deepEqual(b.a_escalader, [{ cle: F1.cle, vers: "humain" }]);
  const e = etat(d);
  assert.equal(e.escalations.length, 1);
  assert.equal(e.review_ledger.code.findings[F1.cle].escalation, "arbitre");
});

test("ledger : au quatrième round, tout ce qui reste part à l'arbitre", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  round(d, [F1]);
  round(d, []);
  round(d, []);
  const b = round(d, [F2]);
  assert.deepEqual(b.a_escalader, [{ cle: F2.cle, vers: "arbitre" }]);
});

test("ledger : un finding tranché ne se rouvre pas, et trancher exige une note", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  round(d, [F1]);
  assert.equal(d.lancer("etat.mjs", ["finding", "001-jouet", F1.cle, "faux_positif"]).code, 1);
  ok(d, ["finding", "001-jouet", F1.cle, "faux_positif", "--note", "arbitre : le cas est déjà couvert ligne 40"]);
  const b = round(d, [F1]);
  assert.deepEqual(b.deja_tranches, [F1.cle]);
  assert.equal(b.propre, true);
  assert.equal(etat(d).review_ledger.code.findings[F1.cle].statut, "faux_positif");
});

test("ledger : des findings mal formés ou en double sont refusés sans rien écrire", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  const f = d.ecrire("mauvais.json", JSON.stringify([{ cle: "x", titre: "T", severite: "P3", fichier: null }]));
  assert.equal(d.lancer("etat.mjs", ["ledger-round", "001-jouet", "--findings", f]).code, 1);
  const g = d.ecrire("double.json", JSON.stringify([F1, F1]));
  assert.equal(d.lancer("etat.mjs", ["ledger-round", "001-jouet", "--findings", g]).code, 1);
  assert.equal(etat(d).review_ledger.code.rounds, 0);
});

test("prerequis : fermé par défaut, tenu quand l'autre story a atteint le stage", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  ok(d, ["init", "001-socle", "--titre", "Socle", "--regard-client", "non", "--perimetre", "src/**"]);
  ok(d, ["init", "002-suite", "--titre", "Suite", "--regard-client", "non", "--perimetre", "lib/**",
    "--depend-de", "001-socle:stage=CODE", "--depend-de", "000-absente:gate=merge"]);
  let r = d.lancer("etat.mjs", ["prerequis", "002-suite"]);
  assert.equal(r.code, 1);
  assert.match(r.sortie, /001-socle : stage CODE attendu/);
  assert.match(r.sortie, /000-absente : état introuvable/);
  assert.equal(d.lancer("etat.mjs", ["prerequis", "001-socle"]).code, 0);
});

test("prerequis : un état de dépendance hors schéma ne tient aucun prérequis", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  ok(d, ["init", "001-socle", "--titre", "Socle", "--regard-client", "non", "--perimetre", "src/**"]);
  ok(d, ["init", "002-suite", "--titre", "Suite", "--regard-client", "non", "--perimetre", "lib/**",
    "--depend-de", "001-socle:stage=INIT"]);
  assert.equal(d.lancer("etat.mjs", ["prerequis", "002-suite"]).code, 0, "le témoin : l'état sain tient le prérequis");
  for (const abime of ['{"stage":"DONE"}', '{"stage":"DONE","gates":{"merge":{"etat":"franchie"}}}', "[]", "null"]) {
    d.ecrire("harness/state/001-socle.json", abime);
    const r = d.lancer("etat.mjs", ["prerequis", "002-suite"]);
    assert.equal(r.code, 1, abime);
    assert.match(r.sortie, /001-socle : état introuvable, illisible ou hors schéma/, abime);
  }
});

test("prerequis : une story en attente garde le stage qu'elle avait atteint", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  ok(d, ["init", "001-jouet", "--titre", "Socle", "--regard-client", "non", "--perimetre", "src/**"]);
  ok(d, ["init", "002-suite", "--titre", "Suite", "--regard-client", "non", "--perimetre", "lib/**", "--depend-de", "001-jouet:stage=CODE"]);
  jusquAuCode(d);
  ok(d, ["attendre", "001-jouet", "scope", "--motif", "question ouverte"]);
  assert.equal(d.lancer("etat.mjs", ["prerequis", "002-suite"]).code, 0);
});

test("valider --tous : un état édité à la main hors schéma est signalé", (t) => {
  const d = story();
  t.after(d.detruire);
  const e = etat(d);
  e.stage = "waiting_gate_spec"; // sans previous_stage : la story ne saurait pas reprendre
  d.ecrire("harness/state/001-jouet.json", JSON.stringify(e));
  const r = d.lancer("etat.mjs", ["valider", "--tous"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /previous_stage/);
  assert.equal(d.lancer("etat.mjs", ["historique", "001-jouet", "x"]).code, 1, "on ne construit pas sur un état faux");
});

test("une question marquée dans la spec ferme l'entrée en CODE, par `stage` comme par `approuver`", (t) => {
  const d = story();
  t.after(d.detruire);
  const SPEC = "specs/001-jouet/spec.md";
  ok(d, ["stage", "001-jouet", "SPEC"]);
  ok(d, ["stage", "001-jouet", "CHALLENGE"]);
  d.ecrire(SPEC, "# Spec\n\n- [NEEDS CLARIFICATION: faut-il refuser un plafond infini ?]\n");
  ok(d, ["attendre", "001-jouet", "spec", "--motif", "1. faut-il refuser un plafond infini ?"]);
  // L'accord ouvre le PLAN : c'est là que la spec se révise avec la réponse.
  ok(d, ["approuver", "001-jouet", "--par", "Camille"]);
  assert.equal(etat(d).stage, "PLAN");
  let r = d.lancer("etat.mjs", ["stage", "001-jouet", "CODE"]);
  assert.equal(r.code, 1, "stage : la marque ferme le CODE");
  assert.match(r.erreur, /1 marque\(s\) \[NEEDS CLARIFICATION/);
  assert.equal(etat(d).stage, "PLAN");
  ok(d, ["attendre", "001-jouet", "plan", "--motif", "un risque"]);
  r = d.lancer("etat.mjs", ["approuver", "001-jouet", "--par", "Camille"]);
  assert.equal(r.code, 1, "approuver : la gate de plan ne contourne pas la garde");
  assert.equal(etat(d).stage, "waiting_gate_plan");
  assert.equal(etat(d).gates.plan.etat, "en_attente");
  // La question tranchée, sa marque disparaît. Citer la marque sans question ne compte pas.
  d.ecrire(SPEC, "# Spec\n\nUn plafond infini est refusé. Plus aucune `[NEEDS CLARIFICATION]`.\n");
  ok(d, ["approuver", "001-jouet", "--par", "Camille"]);
  assert.equal(etat(d).stage, "CODE");
});

test("liste et fil : l'essentiel d'un coup d'oeil", (t) => {
  const d = story();
  t.after(d.detruire);
  jusquAuCode(d);
  const liste = JSON.parse(ok(d, ["liste"]).sortie);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].stage, "CODE");
  const fil = ok(d, ["fil", "001-jouet"]).sortie;
  assert.match(fil, /\[001-jouet\] tour 0\/100/);
  assert.match(fil, /✓ PLAN · ◀ CODE · QA · PR · MERGE/);
  ok(d, ["attendre", "001-jouet", "scope", "--motif", "question"]);
  assert.match(ok(d, ["fil", "001-jouet"]).sortie, /waiting_gate_scope \(en attente de Camille\)/);
});

test("une sous-commande inconnue rend le code d'usage", (t) => {
  const d = story();
  t.after(d.detruire);
  assert.equal(d.lancer("etat.mjs", ["supprimer", "001-jouet"]).code, 2);
  assert.equal(d.lancer("etat.mjs", ["tour", "001-jouet", "--force"]).code, 0, "tour ignore ce qu'il ne lit pas");
});

test("gate de plan renvoyée : le stage CODE reste fermé jusqu'à l'approbation", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, ["stage", "001-jouet", "SPEC"]);
  ok(d, ["stage", "001-jouet", "CHALLENGE"]);
  ok(d, ["gate", "001-jouet", "spec", "auto", "--motif", "challenge solide"]);
  ok(d, ["stage", "001-jouet", "PLAN"]);
  ok(d, ["attendre", "001-jouet", "plan", "--motif", "le plan touche un point critique"]);
  ok(d, ["renvoyer", "001-jouet", "PLAN", "--par", "Camille", "--motif", "découper autrement"]);
  assert.equal(etat(d).stage, "PLAN");
  assert.equal(etat(d).gates.plan.etat, "en_attente");
  const r = d.lancer("etat.mjs", ["stage", "001-jouet", "CODE"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /gate de plan/);
  assert.equal(d.lancer("etat.mjs", ["gate", "001-jouet", "plan", "auto", "--motif", "x"]).code, 1);
  assert.equal(etat(d).stage, "PLAN");
  ok(d, ["attendre", "001-jouet", "plan", "--motif", "plan repris après renvoi"]);
  ok(d, ["approuver", "001-jouet", "--par", "Camille"]);
  assert.equal(etat(d).stage, "CODE");
  assert.equal(etat(d).gates.plan.etat, "approuvee");
});

test("renvoyer ne franchit pas la gate qu'il renvoie", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, ["stage", "001-jouet", "SPEC"]);
  ok(d, ["stage", "001-jouet", "CHALLENGE"]);
  ok(d, ["attendre", "001-jouet", "spec", "--motif", "une question ouverte"]);
  for (const vers of ["PLAN", "CODE"]) {
    assert.equal(d.lancer("etat.mjs", ["renvoyer", "001-jouet", vers, "--par", "Camille", "--motif", "x"]).code, 1, vers);
  }
  assert.equal(etat(d).stage, "waiting_gate_spec");
  ok(d, ["approuver", "001-jouet", "--par", "Camille"]);
  ok(d, ["attendre", "001-jouet", "plan", "--motif", "un point critique"]);
  assert.equal(d.lancer("etat.mjs", ["renvoyer", "001-jouet", "CODE", "--par", "Camille", "--motif", "x"]).code, 1);
  assert.equal(etat(d).stage, "waiting_gate_plan");
});
