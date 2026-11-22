import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depotJouet, ICI, SCRIPTS, FAUX, lireJson } from "./aide.mjs";
import { cleFinding } from "../scripts/lib/review-pr-artefact.mjs";
import { QUESTION } from "../scripts/lib/jev.mjs";

// Les témoins de l'option jev, joués contre un FAUX serveur HTTP local (TYPESAFE_BASE_URL) : même
// surface que l'API de TypeSafe AI, sans réseau réel, sans coût, et il enregistre tout ce qu'il
// reçoit. Ce qui est gardé, et pourquoi :
//   1. LE SENS SÛR : on ne rattache qu'à un finding connu NON tranché, jamais un P0, seulement dans
//      le même fichier, au-dessus du seuil haut, sur le MINIMUM des deux ordres ;
//   2. RIEN NE SE TAIT : un tranché, un douteux, un ex aequo sont signalés, jamais rattachés ;
//   3. RIEN NE PART qui ne doive partir : chemin exclu, motif de secret, et jamais la clé dans une
//      sortie ou un fichier ;
//   4. FAIL-OPEN BRUYANT : toute panne donne EXACTEMENT la sortie de 1.1.0, et un message ;
//   5. SANS L'OPTION, 1.1.0 À L'IDENTIQUE : les sorties sont comparées à celles que le kit 1.1.0 a
//      produites sur les mêmes entrées (fixtures/jev/attendu-1.1.0-*).

const FIX = join(ICI, "fixtures", "jev");
const CLE = "cle-factice-jev-ne-doit-jamais-sortir-42";
const ARTEFACT = ["specs", "001-jouet", "review-pr.json"];
const SHA = { 1: "1".repeat(40), 2: "2".repeat(40), 3: "3".repeat(40) };
const DATE = { 1: "2030-01-15T10:00:00Z", 2: "2030-01-16T10:00:00Z", 3: "2030-01-17T10:00:00Z" };

// --- Le faux serveur ------------------------------------------------------------------------

function reponse(p, modele = "jev-1.14.0") {
  return { model: modele, answers: { meme: { type: "noul", noul: p } }, usage: { input_tokens: 120, output_tokens: 1 } };
}

// parTitres({"A|B": 0.9}) : le score selon (finding_a.title, finding_b.title). L'ordre exact est
// cherché d'abord : un ordre peut donc rendre autre chose que l'autre.
function parTitres(table, defaut = 0.1) {
  return (corps) => {
    const a = corps?.state?.finding_a?.title;
    const b = corps?.state?.finding_b?.title;
    return { corps: reponse(table[`${a}|${b}`] ?? table[`${b}|${a}`] ?? defaut) };
  };
}

async function fauxJev(repondre = parTitres({})) {
  const recus = [];
  const serveur = http.createServer((req, res) => {
    let brut = "";
    req.on("data", (c) => { brut += c; });
    req.on("end", async () => {
      let corps = null;
      try {
        corps = JSON.parse(brut);
      } catch { /* gardé brut */ }
      recus.push({ url: req.url, methode: req.method, entetes: req.headers, brut, corps });
      const r = (await repondre(corps, recus.length)) ?? {};
      if (r.delai) await new Promise((ok) => setTimeout(ok, r.delai));
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
      res.end(typeof r.corps === "string" ? r.corps : JSON.stringify(r.corps ?? reponse(0.1)));
    });
  });
  await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${serveur.address().port}`,
    recus,
    fermer: () => new Promise((ok) => { serveur.closeAllConnections(); serveur.close(ok); }),
  };
}

// --- Le chantier ----------------------------------------------------------------------------

function chantier({ config = () => {}, actif = true, accord = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "jev-home-"));
  const d = depotJouet({
    config: (c) => {
      c.options.jev.actif = actif;
      c.options.jev.accord_envoi_externe = accord;
      c.options.jev.delai_ms = 2000;
      config(c);
    },
  });
  d.ecrire("specs/001-jouet/spec.md", "# Spec\n");
  const detruire = d.detruire;
  return { ...d, home, detruire() { detruire(); rmSync(home, { recursive: true, force: true }); } };
}

// L'environnement d'un appel : HOME jetable (aucun fichier de clé réel n'est jamais lu), la clé
// factice, le faux serveur. Les variables TYPESAFE_* de la session qui lance les tests sont
// toutes remplacées.
function envJev(d, serveur, plus = {}) {
  return { HOME: d.home, TYPESAFE_API_KEY: CLE, TYPESAFE_BASE_URL: serveur?.url ?? "http://127.0.0.1:9", HARNESS_JEV_PAUSE_MS: "5", ...plus };
}

// Un script lancé SANS bloquer : le faux serveur vit dans ce processus.
function lancer(d, script, args, env = {}) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(SCRIPTS, script), ...args], { cwd: d.racine, env: { ...d.env, ...env } });
    let sortie = "";
    let erreur = "";
    p.stdout.on("data", (c) => { sortie += c; });
    p.stderr.on("data", (c) => { erreur += c; });
    p.on("close", (code) => ok({ code, sortie, erreur }));
  });
}

function lancerBash(d, script, args, env = {}) {
  return new Promise((ok) => {
    const p = spawn("bash", [join(SCRIPTS, script), ...args], { cwd: d.racine, env: { ...d.env, ...env } });
    let sortie = "";
    let erreur = "";
    p.stdout.on("data", (c) => { sortie += c; });
    p.stderr.on("data", (c) => { erreur += c; });
    p.on("close", (code) => ok({ code, sortie, erreur }));
  });
}

// La clé n'est dans AUCUNE sortie, ni dans aucun fichier du dépôt (état, artefact, journal,
// fichiers de travail compris).
function sansCle(d, ...sorties) {
  for (const s of sorties) assert.equal(String(s).includes(CLE), false, "la clé apparaît dans une sortie");
  const parcourir = (dossier) => {
    for (const nom of readdirSync(dossier)) {
      if (nom === ".git") continue;
      const c = join(dossier, nom);
      if (statSync(c).isDirectory()) parcourir(c);
      else assert.equal(readFileSync(c, "utf8").includes(CLE), false, `la clé apparaît dans ${c}`);
    }
  };
  parcourir(d.racine);
}

// --- Stage PR -------------------------------------------------------------------------------

function finding(titre, { p = 1, fichier = "src/garde.py", corps = `Corps : ${titre}.`, ligne = 2 } = {}) {
  return { title: titre, body: corps, priority: p, file: fichier, line_start: ligne, line_end: ligne };
}

let numero = 0;
async function fusion(d, env, findings, n, { brut } = {}) {
  numero += 1;
  const chemin = brut ?? d.ecrire(`harness/.travail/essai/brut-${numero}.json`, JSON.stringify({ findings, overall_explanation: "Essai." }));
  return lancer(d, "review-pr-fusionner.mjs", [
    "--artefact", d.chemin(...ARTEFACT), "--brut", chemin, "--head-sha", SHA[n], "--branche", "feat/001-jouet",
    "--base", "main", "--modele", "faux", "--racine", d.racine, "--date", DATE[n],
  ], env);
}

const artefact = (d) => d.lireJson(...ARTEFACT);
const cle = (titre, fichier = "src/garde.py") => cleFinding(fichier, titre);

async function okFusion(d, env, findings, n) {
  const r = await fusion(d, env, findings, n);
  assert.equal(r.code, 0, r.erreur + r.sortie);
  return r;
}


const A = "La garde accepte une chaîne vide";
const A2 = "Une valeur vide passe encore la garde";
const A3 = "La garde ne refuse que None";
const B = "Le message d'erreur ne nomme pas le champ";

describe("stage PR : le sens sûr", () => {
  test("un finding reformulé d'un connu ouvert, au-dessus du seuil, prend sa clé et sa persistance monte", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.93 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A), finding(B, { p: 2 })], 1);
    assert.equal(s.recus.length, 0, "premier round : rien de connu, aucun appel");
    const r = await okFusion(d, env, [finding(A2), finding(B, { p: 2 })], 2);
    const a = artefact(d);
    assert.equal(Object.hasOwn(a.findings, cle(A2)), false, "la reformulation n'a pas de clé à elle");
    const connu = a.findings[cle(A)];
    assert.equal(connu.statut, null, "le connu reste ouvert, il n'est pas tenu pour corrigé");
    assert.equal(connu.survived, 1, "la persistance monte : l'échelle d'escalade le verra");
    assert.equal(connu.rattachements.length, 1);
    assert.deepEqual(
      { source: connu.rattachements[0].cle_source, titre: connu.rattachements[0].titre, score: connu.rattachements[0].score, modele: connu.rattachements[0].modele, ajoute: connu.rattachements[0].survived_ajoute },
      { source: cle(A2), titre: A2, score: 0.93, modele: "jev-1.14.0", ajoute: 1 },
    );
    assert.equal(a.synthese.open_p0_p2, 2);
    assert.match(r.sortie, /jev : « Une valeur vide passe encore la garde » rattaché à `src-garde-py--la-garde-accepte-une-chaine-vide` \(score 0\.93, modèle jev-1\.14\.0\)/);
    assert.match(d.lire("specs", "001-jouet", "review-pr.md"), /\*\*Rattachement \(option jev\)\*\* : « Une valeur vide passe encore la garde »/);
    assert.equal(s.recus.length, 2, "une seule paire (même fichier, B présent sous sa clé), posée dans les deux ordres");
    const journal = d.lire("harness", ".travail", "jev", "journal.jsonl");
    assert.match(journal, /"action":"rattachement"/);
    assert.match(journal, /"cle_cible":"src-garde-py--la-garde-accepte-une-chaine-vide"/);
    sansCle(d, r.sortie, r.erreur);
    assert.equal(s.recus[0].entetes.authorization, `Bearer ${CLE}`, "la clé part dans l'en-tête, et seulement là");
  });

  test("un connu tranché n'est jamais rattaché : le neuf reste neuf et bloquant, il est signalé", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.97 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A)], 1);
    const st = d.lancer("review-statut.mjs", ["001-jouet", cle(A), "refute", "--note", "garde.py:2 refuse déjà la chaîne vide"]);
    assert.equal(st.code, 0, st.erreur);
    const r = await okFusion(d, env, [finding(A2)], 2);
    const a = artefact(d);
    assert.equal(a.findings[cle(A)].statut, "refute", "le tranché garde son statut");
    assert.equal(a.findings[cle(A)].rattachements, undefined);
    const neuf = a.findings[cle(A2)];
    assert.equal(neuf.statut, null, "le neuf bloque la gate");
    assert.equal(neuf.signalements[0].type, "tranche");
    assert.match(neuf.signalements[0].motif, /doublon probable de `src-garde-py--la-garde-accepte-une-chaine-vide` tranchée \(score 0\.97\)/);
    assert.match(r.sortie, /SIGNALÉ `src-garde-py--une-valeur-vide-passe-encore-la-garde`/);
    assert.match(d.lire("specs", "001-jouet", "review-pr.md"), /\*\*Signalement \(option jev\)\*\* : doublon probable/);
    assert.equal(d.lancer("review-locale.mjs", [d.chemin(...ARTEFACT)]).code !== 0, true, "la gate reste fermée");
  });

  test("bande douteuse : rien n'est rattaché, le meilleur candidat est signalé", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.65 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A)], 1);
    await okFusion(d, env, [finding(A2)], 2);
    const a = artefact(d);
    assert.equal(a.findings[cle(A)].statut, "corrige", "sans rattachement, la règle de 1.1.0 : le connu absent est tenu pour corrigé");
    assert.equal(a.findings[cle(A2)].statut, null);
    assert.equal(a.findings[cle(A2)].signalements[0].type, "douteux");
    assert.equal(a.findings[cle(A2)].signalements[0].candidat, cle(A));
  });

  test("le minimum des deux ordres décide : un ordre haut et l'autre bas ne rattachent rien", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.95, [`${A2}|${A}`]: 0.3 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A)], 1);
    await okFusion(d, env, [finding(A2)], 2);
    const a = artefact(d);
    assert.equal(Object.hasOwn(a.findings, cle(A2)), true, "neuf : 0,3 est sous le seuil bas");
    assert.equal(a.findings[cle(A2)].signalements, undefined);
    const ordres = s.recus.map((x) => `${x.corps.state.finding_a.title}|${x.corps.state.finding_b.title}`).sort();
    assert.deepEqual(ordres, [`${A2}|${A}`, `${A}|${A2}`].sort(), "les deux ordres ont été posés");
  });

  test("seuls les findings du même fichier se comparent ; un finding sans fichier ne se compare pas", async (t) => {
    const s = await fauxJev(parTitres({}, 0.99));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A, { fichier: "src/a.py" })], 1);
    await okFusion(d, env, [finding(A2, { fichier: "src/b.py" }), finding(A3, { fichier: "" })], 2);
    assert.equal(s.recus.length, 0, "aucune paire : aucun connu dans le même fichier");
    assert.equal(Object.hasOwn(artefact(d).findings, cle(A2, "src/b.py")), true);
    // Un connu du même fichier ET un d'un autre fichier : seul le premier est posé.
    const e = chantier();
    t.after(e.detruire);
    const envE = envJev(e, s);
    await okFusion(e, envE, [finding(A, { fichier: "src/a.py" }), finding(B, { fichier: "src/b.py" })], 1);
    await okFusion(e, envE, [finding(A2, { fichier: "src/a.py" })], 2);
    assert.equal(s.recus.length, 2, "une paire, deux ordres");
    assert.equal(s.recus.some((x) => [x.corps.state.finding_a.title, x.corps.state.finding_b.title].includes(B)), false, "le connu de src/b.py n'est jamais posé");
  });

  test("un P0 n'est jamais rattaché, ni comme neuf ni comme cible", async (t) => {
    const s = await fauxJev(parTitres({}, 0.99));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A, { p: 0 }), finding(B, { p: 1, fichier: "src/b.py" })], 1);
    await okFusion(d, env, [finding(A2, { p: 1 }), finding(A3, { p: 0, fichier: "src/b.py" })], 2);
    assert.equal(s.recus.length, 0, "aucune paire avec un P0");
    const a = artefact(d);
    assert.equal(a.findings[cle(A2)].severity, "P1");
    assert.equal(a.findings[cle(A3, "src/b.py")].severity, "P0");
    assert.equal(a.findings[cle(A3, "src/b.py")].statut, null, "le P0 reste neuf et visible tel quel");
  });

  test("ex aequo : aucun rattachement, au superviseur", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9, [`${A3}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A), finding(A3, { p: 2 })], 1);
    await okFusion(d, env, [finding(A2)], 2);
    const a = artefact(d);
    assert.equal(a.findings[cle(A2)].statut, null);
    assert.equal(a.findings[cle(A2)].signalements[0].type, "ex_aequo");
    assert.equal(a.findings[cle(A)].rattachements, undefined);
    assert.equal(a.findings[cle(A3)].rattachements, undefined);
  });

  test("deux reformulations visent la même cible : le meilleur score la prend, l'autre reste neuve", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.85, [`${A}|${A3}`]: 0.95 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A)], 1);
    await okFusion(d, env, [finding(A2), finding(A3)], 2);
    const a = artefact(d);
    assert.equal(a.findings[cle(A)].rattachements[0].cle_source, cle(A3));
    assert.equal(a.findings[cle(A2)].signalements[0].type, "conflit");
    assert.equal(Object.hasOwn(a.findings, cle(A3)), false);
  });

  test("un rattachement ne baisse jamais une sévérité", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A, { p: 1 })], 1);
    await okFusion(d, env, [finding(A2, { p: 2 })], 2);
    assert.equal(artefact(d).findings[cle(A)].severity, "P1", "le P1 connu ne devient pas P2");
    // Dans l'autre sens, la sévérité monte avec le neuf, aux deux registres.
    const e = chantier();
    t.after(e.detruire);
    const envE = envJev(e, s);
    await okFusion(e, envE, [finding(A, { p: 2 })], 1);
    await okFusion(e, envE, [finding(A2, { p: 1 })], 2);
    assert.equal(artefact(e).findings[cle(A)].severity, "P1");
    storyEnCode(e);
    await roundCode(e, envE, 1, [{ titre: A, severite: "P1" }]);
    const r2 = await roundCode(e, envE, 2, [{ titre: A2, severite: "P2" }]);
    assert.deepEqual(r2.findings, [{ cle: cle(A), titre: A2, severite: "P1", fichier: "src/garde.py" }]);
    assert.equal(etatDe(e).review_ledger.code.findings[cle(A)].severite, "P1", "ledger-round recopie la sévérité du fichier : elle ne baisse pas");
  });
});

// --- Stage CODE -----------------------------------------------------------------------------

function storyEnCode(d) {
  const e = (args) => {
    const r = d.lancer("etat.mjs", args);
    assert.equal(r.code, 0, `${args.join(" ")} : ${r.erreur}`);
  };
  e(["init", "001-jouet", "--titre", "Jouet", "--regard-client", "non", "--perimetre", "src/**"]);
  for (const a of [["stage", "001-jouet", "SPEC"], ["stage", "001-jouet", "CHALLENGE"], ["gate", "001-jouet", "spec", "auto", "--motif", "ok"],
    ["stage", "001-jouet", "PLAN"], ["stage", "001-jouet", "CODE"]]) e(a);
}

// Un round du stage CODE tel que le superviseur le joue : findings et corps (ce que rend
// codex-diff-review.sh), jev-rattacher, puis ledger-round.
async function roundCode(d, env, n, liste) {
  const findings = liste.map((f) => ({ cle: cle(f.titre, f.fichier ?? "src/garde.py"), titre: f.titre, severite: f.severite ?? "P1", fichier: f.fichier ?? "src/garde.py" }));
  const chemin = d.ecrire(`harness/.travail/relecteur/round-${n}.md.findings.json`, JSON.stringify(findings));
  d.ecrire(`harness/.travail/relecteur/round-${n}.md.findings.corps.json`, JSON.stringify(Object.fromEntries(findings.map((f, i) => [f.cle, liste[i].corps ?? `Corps : ${f.titre}.`]))));
  const jev = await lancer(d, "jev-rattacher.mjs", ["code", "001-jouet", "--findings", chemin], env);
  assert.equal(jev.code, 0, jev.erreur + jev.sortie);
  const l = d.lancer("etat.mjs", ["ledger-round", "001-jouet", "--findings", chemin]);
  assert.equal(l.code, 0, l.erreur);
  return { jev, bilan: JSON.parse(l.sortie), findings: lireJson(chemin) };
}

const etatDe = (d) => d.lireJson("harness", "state", "001-jouet.json");

describe("stage CODE : le registre de ledger-round", () => {
  test("rattachement : le connu survit, et l'échelle l'escalade à l'arbitre au seuil de survie", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9, [`${A}|${A3}`]: 0.88 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    storyEnCode(d);
    const env = envJev(d, s);
    await roundCode(d, env, 1, [{ titre: A }, { titre: B, severite: "P2" }]);
    const r2 = await roundCode(d, env, 2, [{ titre: A2 }, { titre: B, severite: "P2" }]);
    assert.deepEqual(r2.findings.map((f) => f.cle), [cle(A), cle(B)], "la clé du connu est réécrite dans le fichier de findings");
    assert.equal(r2.findings[0].titre, A2, "le titre reste celui du relecteur");
    assert.deepEqual(r2.bilan.corriges, [], "le connu n'est PAS tenu pour corrigé");
    const seuil = d.config().boucle.seuil_survie;
    const r3 = await roundCode(d, env, 3, [{ titre: A3 }]);
    const e = etatDe(d);
    assert.equal(e.review_ledger.code.findings[cle(A)].survived, 2);
    assert.equal(Object.hasOwn(e.review_ledger.code.findings, cle(A2)), false);
    assert.equal(Object.hasOwn(e.review_ledger.code.findings, cle(A3)), false);
    if (seuil <= 2) assert.deepEqual(r3.bilan.a_escalader, [{ cle: cle(A), vers: "arbitre" }], "le défaut tenace monte à l'arbitre");
    assert.equal(e.extensions.jev.rattachements.length, 2);
    assert.deepEqual(Object.keys(e.extensions.jev.rattachements[0]).sort(), ["ab", "ba", "cle_cible", "cle_source", "corps", "corps_avant", "date", "fichier", "modele", "round", "score", "severite", "titre"]);
    assert.ok(e.historique.some((h) => /jev : « Une valeur vide passe encore la garde » .* rattaché à `src-garde-py--la-garde-accepte-une-chaine-vide` \(score 0\.9, modèle jev-1\.14\.0\)/.test(h.note)));
    sansCle(d, r2.jev.sortie, r2.jev.erreur, r3.jev.sortie, r3.jev.erreur);
  });

  test("un connu tranché (faux_positif) n'est jamais rattaché : le neuf est signalé et reste à corriger", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.95 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    storyEnCode(d);
    const env = envJev(d, s);
    await roundCode(d, env, 1, [{ titre: A }]);
    assert.equal(d.lancer("etat.mjs", ["finding", "001-jouet", cle(A), "faux_positif", "--note", "arbitre : faux"]).code, 0);
    const r2 = await roundCode(d, env, 2, [{ titre: A2 }]);
    assert.deepEqual(r2.findings.map((f) => f.cle), [cle(A2)]);
    assert.deepEqual(r2.bilan.a_corriger, [cle(A2)]);
    const e = etatDe(d);
    assert.equal(e.review_ledger.code.findings[cle(A)].statut, "faux_positif");
    assert.equal(e.extensions.jev.signalements[0].type, "tranche");
    assert.match(r2.jev.sortie, /SIGNALÉ `src-garde-py--une-valeur-vide-passe-encore-la-garde` : doublon probable de `src-garde-py--la-garde-accepte-une-chaine-vide` tranchée/);
  });

  test("codex-diff-review.sh n'écrit les corps à côté qu'avec l'option active", async (t) => {
    for (const actif of [false, true]) {
      const d = chantier({ actif, config: (c) => { c.relecteur.accord_envoi_externe = true; } });
      t.after(d.detruire);
      d.git("checkout", "-q", "-b", "feat/001-jouet");
      d.ecrire("src/garde.py", "def garde(v):\n    return v is not None\n");
      d.git("add", "-A");
      d.git("commit", "-q", "-m", "feat: garde");
      const r = await lancerBash(d, "codex-diff-review.sh", [], { PATH: `${FAUX}:${process.env.PATH}`, FAUX_CODEX_SORTIE: join(FIX, "review-r1.json") });
      assert.equal(r.code, 2, r.erreur + r.sortie);
      const base = ["harness", ".travail", "relecteur", "diff-review-feat_001-jouet.md.findings"];
      assert.deepEqual(lireJson(d.chemin(...base.slice(0, -1), `${base.at(-1)}.json`)), lireJson(join(FIX, "attendu-1.1.0-findings-r1.json")), "les findings gardent la forme de 1.1.0");
      assert.equal(d.existe(...base.slice(0, -1), `${base.at(-1)}.corps.json`), actif);
      if (actif) {
        const corps = d.lireJson(...base.slice(0, -1), `${base.at(-1)}.corps.json`);
        assert.match(corps[cle(A)], /garde\(\) rend True pour une chaîne vide/);
      }
    }
  });
});

// --- Confidentialité ------------------------------------------------------------------------

describe("ce qui ne part jamais", () => {
  test("un finding d'un chemin exclu ne part pas : le faux serveur ne reçoit rien", async (t) => {
    const s = await fauxJev(parTitres({}, 0.99));
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["**/secrets/**"]; } });
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A, { fichier: "config/secrets/acces.py" })], 1);
    await okFusion(d, env, [finding(A2, { fichier: "config/secrets/acces.py" })], 2);
    assert.equal(s.recus.length, 0);
    assert.equal(Object.hasOwn(artefact(d).findings, cle(A2, "config/secrets/acces.py")), true, "il reste neuf, sans appel");
    // Même garde au stage CODE, et rien de son corps n'est gardé dans l'état.
    storyEnCode(d);
    await roundCode(d, env, 1, [{ titre: A, fichier: "secrets/x.py" }]);
    await roundCode(d, env, 2, [{ titre: A2, fichier: "secrets/x.py" }]);
    assert.equal(s.recus.length, 0);
    assert.equal(JSON.stringify(etatDe(d).extensions.jev ?? {}).includes("Corps :"), false);
  });

  test("un finding qui porte un motif de secret ne part pas, ni son voisin", async (t) => {
    const s = await fauxJev(parTitres({}, 0.99));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    // Assemblé ici pour qu'aucun fichier du kit ne porte un motif de secret entier.
    const secret = ["mot_de_passe", " = ", "Tr3sS3cr3t-", "valeur"].join("");
    await okFusion(d, env, [finding(A, { corps: `Le code fixe ${secret} en dur.` })], 1);
    await okFusion(d, env, [finding(A2)], 2);
    assert.equal(s.recus.length, 0, "le connu porte un secret : la paire ne part pas");
    await okFusion(d, env, [finding(A3, { corps: `Toujours ${secret}.` })], 3);
    assert.equal(s.recus.length, 0, "le neuf porte un secret : il ne part pas");
    assert.equal(s.recus.some((x) => x.brut.includes("Tr3sS3cr3t")), false);
  });

  test("le corps envoyé : un objet à clés nommées, la formulation mesurée, le titre et le corps seulement", async (t) => {
    const s = await fauxJev(parTitres({}, 0.2));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A, { corps: "Corps A." })], 1);
    await okFusion(d, env, [finding(A2, { corps: "Corps A2." })], 2);
    assert.equal(s.recus.length, 2);
    for (const r of s.recus) {
      assert.equal(r.methode, "POST");
      assert.equal(r.url, "/v1/systemone");
      assert.equal(r.entetes["content-type"], "application/json");
      assert.deepEqual(Object.keys(r.corps).sort(), ["model", "questions", "state"]);
      assert.equal(r.corps.model, "jev-1.14.0");
      assert.equal(Array.isArray(r.corps.state), false, "jamais un tableau indexé");
      assert.deepEqual(Object.keys(r.corps.state).sort(), ["finding_a", "finding_b"]);
      for (const f of Object.values(r.corps.state)) assert.deepEqual(Object.keys(f).sort(), ["body", "title"]);
      assert.deepEqual(r.corps.questions, { meme: QUESTION });
      assert.equal(r.corps.questions.meme.type, "noul");
    }
    assert.deepEqual(s.recus.map((r) => r.corps.state.finding_a.body).sort(), ["Corps A.", "Corps A2."]);
    assert.doesNotMatch(s.recus.map((r) => r.brut).join(""), /src\/garde\.py|1111111|review-pr/, "ni chemin, ni commit, ni artefact");
  });
});

// --- Fail-open ------------------------------------------------------------------------------

const GOLDEN = {
  json: () => readFileSync(join(FIX, "attendu-1.1.0-review-pr.json"), "utf8"),
  md: () => readFileSync(join(FIX, "attendu-1.1.0-review-pr.md"), "utf8"),
  ledger: () => lireJson(join(FIX, "attendu-1.1.0-ledger.json")),
};

// Le scénario des fixtures : au round 2, le relecteur reformule le défaut de la garde. Sous 1.1.0,
// le connu est tenu pour corrigé et la reformulation entre comme neuve.
async function scenarioFixtures(d, env) {
  const sorties = [];
  for (const n of [1, 2]) {
    const r = await fusion(d, env, null, n, { brut: join(FIX, `review-r${n}.json`) });
    assert.equal(r.code, 0, r.erreur + r.sortie);
    sorties.push(r);
  }
  return sorties;
}

// Après une panne, aucun rattachement : la reformulation entre comme neuve, à côté des connus.
function memeQue110Partiel(d, n) {
  const a = artefact(d);
  assert.equal(Object.hasOwn(a.findings, cle(A2)), true);
  assert.equal(Object.values(a.findings).some((f) => f.rattachements), false);
  assert.equal(Object.keys(a.findings).length, n + 1);
}

function memeQue110(d) {
  assert.equal(d.lire(...ARTEFACT), GOLDEN.json(), "l'artefact est octet pour octet celui de 1.1.0");
  assert.equal(d.lire("specs", "001-jouet", "review-pr.md"), GOLDEN.md());
}

describe("fail-open bruyant : une panne donne exactement 1.1.0, et le dit", () => {
  const pannes = [
    ["clé absente", { TYPESAFE_API_KEY: "" }, null, /option jev indisponible : clé absente/],
    ["accord absent", {}, null, /option jev indisponible : options\.jev\.accord_envoi_externe est à false/, { accord: false }],
    ["HTTP 500", {}, () => ({ status: 500, corps: { error: { type: "internal_error" } } }), /option jev indisponible : HTTP 500 \(internal_error\), après 3 essais/],
    ["HTTP 400 non réessayable", {}, () => ({ status: 400, corps: { error: { type: "max_tokens_exceeded" } } }), /option jev indisponible : HTTP 400 \(max_tokens_exceeded\)\./],
    ["réponse mal formée", {}, () => ({ corps: { model: "jev-1.14.0", answers: { meme: { type: "noul" } } } }), /option jev indisponible : réponse mal formée/],
    ["pas du JSON", {}, () => ({ corps: "<html>passerelle</html>" }), /option jev indisponible : réponse mal formée \(pas du JSON\)/],
    ["délai dépassé", {}, () => ({ delai: 1500, corps: reponse(0.99) }), /option jev indisponible : délai dépassé \(200 ms\)/, { delai: 200 }],
    ["réseau coupé", { TYPESAFE_BASE_URL: "http://127.0.0.1:9" }, null, /option jev indisponible : réseau/],
  ];
  for (const [nom, plusEnv, repondre, attendu, opts = {}] of pannes) {
    test(`stage PR, ${nom}`, async (t) => {
      const s = await fauxJev(repondre ?? parTitres({}, 0.99));
      const d = chantier({ accord: opts.accord ?? true, config: (c) => { if (opts.delai) c.options.jev.delai_ms = opts.delai; } });
      t.after(async () => { await s.fermer(); d.detruire(); });
      const [, r2] = await scenarioFixtures(d, envJev(d, s, plusEnv));
      memeQue110(d);
      assert.match(r2.erreur, attendu);
      sansCle(d, r2.sortie, r2.erreur);
      if (nom === "HTTP 400 non réessayable") assert.equal(s.recus.length, 2, "un essai par ordre, pas de nouvel essai");
      if (nom === "HTTP 500") assert.equal(s.recus.length, 6, "trois essais par ordre");
    });
  }

  test("une panne arrête la file : aucune paire neuve ne part après le premier échec", async (t) => {
    // Douze findings connus dans le même fichier, une paire chacun : la première réponse est un refus.
    const s = await fauxJev(async (corps, n) => (n === 1 ? { status: 401, corps: { error: { type: "unauthorized" } } } : { delai: 100, corps: reponse(0.1) }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    const connus = Array.from({ length: 12 }, (_, i) => finding(`Défaut connu ${i}`, { p: 2 }));
    await okFusion(d, env, connus, 1);
    const r = await okFusion(d, env, [finding(A2)], 2);
    assert.match(r.erreur, /option jev indisponible : HTTP 401/);
    assert.ok(s.recus.length <= 8, `${s.recus.length} requêtes : la file ne s'est pas arrêtée`);
    memeQue110Partiel(d, connus.length);
  });

  test("429 puis réponse : le nouvel essai aboutit", async (t) => {
    const table = parTitres({ [`${A}|${A2}`]: 0.9 });
    const s = await fauxJev((corps, n) => (n <= 2 ? { status: 429, corps: { error: { type: "rate_limited" } } } : table(corps)));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A)], 1);
    await okFusion(d, env, [finding(A2)], 2);
    assert.equal(artefact(d).findings[cle(A)].rattachements.length, 1);
  });

  test("stage CODE, clé absente : le registre est celui de 1.1.0, et l'historique le dit", async (t) => {
    const d = chantier();
    t.after(d.detruire);
    storyEnCode(d);
    const env = envJev(d, null, { TYPESAFE_API_KEY: "" });
    const sorties = [];
    for (const n of [1, 2]) {
      const f = d.ecrire(`harness/.travail/relecteur/r${n}.json`, readFileSync(join(FIX, `attendu-1.1.0-findings-r${n}.json`), "utf8"));
      const j = await lancer(d, "jev-rattacher.mjs", ["code", "001-jouet", "--findings", f], env);
      assert.equal(j.code, 0, j.erreur);
      sorties.push(j);
      assert.equal(d.lire(`harness/.travail/relecteur/r${n}.json`), readFileSync(join(FIX, `attendu-1.1.0-findings-r${n}.json`), "utf8"), "le fichier de findings n'est pas touché");
      assert.equal(d.lancer("etat.mjs", ["ledger-round", "001-jouet", "--findings", f]).code, 0);
    }
    assert.deepEqual(etatDe(d).review_ledger, GOLDEN.ledger());
    assert.match(sorties[1].erreur, /option jev indisponible : clé absente/);
    assert.ok(etatDe(d).historique.some((h) => /option jev indisponible : clé absente/.test(h.note)));
    sansCle(d, ...sorties.flatMap((x) => [x.sortie, x.erreur]));
  });

  test("le fichier de clé se lit quand la variable est absente, et jamais s'il est dans le dépôt", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier({ config: (c) => { c.options.jev.fichier_cle = "~/cles/typesafe"; } });
    t.after(async () => { await s.fermer(); d.detruire(); });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(d.home, "cles"));
    writeFileSync(join(d.home, "cles", "typesafe"), `${CLE}\n`);
    const env = envJev(d, s, { TYPESAFE_API_KEY: "" });
    await okFusion(d, env, [finding(A)], 1);
    await okFusion(d, env, [finding(A2)], 2);
    assert.equal(s.recus[0].entetes.authorization, `Bearer ${CLE}`);
    assert.equal(artefact(d).findings[cle(A)].rattachements.length, 1);

    const dedans = chantier({ config: (c) => { c.options.jev.fichier_cle = "cle-jev.txt"; } });
    t.after(dedans.detruire);
    dedans.ecrire("cle-jev.txt", "pas-une-vraie-cle\n");
    const r = await scenarioFixtures(dedans, envJev(dedans, s, { TYPESAFE_API_KEY: "", HOME: dedans.racine }));
    memeQue110(dedans);
    assert.match(r[1].erreur, /le fichier de clé \(options\.jev\.fichier_cle\) est dans le dépôt/);
    // Un nom qui COMMENCE par deux points reste dans le dépôt.
    const pointe = chantier({ config: (c) => { c.options.jev.fichier_cle = "..cles/typesafe"; } });
    t.after(pointe.detruire);
    pointe.ecrire("..cles/typesafe", "pas-une-vraie-cle\n");
    const r2 = await scenarioFixtures(pointe, envJev(pointe, s, { TYPESAFE_API_KEY: "", HOME: pointe.racine }));
    memeQue110(pointe);
    assert.match(r2[1].erreur, /est dans le dépôt/);
  });
});

// --- Option inactive ou absente --------------------------------------------------------------

describe("sans l'option : 1.1.0 à l'identique", () => {
  const variantes = [
    ["option inactive", (c) => { c.options.jev.actif = false; }],
    ["configuration 1.1.0 sans clé options.jev", (c) => { delete c.options.jev; c.kit.version = "1.1.0"; }],
  ];
  for (const [nom, modifier] of variantes) {
    test(`${nom} : artefact de PR, findings et registre du stage CODE comme en 1.1.0, aucun appel`, async (t) => {
      const s = await fauxJev(parTitres({}, 0.99));
      const d = chantier({ config: modifier });
      t.after(async () => { await s.fermer(); d.detruire(); });
      assert.equal(d.lancer("lib/config.mjs", ["valider"]).code, 0);
      const env = envJev(d, s);
      const sorties = await scenarioFixtures(d, env);
      memeQue110(d);
      for (const r of sorties) assert.doesNotMatch(r.sortie + r.erreur, /jev/);

      storyEnCode(d);
      for (const n of [1, 2]) {
        const f = d.chemin("harness", ".travail", `f${n}.json`);
        const x = d.lancer("review-extraire.mjs", ["--brut", join(FIX, `review-r${n}.json`), "--racine", d.racine, "--sortie", f]);
        assert.equal(x.code, 2, x.erreur);
        assert.equal(readFileSync(f, "utf8"), readFileSync(join(FIX, `attendu-1.1.0-findings-r${n}.json`), "utf8"));
        const j = await lancer(d, "jev-rattacher.mjs", ["code", "001-jouet", "--findings", f], env);
        if (nom === "option inactive") {
          assert.equal(j.code, 0, j.erreur);
          assert.match(j.sortie, /option jev inactive/);
        }
        assert.equal(readFileSync(f, "utf8"), readFileSync(join(FIX, `attendu-1.1.0-findings-r${n}.json`), "utf8"));
        assert.equal(d.lancer("etat.mjs", ["ledger-round", "001-jouet", "--findings", f]).code, 0);
      }
      assert.deepEqual(etatDe(d).review_ledger, GOLDEN.ledger());
      assert.deepEqual(etatDe(d).extensions, {});
      assert.equal(s.recus.length, 0);
      assert.equal(d.existe("harness", ".travail", "jev"), false, "aucun journal");
    });
  }

  test("la même entrée, option active : le défaut reformulé est reconnu (le témoin mesure bien quelque chose)", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    await scenarioFixtures(d, envJev(d, s));
    assert.notEqual(d.lire(...ARTEFACT), GOLDEN.json());
    assert.equal(artefact(d).findings[cle(A)].statut, null);
    assert.equal(Object.hasOwn(artefact(d).findings, cle(A2)), false);
  });

  test("la liste de permissions ne nomme les scripts jev qu'avec l'option active", (t) => {
    const avec = chantier();
    t.after(avec.detruire);
    const p = JSON.parse(avec.lancer("allowlist-verifier.mjs", ["proposer"]).sortie);
    for (const s of ["jev-rattacher.mjs", "jev-defaire.mjs", "jev-mesurer.mjs"]) {
      assert.ok(p.permissions.allow.includes(`Bash(node harness/scripts/${s}:*)`), s);
    }
    const sans = chantier({ actif: false });
    t.after(sans.detruire);
    const q = JSON.parse(sans.lancer("allowlist-verifier.mjs", ["proposer"]).sortie);
    assert.equal(q.permissions.allow.some((r) => /jev/.test(r)), false);
  });
});

// --- Défaire --------------------------------------------------------------------------------

describe("défaire un rattachement : rouvrir comme neuf", () => {
  test("stage PR : la reformulation reprend sa clé, ouverte, et le connu perd la persistance ajoutée", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A)], 1);
    await okFusion(d, env, [finding(A2)], 2);
    await okFusion(d, env, [finding(A2, { p: 2, corps: "Corps le plus récent." })], 3);
    assert.equal(artefact(d).findings[cle(A)].rattachements.length, 2, "la même reformulation rattachée à deux rounds");
    assert.equal(artefact(d).findings[cle(A)].survived, 2);
    assert.equal(d.lancer("jev-defaire.mjs", ["pr", "001-jouet", cle(A), cle(A2)]).code, 1, "sans note : refusé");
    const r = d.lancer("jev-defaire.mjs", ["pr", "001-jouet", cle(A), cle(A2), "--note", "Laurent : deux défauts distincts"]);
    assert.equal(r.code, 0, r.erreur);
    const a = artefact(d);
    assert.equal(a.findings[cle(A2)].statut, null);
    assert.equal(a.findings[cle(A2)].titre, A2);
    assert.equal(a.findings[cle(A2)].survived, 0);
    assert.equal(a.findings[cle(A)].survived, 0);
    assert.equal(a.findings[cle(A)].rattachements.every((x) => x.defait?.note === "Laurent : deux défauts distincts"), true, "tous les rattachements de la source sont défaits");
    assert.equal(a.findings[cle(A2)].corps, "Corps le plus récent.", "la plus récente donne ce qui est rouvert");
    assert.equal(a.findings[cle(A)].corps, `Corps : ${A}.`, "le connu retrouve sa propre description");
    assert.deepEqual(a.findings[cle(A)].lines, [2, 2]);
    assert.equal(a.findings[cle(A2)].severity, "P2");
    assert.equal(a.synthese.open_p0_p2, 2);
    assert.match(d.lire("specs", "001-jouet", "review-pr.md"), /défait le/);
    assert.equal(d.lancer("jev-defaire.mjs", ["pr", "001-jouet", cle(A), cle(A2), "--note", "encore"]).code, 1, "un rattachement se défait une fois");
  });

  test("défaire quand la source est revenue d'elle-même sous sa clé : elle est gardée, le connu est corrigé", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A)], 1);
    await okFusion(d, env, [finding(A2)], 2);
    await okFusion(d, env, [finding(A), finding(A2)], 3);
    const avant = artefact(d).findings[cle(A2)];
    assert.equal(d.lancer("jev-defaire.mjs", ["pr", "001-jouet", cle(A), cle(A2), "--note", "distincts"]).code, 0);
    const a = artefact(d);
    assert.deepEqual(a.findings[cle(A2)], avant, "la source déjà présente n'est pas réécrite");
    assert.equal(a.findings[cle(A)].survived, 1, "le connu perd la persistance du rattachement");
    storyEnCode(d);
    await roundCode(d, env, 1, [{ titre: A }]);
    await roundCode(d, env, 2, [{ titre: A2 }]);
    await roundCode(d, env, 3, [{ titre: A }, { titre: A2 }]);
    assert.equal(d.lancer("jev-defaire.mjs", ["code", "001-jouet", cle(A), cle(A2), "--note", "distincts"]).code, 0);
    assert.equal(etatDe(d).review_ledger.code.findings[cle(A)].survived, 1);
    assert.equal(etatDe(d).review_ledger.code.findings[cle(A2)].survived, 0);
  });

  test("stage CODE : la reformulation entre au registre, ouverte, et le connu perd un round", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    storyEnCode(d);
    const env = envJev(d, s);
    await roundCode(d, env, 1, [{ titre: A }]);
    await roundCode(d, env, 2, [{ titre: A2 }]);
    await roundCode(d, env, 3, [{ titre: A2 }]);
    assert.equal(etatDe(d).review_ledger.code.findings[cle(A)].survived, 2);
    const r = d.lancer("jev-defaire.mjs", ["code", "001-jouet", cle(A), cle(A2), "--note", "deux défauts distincts"]);
    assert.equal(r.code, 0, r.erreur);
    const e = etatDe(d);
    assert.deepEqual(e.review_ledger.code.findings[cle(A2)], { titre: A2, severite: "P1", fichier: "src/garde.py", survived: 0, escalation: null, statut: "ouvert" });
    assert.equal(e.review_ledger.code.findings[cle(A)].survived, 0);
    assert.equal(e.extensions.jev.rattachements.length, 2);
    assert.equal(e.extensions.jev.rattachements.every((x) => x.defait?.note === "deux défauts distincts"), true);
    assert.ok(e.historique.some((h) => /rattachement défait/.test(h.note)));
    assert.equal(e.extensions.jev.corps[cle(A)], `Corps : ${A}.`, "le connu retrouve son corps pour les comparaisons suivantes");
    assert.equal(e.extensions.jev.corps[cle(A2)], `Corps : ${A2}.`);
  });

  test("stage CODE : défaire après une remise à zéro ne retire pas la persistance gagnée depuis", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    storyEnCode(d);
    const env = envJev(d, s);
    await roundCode(d, env, 1, [{ titre: A }]);
    await roundCode(d, env, 2, [{ titre: A2 }]);
    await roundCode(d, env, 3, []);
    assert.equal(etatDe(d).extensions.jev.rattachements[0].remis_a_zero, 3, "le connu absent du round est remis à zéro");
    await roundCode(d, env, 4, [{ titre: A }]);
    await roundCode(d, env, 5, [{ titre: A }]);
    assert.equal(etatDe(d).review_ledger.code.findings[cle(A)].survived, 2);
    const r = d.lancer("jev-defaire.mjs", ["code", "001-jouet", cle(A), cle(A2), "--note", "deux défauts distincts"]);
    assert.equal(r.code, 0, r.erreur);
    assert.equal(etatDe(d).review_ledger.code.findings[cle(A)].survived, 2, "la persistance d'après la remise à zéro reste");
  });

  test("stage CODE : un round joué sans l'option rend la persistance incertaine, défaire n'en retire rien", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    storyEnCode(d);
    const env = envJev(d, s);
    await roundCode(d, env, 1, [{ titre: A }]);
    await roundCode(d, env, 2, [{ titre: A2 }]);
    // Round 3 sans l'option : A absent, ledger-round le remet à zéro, aucune marque n'est posée.
    const vide = d.ecrire("harness/.travail/relecteur/sans-option.json", "[]");
    assert.equal(d.lancer("etat.mjs", ["ledger-round", "001-jouet", "--findings", vide]).code, 0);
    await roundCode(d, env, 4, [{ titre: A }]);
    assert.equal(etatDe(d).review_ledger.code.findings[cle(A)].survived, 1);
    assert.equal(d.lancer("jev-defaire.mjs", ["code", "001-jouet", cle(A), cle(A2), "--note", "distincts"]).code, 0);
    assert.equal(etatDe(d).review_ledger.code.findings[cle(A)].survived, 1, "rien n'est retiré : l'escalade n'est pas retardée");
  });
});

// --- Re-mesure ------------------------------------------------------------------------------

describe("jev-mesurer : re-mesurer les seuils", () => {
  test("paires du même fichier à deux commits, exclusions tenues, deux ordres, tableau par seuil", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.92, [`${A2}|${A}`]: 0.85, [`${A}|${B}`]: 0.55, [`${A2}|${B}`]: 0.2 }));
    const d = chantier({ actif: false, config: (c) => { c.relecteur.chemins_exclus = ["prive/"]; } });
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A), finding("Même commit", { p: 2 }), finding("Exclu un", { fichier: "prive/x.py" })], 1);
    await okFusion(d, env, [finding(A2), finding(B, { p: 2 }), finding("Exclu deux", { fichier: "prive/x.py" }), finding("Bruit d'artefact", { fichier: "specs/001-jouet/review-pr.json" })], 2);
    await okFusion(d, env, [finding("Bruit d'artefact bis", { fichier: "specs/001-jouet/review-pr.json" })], 3);
    const paires = d.chemin("harness", ".travail", "mesure-neuve", "paires.json");
    const p = d.lancer("jev-mesurer.mjs", ["paires", "--sortie", paires]);
    assert.equal(p.code, 0, p.erreur);
    assert.match(p.sortie, /2 finding\(s\) écarté\(s\)/);
    const liste = lireJson(paires);
    const ids = liste.map((x) => `${x.a.titre}|${x.b.titre}`).sort();
    assert.deepEqual(ids, [`${A}|${A2}`, `${A}|${B}`, `Même commit|${A2}`, `Même commit|${B}`, "Bruit d'artefact|Bruit d'artefact bis"].sort(), "finding_a est toujours le plus ancien");
    assert.equal(liste.some((x) => x.fichier === "prive/x.py"), false, "les exclus ne forment aucune paire");
    assert.equal(liste.some((x) => x.a.titre === A && x.b.titre === "Même commit"), false, "même premier commit : pas une paire");
    assert.equal(liste.filter((x) => x.artefact_de_review).length, 1);
    assert.equal(s.recus.length, 0, "construire les paires n'appelle rien");

    const scores = d.chemin("harness", ".travail", "scores.json");
    const q = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", paires, "--scores", scores], env);
    assert.equal(q.code, 0, q.erreur);
    assert.equal(s.recus.length, liste.length * 2, "chaque paire, dans les deux ordres");
    const notes = lireJson(scores);
    const idAA2 = liste.find((x) => x.a.titre === A && x.b.titre === A2).id;
    const idBruitAvant = liste.find((x) => x.artefact_de_review).id;
    assert.equal(notes[idAA2].score, 0.85, "le minimum des deux ordres");
    const encore = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", paires, "--scores", scores], env);
    assert.equal(encore.code, 0);
    assert.equal(s.recus.length, liste.length * 2, "une paire déjà notée n'est pas reposée");

    // Un autre modèle demandé : rien n'est recyclé, chaque paire est reposée.
    const autre = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", paires, "--scores", scores, "--modele", "jev-1.15.0"], env);
    assert.equal(autre.code, 0, autre.erreur);
    assert.equal(s.recus.length, liste.length * 4, "un autre modèle repose toutes les paires");
    assert.equal(s.recus.at(-1).corps.model, "jev-1.15.0");
    assert.equal(lireJson(scores)[idAA2].modele_demande, "jev-1.15.0");

    // Les exclusions se rejouent à l'envoi : un chemin exclu APRÈS la construction des paires ne part pas.
    d.reconfigurer((c) => { c.relecteur.chemins_exclus = ["prive/", "src/"]; });
    const exclu = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", paires, "--scores", d.chemin("harness", ".travail", "scores-2.json")], env);
    assert.equal(exclu.code, 0, exclu.erreur);
    assert.equal(s.recus.length, liste.length * 4 + 2, "seule la paire hors de src/ est posée");
    assert.match(exclu.sortie, /4 refusée\(s\) à l'envoi/);
    // Le fichier de scores ne garde que le jeu courant : rejoué sur les scores complets, il perd
    // les paires désormais exclues.
    const complet = lireJson(scores);
    const reduit = d.chemin("harness", ".travail", "scores-reduits.json");
    d.ecrire("harness/.travail/scores-reduits.json", JSON.stringify(complet));
    const r4 = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", paires, "--scores", reduit, "--modele", "jev-1.15.0"], env);
    assert.equal(r4.code, 0, r4.erreur);
    assert.deepEqual(Object.keys(lireJson(reduit)), [idBruitAvant], "seule la paire encore envoyable reste");
    d.reconfigurer((c) => { c.relecteur.chemins_exclus = ["prive/"]; });

    // Une panne en cours de route : ce qui a été payé est écrit, la panne remonte (code 1).
    let n = 0;
    const s2 = await fauxJev(async (corps) => {
      n += 1;
      if (n === 1) return { status: 400, corps: { error: { type: "invalid_request" } } };
      await new Promise((ok) => setTimeout(ok, 150));
      return { corps: reponse(0.4) };
    });
    t.after(s2.fermer);
    const partiel = d.chemin("harness", ".travail", "scores-3.json");
    const p3 = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", paires, "--scores", partiel], envJev(d, s2));
    assert.equal(p3.code, 1, p3.sortie);
    assert.match(p3.erreur, /HTTP 400/);
    const enVol = Math.floor((s2.recus.length - 1) / 2);
    assert.ok(enVol >= 1, "des paires étaient en vol au moment de la panne");
    assert.equal(Object.keys(lireJson(partiel)).length, enVol, "chaque paire en vol, menée au bout, est écrite");
    // Même panne sur un fichier de scores d'un autre modèle : il ne garde aucun score périmé.
    const mele = d.chemin("harness", ".travail", "scores-meles.json");
    d.ecrire("harness/.travail/scores-meles.json", JSON.stringify(lireJson(scores)));
    n = 0;
    const p4 = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", paires, "--scores", mele, "--modele", "jev-1.16.0"], envJev(d, s2));
    assert.equal(p4.code, 1);
    assert.equal(Object.values(lireJson(mele)).every((x) => x.modele_demande === "jev-1.16.0"), true, "aucun score d'un autre contexte");

    const idAB = liste.find((x) => x.a.titre === A && x.b.titre === B).id;
    const idBruit = liste.find((x) => x.artefact_de_review).id;
    const etiquettes = d.ecrire("harness/.travail/etiquettes.json", JSON.stringify({ [idAA2]: "meme", [idAB]: "different", [idBruit]: "meme" }));
    const tab = d.lancer("jev-mesurer.mjs", ["tableau", "--scores", scores, "--etiquettes", etiquettes, "--seuils", "0.5,0.8"]);
    assert.equal(tab.code, 0, tab.erreur);
    assert.match(tab.sortie, /Toutes les paires étiquetées \(2 vrais doublons, 1 défauts différents\)\n\| seuil \| doublons reconnus \| nouveaux défauts tus \|\n\|---\|---\|---\|\n\| 0\.5 \| 1\/2 \| 1\/1 \|\n\| 0\.8 \| 1\/2 \| 0\/1 \|/);
    assert.match(tab.sortie, /Hors artefacts de review \(1 vrais doublons, 1 défauts différents\)/);
    assert.match(tab.sortie, /plus proche faux « même » : 0\.55/);
    sansCle(d, q.sortie, q.erreur, tab.sortie);
  });
});

// --- Chemins canoniques ---------------------------------------------------------------------

describe("chemins : un seul point de canonicalisation, fermé par défaut", () => {
  // Le connu et le neuf désignent le MÊME fichier exclu sous deux écritures brutes différentes :
  // sans canonicalisation, aucune des deux ne correspond au motif, et la paire partirait.
  // Chaque forme deux fois : la même écriture des deux côtés (seule l'exclusion canonique la
  // retient), puis deux écritures différentes du même fichier.
  const formes = [
    ["« ./ »", "./prive/a.py", "./prive/a.py"],
    ["« ./ » et « // »", "./prive/a.py", "prive//a.py"],
    ["« // »", "prive//a.py", "prive//a.py"],
  ];
  for (const [nom, connu, neuf] of formes) {
    test(`un chemin exclu écrit avec ${nom} ne part pas`, async (t) => {
      const s = await fauxJev(parTitres({}, 0.99));
      const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["prive/"]; } });
      t.after(async () => { await s.fermer(); d.detruire(); });
      const env = envJev(d, s);
      await okFusion(d, env, [finding(A, { fichier: connu })], 1);
      await okFusion(d, env, [finding(A2, { fichier: neuf })], 2);
      assert.equal(s.recus.length, 0);
      assert.equal(Object.hasOwn(artefact(d).findings, cle(A2, neuf)), true, "il reste neuf");
    });
  }

  test("un segment « .. » est refusé partout, même vers un fichier permis, et le journal le nomme", async (t) => {
    const s = await fauxJev(parTitres({}, 0.99));
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["prive/"]; } });
    t.after(async () => { await s.fermer(); d.detruire(); });
    const { symlinkSync, mkdirSync } = await import("node:fs");
    // alias -> prive/sous : « alias/../secret.py » désigne prive/secret.py, que la résolution
    // lexicale prendrait pour secret.py à la racine.
    mkdirSync(d.chemin("prive", "sous"), { recursive: true });
    d.ecrire("prive/secret.py", "S = 1\n");
    symlinkSync("prive/sous", d.chemin("alias"));
    const env = envJev(d, s);
    const cas = [["secret.py", "alias/../secret.py"], ["src/a.py", "src/../src/a.py"], ["src/b.py", "./src/./../src/b.py"], ["@/src/c.py", "@/src/../src/c.py"]];
    let n = 0;
    for (const [connu, neuf] of cas) {
      const e = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["prive/"]; } });
      t.after(e.detruire);
      mkdirSync(e.chemin("prive", "sous"), { recursive: true });
      symlinkSync("prive/sous", e.chemin("alias"));
      storyEnCode(e);
      const envE = envJev(e, s);
      n += 1;
      await roundCode(e, envE, 1, [{ titre: A, fichier: connu.replace("@", e.racine) }]);
      await roundCode(e, envE, 2, [{ titre: A2, fichier: neuf.replace("@", e.racine) }]);
      assert.equal(s.recus.length, 0, `${neuf} ne part pas`);
      assert.match(e.lire("harness", ".travail", "jev", "journal.jsonl"), /"action":"non_envoye".*segment « \.\. » dans le chemin/);
    }
    assert.equal(n, cas.length);
    await okFusion(d, env, [finding(A, { fichier: "secret.py" })], 1);
    await okFusion(d, env, [finding(A2, { fichier: "alias/../secret.py" })], 2);
    assert.equal(s.recus.length, 0, "au stage PR non plus");
    assert.match(d.lire("harness", ".travail", "jev", "journal.jsonl"), /"registre":"pr".*"action":"non_envoye","fichier":"alias\/\.\.\/secret\.py","motif":"segment « \.\. »/);
  });

  test("un chemin absolu dans le dépôt se ramène au relatif : exclu, il ne part pas ; permis, il se compare", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }, 0.99));
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["prive/"]; } });
    t.after(async () => { await s.fermer(); d.detruire(); });
    storyEnCode(d);
    const env = envJev(d, s);
    await roundCode(d, env, 1, [{ titre: A, fichier: "prive/a.py" }, { titre: B, fichier: "src/b.py" }]);
    await roundCode(d, env, 2, [{ titre: A2, fichier: d.chemin("prive", "a.py") }]);
    assert.equal(s.recus.length, 0, "l'absolu d'un exclu ne part pas");
    await roundCode(d, env, 3, [{ titre: A3, fichier: d.chemin("src", "b.py") }]);
    assert.equal(s.recus.length, 2, "l'absolu d'un fichier permis se compare au relatif");
  });

  test("un lien symbolique vers un fichier exclu est exclu", async (t) => {
    const s = await fauxJev(parTitres({}, 0.99));
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["prive/"]; } });
    t.after(async () => { await s.fermer(); d.detruire(); });
    const { symlinkSync } = await import("node:fs");
    d.ecrire("prive/a.py", "CLE = 1\n");
    symlinkSync("prive/a.py", d.chemin("src-lien.py"));
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A, { fichier: "src-lien.py" })], 1);
    await okFusion(d, env, [finding(A2, { fichier: "./src-lien.py" })], 2);
    assert.equal(s.recus.length, 0);
    // Un lien PENDANT vers un exclu pas encore créé, et un lien vers l'extérieur du dépôt.
    for (const lien of ["lien-pendant.py", "lien-dehors.py"]) {
      const e = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["prive/"]; } });
      t.after(e.detruire);
      symlinkSync(lien === "lien-pendant.py" ? "prive/futur.py" : "../hors-du-depot.py", e.chemin(lien));
      const envE = envJev(e, s);
      await okFusion(e, envE, [finding(A, { fichier: lien })], 1);
      await okFusion(e, envE, [finding(A2, { fichier: `./${lien}` })], 2);
      assert.equal(s.recus.length, 0, `${lien} ne part pas`);
    }
  });

  test("un chemin qui sort du dépôt ne part jamais, même sans aucune exclusion", async (t) => {
    const s = await fauxJev(parTitres({}, 0.99));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(d.home, d.chemin("vers-dehors"));
    storyEnCode(d);
    const env = envJev(d, s);
    for (const [n, f] of [["1", "../voisin/a.py"], ["2", "../voisin/./a.py"]]) await roundCode(d, env, Number(n), [{ titre: `${A} ${n}`, fichier: f }]);
    await roundCode(d, env, 3, [{ titre: A, fichier: "/etc/passwd" }]);
    await roundCode(d, env, 4, [{ titre: A2, fichier: "/etc//passwd" }]);
    await roundCode(d, env, 5, [{ titre: A3, fichier: "vers-dehors/a.py" }]);
    await roundCode(d, env, 6, [{ titre: B, fichier: "./vers-dehors/a.py" }]);
    assert.equal(s.recus.length, 0);
  });

  test("« ./a.py » et « a.py » sont le même fichier : ils se comparent, et se rattachent", async (t) => {
    const s = await fauxJev(parTitres({ [`${A}|${A2}`]: 0.9 }));
    const d = chantier();
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A, { fichier: "./src/a.py" })], 1);
    await okFusion(d, env, [finding(A2, { fichier: "src/a.py" })], 2);
    assert.equal(s.recus.length, 2);
    assert.equal(artefact(d).findings[cle(A, "./src/a.py")].rattachements.length, 1);
  });

  test("jev-mesurer : paires sur le chemin canonique, et chaque écriture brute recontrôlée à l'envoi", async (t) => {
    const s = await fauxJev(parTitres({}, 0.3));
    const d = chantier({ actif: false });
    t.after(async () => { await s.fermer(); d.detruire(); });
    const env = envJev(d, s);
    await okFusion(d, env, [finding(A, { fichier: "./src/a.py" }), finding(B, { fichier: "./prive/x.py" })], 1);
    await okFusion(d, env, [finding(A2, { fichier: "src/a.py" }), finding(A3, { fichier: "prive//x.py" })], 2);
    const paires = d.chemin("harness", ".travail", "p.json");
    assert.equal(d.lancer("jev-mesurer.mjs", ["paires", "--sortie", paires]).code, 0);
    const liste = lireJson(paires);
    assert.deepEqual(liste.map((p) => [p.fichier, p.a.titre, p.b.titre]).sort(), [["prive/x.py", B, A3], ["src/a.py", A, A2]]);
    // L'exclusion arrive après la construction : les deux écritures brutes de prive/ sont refusées.
    d.reconfigurer((c) => { c.relecteur.chemins_exclus = ["prive/"]; });
    const scores = d.chemin("harness", ".travail", "s.json");
    const q = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", paires, "--scores", scores], env);
    assert.equal(q.code, 0, q.erreur);
    assert.equal(s.recus.length, 2, "seule la paire de src/a.py part");
    assert.equal(s.recus.some((r) => r.brut.includes(A3)), false);
    // Un fichier de paires retouché : le chemin de la paire dit src/, l'écriture brute d'un des deux
    // findings dit prive/. Chaque écriture est recontrôlée : la paire ne part pas.
    const retouche = lireJson(paires).map((p) => (p.fichier === "src/a.py" ? { ...p, id: `${p.id}#r`, b: { ...p.b, fichier: "./prive/x.py" } } : p));
    const pr = d.ecrire("harness/.travail/p-retouche.json", JSON.stringify(retouche));
    const q2 = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", pr, "--scores", d.chemin("harness", ".travail", "s2.json")], env);
    assert.equal(q2.code, 0, q2.erreur);
    assert.equal(s.recus.length, 2, "la paire retouchée ne part pas");
    // Retouchée vers un AUTRE fichier permis : ce n'est plus une paire du même fichier.
    const autre = lireJson(paires).map((p) => (p.fichier === "src/a.py" ? { ...p, id: `${p.id}#a`, b: { ...p.b, fichier: "src/autre.py" } } : p));
    const pa = d.ecrire("harness/.travail/p-autre.json", JSON.stringify(autre));
    const q3 = await lancer(d, "jev-mesurer.mjs", ["interroger", "--paires", pa, "--scores", d.chemin("harness", ".travail", "s3.json")], env);
    assert.equal(q3.code, 0, q3.erreur);
    assert.equal(s.recus.length, 2, "deux fichiers différents : la paire ne part pas");
  });
});
