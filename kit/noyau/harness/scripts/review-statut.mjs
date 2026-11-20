#!/usr/bin/env node
// review-statut.mjs : pose le statut d'UN finding dans l'artefact de review de PR.
//
// POURQUOI un script pour ça : la gate ne lit qu'un CHAMP énuméré. Écrit à la main dans le
// JSON, ce champ se trompe d'une lettre et le finding reste ouvert sans qu'on comprenne
// pourquoi, ou bien le fichier Markdown lu par l'approbateur ne suit plus le JSON. Ici le
// statut est contrôlé, la note est exigée quand la décision est délibérée, et les deux fichiers
// sont réécrits ensemble.
//
// Usage :
//   review-statut.mjs <story-id | artefact.json> <cle> <statut> [--note "<pourquoi>"]
//                     [--escalade <arbitre|humain>]
//   <statut> = corrige | refute | faux_positif | perime | differe_valeur | ecarte_valeur
//   La note est OBLIGATOIRE pour tout statut autre que « corrige ».
//   <statut> = rouvrir : EFFACE le statut posé (une décision prise à tort, ou un report dont
//   le déclencheur de réveil a tiré). Le finding bloque de nouveau la gate. Note obligatoire.
//
// Codes : 0 statut posé ; 1 refus (artefact absent, clé inconnue, statut inconnu, note
//         manquante) ; 64 usage.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATUTS, genererMarkdown } from "./lib/review-pr-artefact.mjs";
import { chargerConfig, trouverRacine, cheminArtefactReview, ecrireJson, maintenant, ErreurConfig } from "./lib/config.mjs";

const positionnels = [];
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--note" || argv[i] === "--escalade") {
    options[argv[i]] = argv[i + 1];
    i += 1;
  } else {
    positionnels.push(argv[i]);
  }
}
const [cible, cle, statut] = positionnels;
if (!cible || !cle || !statut || positionnels.length !== 3) {
  console.error(`usage : review-statut.mjs <story-id | artefact.json> <cle> <statut> [--note "<pourquoi>"] [--escalade <arbitre|humain>]\n  <statut> = ${STATUTS.join(" | ")} | rouvrir`);
  process.exit(64);
}

function refuser(message) {
  console.error(`REFUS : ${message}`);
  process.exit(1);
}

let racine;
let config;
try {
  racine = trouverRacine();
  config = chargerConfig(racine);
} catch (e) {
  if (!(e instanceof ErreurConfig)) throw e;
  refuser(e.message);
}

const rouvrir = statut === "rouvrir";
if (!rouvrir && !STATUTS.includes(statut)) refuser(`statut inconnu : « ${statut} ». Attendu : ${STATUTS.join(", ")}, ou « rouvrir ».`);
const note = typeof options["--note"] === "string" ? options["--note"].trim() : "";
if (statut !== "corrige" && note === "") {
  refuser(`le statut « ${statut} » est une décision : il exige --note "<pourquoi>" (c'est ce que lira l'approbateur).`);
}
const escalade = options["--escalade"];
if (escalade !== undefined && !["arbitre", "humain"].includes(escalade)) refuser("--escalade attend « arbitre » ou « humain ».");

const cheminDepot = cheminArtefactReview(config, racine, cible);
const chemin = join(racine, cheminDepot);
if (!existsSync(chemin)) refuser(`artefact absent : ${cheminDepot}. Lancer d'abord review-pr-locale.sh.`);
let artefact;
try {
  artefact = JSON.parse(readFileSync(chemin, "utf8"));
} catch (e) {
  refuser(`artefact illisible : ${cheminDepot} (${e.message})`);
}
const finding = artefact.findings?.[cle];
if (!finding) {
  const connues = Object.keys(artefact.findings ?? {});
  refuser(`clé inconnue : « ${cle} ». Clés de l'artefact :\n${connues.map((c) => `  ${c}`).join("\n") || "  (aucune)"}`);
}

if (rouvrir) {
  if (finding.statut === null || finding.statut === undefined) refuser(`rien à rouvrir : « ${cle} » n'a pas de statut.`);
  finding.note = `Rouvert le ${maintenant()} (statut précédent : ${finding.statut}) : ${note}`;
  finding.statut = null;
  finding.date_statut = null;
} else {
  finding.statut = statut;
  finding.note = note === "" ? finding.note ?? null : note;
  finding.date_statut = maintenant();
}
finding.auto = false;
if (escalade !== undefined) finding.escalation = escalade;
ecrireJson(chemin, artefact);
writeFileSync(chemin.replace(/\.json$/, ".md"), genererMarkdown(artefact));
console.log(rouvrir ? `finding rouvert : ${cle} (${cheminDepot})` : `statut posé : ${cle} -> ${statut} (${cheminDepot})`);
