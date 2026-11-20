import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { depotJouet, commandeProuvee } from "./aide.mjs";

const nonProuvee = (cmd) => commandeProuvee(cmd, { prouvee_le: null, exit: null, duree_s: null });

// Un banc de test : un processus qui dure, et qui laisse une trace quand il est prêt.
const banc = (plus = () => {}) =>
  depotJouet({
    config: (c) => {
      c.execution.type = "web";
      c.commandes.demarrer = commandeProuvee("echo pret > pret.txt; exec sleep 300");
      c.commandes.sante = commandeProuvee("test -f pret.txt");
      plus(c);
    },
  });

test("banc : démarre, se déclare lancé, s'arrête par son PID exact", (t) => {
  const d = banc();
  t.after(() => { d.lancer("banc.sh", ["arreter"]); d.detruire(); });
  let r = d.lancer("banc.sh", ["demarrer"]);
  assert.equal(r.code, 0, r.erreur + r.sortie);
  const fiche = d.lireJson("harness", ".travail", "banc.json");
  assert.equal(typeof fiche.pid, "number");
  assert.doesNotThrow(() => process.kill(fiche.pid, 0));
  assert.match(d.lancer("banc.sh", ["etat"]).sortie, /lancé \(PID/);

  r = d.lancer("banc.sh", ["demarrer"]);
  assert.equal(r.code, 1, "un second démarrage est refusé");

  r = d.lancer("banc.sh", ["arreter"]);
  assert.equal(r.code, 0, r.erreur);
  assert.throws(() => process.kill(fiche.pid, 0));
  assert.equal(d.existe("harness", ".travail", "banc.json"), false);
  assert.match(d.lancer("banc.sh", ["etat"]).sortie, /arrêté/);
});

test("banc : la garde de production refuse AVANT de lancer, sans montrer la valeur", (t) => {
  const d = banc((c) => {
    c.execution.garde_prod = { variables: ["BASE_URL"], fichiers: [".env.local"], motifs_interdits: ["prod\\.exemple\\.test"] };
  });
  t.after(d.detruire);
  d.ecrire(".env.local", 'AUTRE=1\nexport BASE_URL="https://prod.exemple.test/secret-abc"\n');
  let r = d.lancer("banc.sh", ["demarrer"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /BASE_URL \(fichier \.env\.local\)/);
  assert.doesNotMatch(r.erreur + r.sortie, /secret-abc/);
  assert.equal(d.existe("pret.txt"), false, "rien n'a été lancé");

  d.ecrire(".env.local", "BASE_URL=http://localhost:9999\n");
  assert.equal(d.lancer("banc.sh", ["garde"]).code, 0);
  r = d.lancer("banc.sh", ["garde"], { env: { BASE_URL: "https://prod.exemple.test" } });
  assert.equal(r.code, 1);
  assert.match(r.erreur, /environnement du processus/);
});

test("banc : un port interdit ou déjà pris est refusé", async (t) => {
  const serveur = createServer();
  await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
  const pris = serveur.address().port;
  const d = banc((c) => { c.execution.port = pris; c.execution.ports_interdits = [8080]; });
  t.after(() => { serveur.close(); d.detruire(); });

  let r = d.lancer("banc.sh", ["demarrer"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /déjà pris/);
  assert.equal(d.existe("pret.txt"), false);

  r = d.lancer("banc.sh", ["port"], { env: { HARNESS_PORT: "8080" } });
  assert.equal(r.code, 1);
  assert.match(r.erreur, /ports_interdits/);
  assert.equal(d.lancer("banc.sh", ["port"]).sortie.trim(), String(pris));
});

test("banc : un démarrage qui meurt est un échec visible, pas une attente", (t) => {
  const d = banc((c) => { c.commandes.demarrer = commandeProuvee("echo 'port invalide'; exit 3"); });
  t.after(d.detruire);
  const r = d.lancer("banc.sh", ["demarrer"]);
  assert.equal(r.code, 1);
  assert.match(r.sortie + r.erreur, /port invalide/);
  assert.equal(d.existe("harness", ".travail", "banc.json"), false);
});

test("banc : sans commande de démarrage, le banc est déclaré absent", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const r = d.lancer("banc.sh", ["demarrer"]);
  assert.equal(r.code, 0);
  assert.match(r.sortie, /ABSENT/);
  assert.equal(d.lancer("banc.sh", ["arreter"]).code, 0);
});

test("banc : une commande jamais prouvée est refusée hors essai", (t) => {
  const d = banc((c) => { c.commandes.demarrer = nonProuvee("echo pret > pret.txt; exec sleep 300"); });
  t.after(() => { d.lancer("banc.sh", ["arreter"]); d.detruire(); });
  assert.equal(d.lancer("banc.sh", ["demarrer"]).code, 97);
  assert.equal(d.existe("pret.txt"), false);
});

test("banc essai : cycle complet et preuves enregistrées", (t) => {
  const d = banc((c) => {
    c.commandes.demarrer = nonProuvee("echo pret > pret.txt; exec sleep 300");
    c.commandes.sante = nonProuvee("test -f pret.txt");
    c.commandes.capture = nonProuvee('printf "rendu de %s" "$HARNESS_CIBLE" > "$HARNESS_SORTIE"');
  });
  t.after(() => { d.lancer("banc.sh", ["arreter"]); d.detruire(); });
  const r = d.lancer("banc.sh", ["essai"]);
  assert.equal(r.code, 0, r.erreur + r.sortie);
  const c = d.config().commandes;
  assert.equal(c.demarrer.prouvee_le, "2030-01-15");
  assert.equal(c.sante.prouvee_le, "2030-01-15");
  assert.equal(c.capture.prouvee_le, "2030-01-15");
  assert.equal(d.existe("harness", ".travail", "banc.json"), false, "l'essai arrête ce qu'il a lancé");
});

test("banc essai : sans démarrage, la capture se prouve seule", (t) => {
  const d = depotJouet({
    config: (c) => { c.commandes.capture = nonProuvee('printf "rendu de %s" "$HARNESS_CIBLE" > "$HARNESS_SORTIE"'); },
  });
  t.after(d.detruire);
  assert.equal(d.lancer("banc.sh", ["capture", "/", "x.txt"]).code, 97);
  const r = d.lancer("banc.sh", ["essai"]);
  assert.equal(r.code, 0, r.erreur + r.sortie);
  assert.match(r.sortie, /capture prouvée seule/);
  assert.equal(d.config().commandes.capture.prouvee_le, "2030-01-15");
  assert.equal(d.lancer("banc.sh", ["capture", "/", "x.txt"]).code, 0);
  assert.equal(d.lire("x.txt"), "rendu de /");
});

test("capture : une capture vide est un échec, même si la commande rend 0", (t) => {
  const d = banc((c) => { c.commandes.capture = commandeProuvee("true"); });
  t.after(d.detruire);
  const r = d.lancer("banc.sh", ["capture", "/accueil", "captures/accueil.txt"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /n'a rien écrit/);

  d.reconfigurer((c) => { c.commandes.capture = commandeProuvee('printf "rendu de %s" "$HARNESS_CIBLE" > "$HARNESS_SORTIE"'); });
  assert.equal(d.lancer("banc.sh", ["capture", "/accueil", "captures/accueil.txt"]).code, 0);
  assert.equal(d.lire("captures", "accueil.txt"), "rendu de /accueil");
});

test("capture : sans commande déclarée, le refus dit de ne pas la remplacer par un diff", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const r = d.lancer("banc.sh", ["capture", "/", "x.txt"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /aucune commande de capture/);
});

test("banc : un enfant qui ignore le premier signal ne survit pas à l'arrêt", (t) => {
  const d = banc((c) => {
    // Le chef meurt au premier signal ; son enfant l'ignore, comme un serveur lancé par un
    // gestionnaire de paquets.
    c.commandes.demarrer = commandeProuvee("(trap '' TERM; echo $BASHPID > enfant.pid; exec sleep 300) & wait");
    c.commandes.sante = commandeProuvee("test -s enfant.pid");
  });
  let enfant = null;
  t.after(() => {
    if (enfant) { try { process.kill(enfant, "SIGKILL"); } catch { /* déjà parti : c'est le but */ } }
    d.detruire();
  });
  let r = d.lancer("banc.sh", ["demarrer"]);
  assert.equal(r.code, 0, r.erreur + r.sortie);
  enfant = Number(d.lire("enfant.pid").trim());
  assert.doesNotThrow(() => process.kill(enfant, 0));

  r = d.lancer("banc.sh", ["arreter"]);
  assert.equal(r.code, 0, r.erreur);
  assert.throws(() => process.kill(enfant, 0), "l'enfant a été arrêté avec le groupe");
});

test("banc : le lanceur a disparu mais le port répond encore, l'arrêt ne s'annonce pas réussi", async (t) => {
  const serveur = createServer();
  await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
  const pris = serveur.address().port;
  const d = banc();
  t.after(() => { serveur.close(); d.detruire(); });
  const mort = spawnSync("true").pid;
  d.ecrire("harness/.travail/banc.json", JSON.stringify({ pid: mort, port: pris, lance_le: "2030-01-15T10:00:00Z", lance_le_noyau: "0" }));

  const r = d.lancer("banc.sh", ["arreter"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, new RegExp(`le port ${pris} répond encore`));
  assert.doesNotMatch(r.sortie, /arrêté/);
  assert.equal(d.existe("harness", ".travail", "banc.json"), false, "la fiche périmée est retirée");
});

test("banc : santé, capture et arrêt déclarés avec un pipe gardent le rouge de leur première moitié", (t) => {
  const d = banc((c) => {
    c.commandes.demarrer = nonProuvee("exec sleep 300");
    c.commandes.sante = nonProuvee("test -f jamais.txt | cat");
  });
  t.after(() => { d.lancer("banc.sh", ["arreter"]); d.detruire(); });
  // La santé échoue derrière son filtre : le banc n'est jamais dit prêt, rien n'est prouvé.
  let r = d.lancer("banc.sh", ["essai"], { env: { BANC_ATTENTE_S: "2" } });
  assert.equal(r.code, 1, r.erreur + r.sortie);
  assert.match(r.erreur, /pas de réponse après 2 s/);
  assert.equal(d.config().commandes.sante.prouvee_le, null);
  assert.equal(d.config().commandes.demarrer.prouvee_le, null);
  assert.equal(d.existe("harness", ".travail", "banc.json"), false);

  d.reconfigurer((c) => {
    c.commandes.demarrer = commandeProuvee("echo pret > pret.txt; exec sleep 300");
    c.commandes.sante = commandeProuvee("test -f pret.txt");
    c.commandes.capture = commandeProuvee('(printf rendu > "$HARNESS_SORTIE"; exit 4) | cat');
    c.commandes.arreter = commandeProuvee("(exit 5) | cat");
  });
  r = d.lancer("banc.sh", ["capture", "/", "x.txt"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /capture : ÉCHEC \(exit 4\)/);

  assert.equal(d.lancer("banc.sh", ["demarrer"]).code, 0);
  r = d.lancer("banc.sh", ["arreter"]);
  assert.equal(r.code, 5, "l'arrêt rend le code de la commande déclarée, pas celui de son filtre");
  assert.equal(d.existe("harness", ".travail", "banc.json"), false, "le banc est arrêté quand même");
});
