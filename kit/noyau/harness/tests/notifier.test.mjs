import { test } from "node:test";
import assert from "node:assert/strict";
import { depotJouet } from "./aide.mjs";

const JOURNAL = ["harness", ".travail", "notifications.log"];
// Le « canal » de test : une commande qui recopie ce qu'elle reçoit dans un fichier.
const CANAL = 'printf "%s|%s|%s\\n" "$HARNESS_NIVEAU" "$HARNESS_SUJET" "$HARNESS_CORPS" >> envois.txt';

const avecCanal = (commande = CANAL, plus = () => {}) =>
  depotJouet({ config: (c) => { c.notification.commande = commande; plus(c); } });

test("gate : part toujours, à chaque fois", (t) => {
  const d = avecCanal();
  t.after(d.detruire);
  for (let i = 0; i < 2; i += 1) {
    const r = d.lancer("notifier.sh", ["gate", "Story essai", "PR prête à relire"]);
    assert.equal(r.code, 0, r.erreur);
  }
  assert.equal(d.lire("envois.txt"), "gate|Story essai|PR prête à relire\ngate|Story essai|PR prête à relire\n");
  assert.equal(d.lire(...JOURNAL).split("\n").filter((l) => l.includes("\tENVOYE\t")).length, 2);
});

test("alerte : la même alerte ne repart pas dans la fenêtre, une autre part", (t) => {
  const d = avecCanal();
  t.after(d.detruire);
  assert.equal(d.lancer("notifier.sh", ["alerte", "Story essai", "relecteur muet"]).code, 0);
  const r = d.lancer("notifier.sh", ["alerte", "Story essai", "relecteur muet"]);
  assert.equal(r.code, 0);
  assert.match(r.sortie, /non répétée/);
  assert.equal(d.lancer("notifier.sh", ["alerte", "Story essai", "plafond de tours atteint"]).code, 0);
  assert.equal(d.lire("envois.txt").trim().split("\n").length, 2);
  assert.match(d.lire(...JOURNAL), /DEJA ENVOYEE/);
});

test("alerte : passé la fenêtre, elle repart", (t) => {
  const d = avecCanal();
  t.after(d.detruire);
  d.lancer("notifier.sh", ["alerte", "S", "c"]);
  d.lancer("notifier.sh", ["alerte", "S", "c"], { env: { HARNESS_DATE: "2030-01-15T15:59:00Z" } });
  assert.equal(d.lire("envois.txt").trim().split("\n").length, 1);
  d.lancer("notifier.sh", ["alerte", "S", "c"], { env: { HARNESS_DATE: "2030-01-15T16:00:01Z" } });
  assert.equal(d.lire("envois.txt").trim().split("\n").length, 2);
});

test("un envoi en échec rend 4, le dit, et ne fait pas taire la tentative suivante", (t) => {
  const d = avecCanal("echo 'jeton refusé abc123' >&2; exit 22");
  t.after(d.detruire);
  let r = d.lancer("notifier.sh", ["gate", "Story essai", "PR prête"]);
  assert.equal(r.code, 4);
  assert.match(r.erreur, /N'EST PAS parti/);
  const journal = d.lire(...JOURNAL);
  assert.match(journal, /ECHEC ENVOI \(code 22\)/);
  assert.doesNotMatch(journal, /abc123/, "la réponse brute du canal ne va jamais dans le journal");

  r = d.lancer("notifier.sh", ["alerte", "S", "c"]);
  assert.equal(r.code, 4);
  d.reconfigurer((c) => { c.notification.commande = CANAL; });
  r = d.lancer("notifier.sh", ["alerte", "S", "c"]);
  assert.equal(r.code, 0);
  assert.equal(d.lire("envois.txt"), "alerte|S|c\n");
});

test("un canal déclaré avec un pipe garde l'échec de sa première moitié", (t) => {
  const d = avecCanal("(echo 'refus du canal' >&2; exit 22) | cat");
  t.after(d.detruire);
  const r = d.lancer("notifier.sh", ["gate", "Story essai", "PR prête"]);
  assert.equal(r.code, 4);
  assert.match(d.lire(...JOURNAL), /ECHEC ENVOI \(code 22\)/);
});

test("sans canal configuré : journal seul, code 0, et c'est dit", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const r = d.lancer("notifier.sh", ["gate", "Story essai", "PR prête"]);
  assert.equal(r.code, 0);
  assert.match(r.sortie, /journal seul/);
  assert.match(d.lire(...JOURNAL), /JOURNAL SEUL/);
});

test("journal : n'envoie rien", (t) => {
  const d = avecCanal();
  t.after(d.detruire);
  assert.equal(d.lancer("notifier.sh", ["journal", "Story essai", "challenge passé"]).code, 0);
  assert.equal(d.existe("envois.txt"), false);
  assert.match(d.lire(...JOURNAL), /2030-01-15T10:00:00Z\tjournal\tJOURNAL\tStory essai\tchallenge passé/);
});

test("le secret du canal vient du fichier d'environnement, hors de la configuration", (t) => {
  const d = avecCanal('printf "%s" "$JETON_CANAL" > recu.txt');
  t.after(d.detruire);
  const env = d.ecrire("canal.env", "JETON_CANAL=valeur-de-test\n");
  d.reconfigurer((c) => { c.notification.fichier_env = env; });
  assert.equal(d.lancer("notifier.sh", ["test"]).code, 0);
  assert.equal(d.lire("recu.txt"), "valeur-de-test");

  d.reconfigurer((c) => { c.notification.fichier_env = "/chemin/absent.env"; });
  const r = d.lancer("notifier.sh", ["gate", "S", "c"]);
  assert.equal(r.code, 4);
  assert.match(r.erreur, /illisible/);
});

test("un corps sur plusieurs lignes tient sur une ligne de journal", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  d.lancer("notifier.sh", ["journal", "S", "ligne 1\nligne 2"]);
  assert.equal(d.lire(...JOURNAL).trim().split("\n").length, 1);
});

test("usage : un mode inconnu ou un sujet vide rend 2", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  assert.equal(d.lancer("notifier.sh", ["info", "S", "c"]).code, 2);
  assert.equal(d.lancer("notifier.sh", ["gate"]).code, 2);
});
