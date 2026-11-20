#!/usr/bin/env node
// review-locale.mjs : la GATE de la review de PR. Elle lit l'artefact commité, jamais du texte.
//
// Trois codes, trois gestes :
//   0  tous les findings bloquants sont traités, et la review porte sur le code actuel ;
//   2  au moins un finding P0 à P2 n'a pas de statut : la boucle de correction doit tourner ;
//   3  pas de review exploitable : artefact absent, illisible, malformé, ou PÉRIMÉ (du code a
//      changé depuis la review) : il faut (re)lancer review-pr-locale.sh. Ou artefact propre
//      mais PAS COMMITÉ tel quel : il faut le commiter, la gate ne certifie pas le disque.
//
// Une review reste valable quand seuls des documents de gestion de la story ont bougé depuis
// (l'artefact lui-même, l'état, la spec, le rapport de QA) : sans cette règle, enregistrer la
// review déplacerait le commit courant et la périmerait aussitôt.
//
// DEUX ARTEFACTS quand l'option `mistral` exige la relecture sécurité (`options.mistral.actif` et
// `options.mistral.securite_pr`) : la review de code (`review-pr.json`) et la relecture sécurité
// (`review-securite.json`, à côté). Les deux verdicts se combinent, le plus prudent l'emporte :
// une relecture sécurité absente rend donc 3. Écrire l'un ne périme pas l'autre. Option inactive,
// ou clé absente d'une configuration 1.0.0 : la gate est exactement celle de 1.0.0.
//
// Usage : review-locale.mjs <story-id | chemin/vers/artefact.json> [--head <sha>] [--json]
// Codes : 0, 2, 3 (ci-dessus) ; 64 usage.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, normalize } from "node:path";
import { calculerExit, findingsOuverts, cheminArtefactSecurite, combinerVerdicts, estArtefactSecurite } from "./lib/review-pr-artefact.mjs";
import { chargerConfig, trouverRacine, cheminArtefactReview, securiteExigee, ErreurConfig } from "./lib/config.mjs";

const AVEC_VALEUR = new Set(["--head"]);
const args = process.argv.slice(2);
let cible = null;
const options = {};
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (AVEC_VALEUR.has(a)) {
    options[a] = args[i + 1];
    i += 1;
  } else if (a.startsWith("--")) {
    options[a] = true;
  } else if (cible === null) {
    cible = a;
  }
}
if (!cible || (Object.hasOwn(options, "--head") && typeof options["--head"] !== "string")) {
  console.error("usage : review-locale.mjs <story-id | chemin/vers/artefact.json> [--head <sha>] [--json]");
  process.exit(64);
}

let racine;
let config;
try {
  racine = trouverRacine();
  config = chargerConfig(racine);
} catch (e) {
  if (!(e instanceof ErreurConfig)) throw e;
  console.error(`review locale [ABSENTE] : ${e.message}`);
  process.exit(3);
}
const chemins = config.chemins;
// Deux options écrivent, APRÈS la review, un document partagé qu'elles ont déclaré : l'index
// des notes de story, et le backlog qui reçoit les reports de valeur. Ni l'un ni l'autre ne
// change le comportement du logiciel ; s'ils périmaient la review, la gate serait inatteignable.
const narratifs = [...chemins.narratifs];
if (config.options.note_story.actif) narratifs.push(config.options.note_story.index);
if (config.options.valeur.actif && chemins.backlog) narratifs.push(chemins.backlog);

function lireArtefact(chemin) {
  if (!existsSync(chemin)) return null;
  try {
    return JSON.parse(readFileSync(chemin, "utf8"));
  } catch {
    return null;
  }
}

function git(...a) {
  return execFileSync("git", ["-C", racine, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Les fichiers modifiés depuis le commit relu. Si Git ne sait pas répondre (commit inconnu,
// historique réécrit), on rend une liste NON VIDE : la review est tenue pour périmée.
//
// --no-renames : un fichier DÉPLACÉ ne paraîtrait sinon que sous sa destination. Du code relu,
// déplacé vers un document de gestion de la story, disparaîtrait de la branche sans périmer.
function fichiersDepuis(artefact, head) {
  if (!artefact?.head_sha || artefact.head_sha === head) return [];
  try {
    return git("diff", "--no-renames", "--name-only", `${artefact.head_sha}..${head}`).split("\n").filter(Boolean);
  } catch {
    return ["(diff indisponible)"];
  }
}

const cheminDepot = normalize(cheminArtefactReview(config, racine, cible));

// L'identifiant de la story se lit sur le chemin de l'artefact (<specs>/<id>/review-pr.json),
// pas sur le nom de la branche : un préfixe sans barre (« feature-001-x ») ne se découpe pas.
// Pour un artefact rangé par branche, le préfixe déclaré sert de repli.
function storyDeLArtefact(chemin) {
  const specs = normalize(chemins.specs).replace(/\/+$/, "");
  if (!chemin.startsWith(`${specs}/`)) return null;
  const reste = chemin.slice(specs.length + 1).split("/");
  return reste.length === 2 && reste[1] === "review-pr.json" ? reste[0] : null;
}
const cheminDisque = join(racine, cheminDepot);
const artefact = lireArtefact(cheminDisque);
const avecSecurite = securiteExigee(config);
// La gate se lance sur la story ou sur l'artefact de CODE : elle trouve elle-même l'artefact
// sécurité à côté. Lancée sur l'artefact sécurité, elle l'évaluerait deux fois, et la review de
// code ne serait jamais lue : on refuse.
if (avecSecurite && estArtefactSecurite(cheminDepot)) {
  console.error(
    `usage : ${cheminDepot} est l'artefact de la relecture sécurité. Lancer la gate sur la story, ` +
      "ou sur l'artefact de la review de code : elle lit l'artefact sécurité à côté.",
  );
  process.exit(64);
}
const cheminDepotSecurite = avecSecurite ? cheminArtefactSecurite(cheminDepot) : null;
const artefactSecurite = avecSecurite ? lireArtefact(join(racine, cheminDepotSecurite)) : null;
// Chaque artefact tolère ses propres fichiers ET ceux de l'autre : commiter la relecture sécurité
// après la review de code ne périme pas celle-ci, et inversement.
const cheminsArtefact = [cheminDepot, cheminDepotSecurite]
  .filter(Boolean)
  .flatMap((c) => [c, c.replace(/\.json$/, ".md")]);
const gestion = {
  etat: chemins.etat,
  specs: chemins.specs,
  narratifs,
  story: storyDeLArtefact(cheminDepot),
  prefixe: config.git.prefixe_branche,
};

let head = typeof options["--head"] === "string" ? options["--head"] : null;
let resultat;
if (!head) {
  try {
    head = git("rev-parse", "HEAD");
  } catch (e) {
    resultat = { code: 3, motif: `commit courant introuvable (${e.message.split("\n")[0]}) : impossible de vérifier la fraîcheur de la review` };
  }
}

// Une gate verte certifie ce que la branche PORTE. Un artefact absent du commit évalué, ou
// différent sur le disque (un statut posé et pas encore commité), ne certifie rien : la
// personne qui approuve lirait sur la branche un finding encore ouvert.
function artefactCommite(chemin) {
  try {
    return git("rev-parse", "--verify", "--quiet", `${head}:${chemin}`) === git("hash-object", "--", chemin);
  } catch {
    return false;
  }
}
const aCommiter = [];
function verdictDe(art, chemin) {
  let v = calculerExit(art, head, fichiersDepuis(art, head), cheminsArtefact, gestion);
  if (v.code === 0 && !artefactCommite(chemin)) {
    aCommiter.push(chemin);
    v = { code: 3, motif: "l'artefact sur le disque n'est pas celui du commit : la gate ne certifie que ce qui est commité" };
  }
  return v;
}
let verdictCode = null;
let verdictSecurite = null;
if (!resultat) {
  verdictCode = verdictDe(artefact, cheminDepot);
  if (avecSecurite) {
    verdictSecurite = verdictDe(artefactSecurite, cheminDepotSecurite);
    resultat = combinerVerdicts(verdictCode, verdictSecurite);
  } else {
    resultat = verdictCode;
  }
}

const ouvertsDe = (art, v) => (art && v && v.code !== 3 ? findingsOuverts(art) : []);
const ouverts = avecSecurite
  ? [
    ...ouvertsDe(artefact, verdictCode).map((f) => ({ ...f, source: "code" })),
    ...ouvertsDe(artefactSecurite, verdictSecurite).map((f) => ({ ...f, source: "securite" })),
  ]
  : artefact && resultat.code !== 3 ? findingsOuverts(artefact) : [];
if (options["--json"]) {
  const sortie = {
    artefact: cheminDepot,
    existe: artefact !== null,
    head_courant: head,
    head_reviewe: artefact?.head_sha ?? null,
    a_jour: artefact !== null && artefact?.head_sha === head,
    exit: resultat.code,
    motif: resultat.motif,
    open_p0_p2: ouverts.length,
    rounds: artefact?.rounds ?? 0,
    findings: ouverts.map((f) => ({
      cle: f.cle, severity: f.severity, file: f.file, lines: f.lines, titre: f.titre, survived: f.survived ?? 0,
      ...(avecSecurite ? { source: f.source } : {}),
    })),
  };
  if (avecSecurite) {
    sortie.securite = {
      artefact: cheminDepotSecurite,
      existe: artefactSecurite !== null,
      head_reviewe: artefactSecurite?.head_sha ?? null,
      exit: verdictSecurite?.code ?? 3,
      motif: verdictSecurite?.motif ?? resultat.motif,
      rounds: artefactSecurite?.rounds ?? 0,
    };
  }
  console.log(JSON.stringify(sortie, null, 2));
} else {
  const etiquette = { 0: "OK", 2: "FINDINGS", 3: "ABSENTE" }[resultat.code];
  const nommes = avecSecurite ? `${cheminDepot} + ${cheminDepotSecurite}` : cheminDepot;
  console.log(`review locale [${etiquette}] ${nommes} : ${resultat.motif}`);
  for (const f of ouverts) {
    const ligne = Array.isArray(f.lines) && f.lines[0] ? `:${f.lines[0]}` : "";
    const origine = avecSecurite ? `[${f.source === "securite" ? "sécurité" : "code"}] ` : "";
    console.log(`  ${origine}${f.severity} ${f.file}${ligne} : ${f.titre}`);
  }
  const relance = cible.endsWith(".json") ? "--branche" : cible;
  if (aCommiter.length > 0) {
    for (const c of aCommiter) {
      console.log(`  Pour certifier : commiter ${c} et son .md, nommés un par un, puis relancer cette gate.`);
    }
  } else if (resultat.code === 3 && (!verdictCode || verdictCode.code === 3)) {
    console.log(`  Pour (re)lancer la review : bash harness/scripts/review-pr-locale.sh ${relance}`);
  }
  if (avecSecurite && verdictSecurite?.code === 3 && !aCommiter.includes(cheminDepotSecurite)) {
    console.log(`  Pour (re)lancer la relecture sécurité, APRÈS la review de code : bash harness/scripts/mistral-securite.sh ${relance}`);
  }
}
process.exit(resultat.code);
