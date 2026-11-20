import { test } from "node:test";
import assert from "node:assert/strict";
import { depotJouet } from "./aide.mjs";

const NOTE = ["specs", "001-jouet", "README.md"];
const DOCS = ["brief.md", "spec.md", "plan.md", "tasks.md", "qa-rapport.md"];

function ok(d, script, args) {
  const r = d.lancer(script, args);
  assert.equal(r.code, 0, `${script} ${args.join(" ")} : ${r.erreur}${r.sortie}`);
  return r;
}

function story({ regard = "non", id = "001-jouet", titre = "Une remise sur le panier" } = {}) {
  const d = depotJouet({ config: (c) => { c.options.note_story.actif = true; } });
  ok(d, "etat.mjs", ["init", id, "--titre", titre, "--regard-client", regard, "--perimetre", "src/**"]);
  return d;
}

function jusquaLaGateDeMerge(d, id = "001-jouet") {
  for (const args of [["stage", id, "SPEC"], ["stage", id, "CHALLENGE"], ["gate", id, "spec", "auto", "--motif", "challenge solide"],
    ["stage", id, "PLAN"], ["stage", id, "CODE"], ["stage", id, "QA"], ["stage", id, "PR"], ["stage", id, "NOTE"], ["attendre", id, "merge", "--motif", "PR prête"]]) {
    ok(d, "etat.mjs", args);
  }
}

// Remplace chaque passage à compléter par une vraie phrase, comme le fait le superviseur.
function completer(d) {
  const texte = d.lire(...NOTE).replace(/À COMPLÉTER[^\n]*/g, "Le panier applique une remise à partir de trois articles.");
  d.ecrire(NOTE.join("/"), texte);
}

function poserLesDocuments(d, noms = DOCS) {
  for (const nom of noms) d.ecrire(`specs/001-jouet/${nom}`, `# ${nom}\n\nContenu.\n`);
}

test("note : créée d'après le gabarit, en-tête tiré de l'état, puis inchangée", (t) => {
  const d = story();
  t.after(d.detruire);
  const r = ok(d, "note-index.mjs", ["note", "001-jouet"]);
  assert.match(r.sortie, /écrit : specs\/001-jouet\/README\.md/);
  const note = d.lire(...NOTE);
  assert.match(note, /^---\nstory: 001-jouet\ntitre: "Une remise sur le panier"\netat: en_cours\nrigueur: legere\nregard_client: false\nouverte_le: 2030-01-15\nterminee_le: \n---\n\n# 001-jouet : Une remise sur le panier\n/);
  assert.match(note, /- aucun document pour l'instant/);
  assert.doesNotMatch(note, /<id>|<titre>/);

  assert.match(ok(d, "note-index.mjs", ["note", "001-jouet"]).sortie, /inchangé/);
  assert.equal(d.lire(...NOTE), note);
});

test("note : la prose écrite à la main survit, seules les parties générées bougent", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  completer(d);
  d.ecrire(NOTE.join("/"), `${d.lire(...NOTE)}\n## Annexe\n\nUn paragraphe ajouté à la main.\n`);
  poserLesDocuments(d, ["brief.md", "spec.md", "reports-de-valeur.md"]);
  ok(d, "etat.mjs", ["rigueur", "001-jouet", "complete", "--motif", "la story touche une écriture en base"]);

  assert.equal(d.lancer("note-index.mjs", ["note", "001-jouet", "--verifier"]).code, 1, "pas à jour tant qu'on n'a pas régénéré");
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  const note = d.lire(...NOTE);
  assert.match(note, /\nrigueur: complete\n/);
  assert.match(note, /## Documents\n\n- \[Brief\]\(brief\.md\)\n- \[Spec\]\(spec\.md\)\n- \[Reports de valeur\]\(reports-de-valeur\.md\)\n<!-- documents:fin -->/);
  assert.match(note, /Le panier applique une remise à partir de trois articles\./);
  assert.match(note, /## Annexe\n\nUn paragraphe ajouté à la main\.\n$/);
  assert.equal(note.match(/^---$/gm).length, 2, "un seul en-tête");
  assert.equal(d.lancer("note-index.mjs", ["note", "001-jouet", "--verifier"]).code, 0);
});

test("note : sans ses marqueurs, refus qui dit quoi remettre, et rien n'est écrit", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  const abimee = d.lire(...NOTE).replace("<!-- documents:fin -->\n", "");
  d.ecrire(NOTE.join("/"), abimee);
  const r = d.lancer("note-index.mjs", ["note", "001-jouet"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /REFUS : .*documents:fin/);
  assert.equal(d.lire(...NOTE), abimee);
});

test("index : une ligne par story, tri numérique, idempotent, et --verifier n'écrit rien", (t) => {
  const d = story({ id: "010-dixieme", titre: "Un titre | avec une barre" });
  t.after(d.detruire);
  ok(d, "etat.mjs", ["init", "002-deuxieme", "--titre", "La deuxième", "--regard-client", "oui", "--perimetre", "docs/**"]);
  ok(d, "note-index.mjs", ["note", "002-deuxieme"]);

  const v = d.lancer("note-index.mjs", ["index", "--verifier"]);
  assert.equal(v.code, 1);
  assert.match(v.sortie, /absent : specs\/INDEX\.md/);
  assert.equal(d.existe("specs", "INDEX.md"), false);

  assert.match(ok(d, "note-index.mjs", ["index"]).sortie, /écrit : specs\/INDEX\.md/);
  const index = d.lire("specs", "INDEX.md");
  const lignes = index.split("\n").filter((l) => l.startsWith("| `"));
  assert.deepEqual(lignes, [
    "| `002-deuxieme` | La deuxième | en cours | légère | oui | [note](002-deuxieme/README.md) |",
    "| `010-dixieme` | Un titre \\| avec une barre | en cours | légère | non | absente |",
  ]);
  assert.match(index, /_2 stories\. Page générée/);
  assert.match(ok(d, "note-index.mjs", ["index"]).sortie, /inchangé/);
  assert.equal(d.lancer("note-index.mjs", ["index", "--verifier"]).code, 0);
});

test("index : son chemin vient de la configuration, et le lien vers la note le suit", (t) => {
  const d = story();
  t.after(d.detruire);
  d.reconfigurer((c) => { c.options.note_story.index = "docs/STORIES.md"; });
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  ok(d, "note-index.mjs", ["index"]);
  assert.match(d.lire("docs", "STORIES.md"), /\[note\]\(\.\.\/specs\/001-jouet\/README\.md\)/);
  assert.match(d.lire("docs", "STORIES.md"), /_1 story\. /);
});

test("valider : un squelette est refusé, et TOUTES les causes sont nommées d'un coup", (t) => {
  const d = story();
  t.after(d.detruire);
  let r = d.lancer("note-valider.sh", ["001-jouet"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /la note est absente : specs\/001-jouet\/README\.md/);

  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  r = d.lancer("note-valider.sh", ["001-jouet"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /7 cause\(s\)/);
  assert.match(r.erreur, /3 passage\(s\) « À COMPLÉTER »/);
  for (const doc of DOCS) assert.match(r.erreur, new RegExp(`document attendu absent ou vide : specs/001-jouet/${doc.replace(".", "\\.")}`));
  assert.match(r.erreur, /l'index des stories n'est pas à jour/);
});

test("valider : conforme une fois la note complétée, les documents posés et tout régénéré", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  completer(d);
  poserLesDocuments(d);

  // Les documents sont arrivés après la dernière génération : la liste ne les porte pas encore.
  let r = d.lancer("note-valider.sh", ["001-jouet"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /la liste des documents ne suit plus l'état/);

  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  ok(d, "note-index.mjs", ["index"]);
  r = d.lancer("note-valider.sh", ["001-jouet"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /note conforme : specs\/001-jouet\/README\.md/);

  // Un document vide ne compte pas comme produit.
  d.ecrire("specs/001-jouet/qa-rapport.md", "");
  r = d.lancer("note-valider.sh", ["001-jouet"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /1 cause\(s\)/);
  assert.match(r.erreur, /qa-rapport\.md/);
});

test("valider : le regard en aval n'est attendu que si un utilisateur voit la story", (t) => {
  const d = story({ regard: "oui" });
  t.after(d.detruire);
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  completer(d);
  poserLesDocuments(d);
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  ok(d, "note-index.mjs", ["index"]);
  const r = d.lancer("note-valider.sh", ["001-jouet"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /1 cause\(s\)/);
  assert.match(r.erreur, /regard-aval\.md/);

  poserLesDocuments(d, ["regard-aval.md"]);
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  assert.equal(d.lancer("note-valider.sh", ["001-jouet"]).code, 0);
});

test("clôture : l'état passé à DONE périme la note et l'index, la régénération les date", (t) => {
  const d = story();
  t.after(d.detruire);
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  completer(d);
  poserLesDocuments(d);
  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  ok(d, "note-index.mjs", ["index"]);
  jusquaLaGateDeMerge(d);
  assert.equal(d.lancer("note-valider.sh", ["001-jouet"]).code, 0, "avancer dans les stages ne périme rien");

  ok(d, "etat.mjs", ["approuver", "001-jouet", "--par", "Camille", "--pr-mergee"]);
  const r = d.lancer("note-valider.sh", ["001-jouet"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /2 cause\(s\)/);

  ok(d, "note-index.mjs", ["note", "001-jouet"]);
  ok(d, "note-index.mjs", ["index"]);
  assert.match(d.lire(...NOTE), /\netat: terminee\n[\s\S]*\nterminee_le: 2030-01-15\n---\n/);
  assert.match(d.lire("specs", "INDEX.md"), /\| `001-jouet` \| Une remise sur le panier \| terminée le 2030-01-15 \|/);
  assert.equal(d.lancer("note-valider.sh", ["001-jouet"]).code, 0);
});

test("usage et refus : 2 sans argument, 1 sur une story inconnue", (t) => {
  const d = story();
  t.after(d.detruire);
  assert.equal(d.lancer("note-valider.sh", []).code, 2);
  assert.equal(d.lancer("note-index.mjs", []).code, 2);
  assert.equal(d.lancer("note-index.mjs", ["note"]).code, 2);
  assert.equal(d.lancer("note-index.mjs", ["autre"]).code, 2);
  let r = d.lancer("note-index.mjs", ["note", "404-absente"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /REFUS : état introuvable/);
  r = d.lancer("note-valider.sh", ["404-absente"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /REFUS : état de « 404-absente » illisible/);
});
