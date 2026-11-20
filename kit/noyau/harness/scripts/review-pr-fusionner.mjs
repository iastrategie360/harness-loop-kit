#!/usr/bin/env node
// review-pr-fusionner.mjs : fusionne la sortie d'une review de PR dans l'artefact commité.
//
// Appelé par review-pr-locale.sh. Séparé du shell parce que la fusion est la partie qui doit
// être TESTÉE (cinq cas, cf. lib/review-pr-artefact.mjs) et qu'on ne teste pas du bash.
//
// FAIL-CLOSED : si la sortie n'atteste pas d'une review réellement menée, RIEN n'est écrit.
// Un artefact à zéro finding écrit sur une sortie illisible certifierait une PR que personne
// n'a relue.
//
// Usage : review-pr-fusionner.mjs --artefact <review-pr.json> --brut <fichier>
//           [--jsonl <fichier>] --head-sha <sha> --branche <nom> --base <nom>
//           [--modele <nom>] [--racine <dossier>] [--date <ISO>]
//           [--source securite --attestation <fichier>]
//
// `--source securite` (option `mistral`) : la relecture sécurité, rendue dans son propre
// artefact. Elle n'a pas de flux d'événements : la preuve d'une relecture menée au bout est
// l'ATTESTATION que son producteur écrit après avoir validé chaque lot
// (`{lots_total, lots_relus, exclus, fichiers}`). Sans attestation recevable, rien n'est écrit.
// Codes : 0 artefact écrit (json puis md) ; 1 rien n'est écrit ; 64 usage.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseSortieCodex, fusionner, findingsOuverts, genererMarkdown, libelleExtraction, preuvesDeLAttestation,
} from "./lib/review-pr-artefact.mjs";
import { ecrireJson, maintenant } from "./lib/config.mjs";

function arg(nom, defaut = null) {
  const i = process.argv.indexOf(nom);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : defaut;
}

const cheminArtefact = arg("--artefact");
const cheminBrut = arg("--brut");
const cheminJsonl = arg("--jsonl");
const headSha = arg("--head-sha");
const branche = arg("--branche");
const base = arg("--base");
const source = arg("--source");
const cheminAttestation = arg("--attestation");
if (
  !cheminArtefact || !cheminBrut || !headSha || !branche || !base || !cheminArtefact.endsWith(".json") ||
  (source !== null && source !== "securite") || (source === "securite") !== (cheminAttestation !== null)
) {
  console.error(
    "usage : review-pr-fusionner.mjs --artefact <review-pr.json> --brut <fichier> [--jsonl <fichier>] " +
      "--head-sha <sha> --branche <nom> --base <nom> [--modele <nom>] [--racine <dossier>] [--date <ISO>] " +
      "[--source securite --attestation <fichier>]",
  );
  process.exit(64);
}
const modele = arg("--modele", "défaut du CLI");
const racine = arg("--racine", process.cwd());
const date = arg("--date", maintenant());

const lireSiPresent = (chemin) => (chemin && existsSync(chemin) ? readFileSync(chemin, "utf8") : "");
let preuvesImposees = null;
if (source === "securite") {
  let attestation = null;
  try {
    attestation = JSON.parse(lireSiPresent(cheminAttestation));
  } catch {
    attestation = null;
  }
  const { preuves, motif: refus } = preuvesDeLAttestation(attestation);
  if (!preuves) {
    console.error(
      `review-pr-fusionner : attestation de relecture NON RECEVABLE (${cheminAttestation}) : ${refus}. ` +
        "Rien n'a été écrit, la gate reste bloquante.",
    );
    process.exit(1);
  }
  preuvesImposees = preuves;
}
const { findings, synthese, extraction, exploitable, motif } = parseSortieCodex(
  lireSiPresent(cheminBrut),
  lireSiPresent(cheminJsonl),
  racine,
  preuvesImposees,
);
if (!exploitable) {
  console.error(
    `review-pr-fusionner : sortie de review NON EXPLOITABLE (extraction : ${extraction}). ` +
      `Motif : ${motif}. ` +
      `Rien n'a été écrit, la gate reste bloquante. Sortie brute à inspecter : ${cheminBrut}`,
  );
  process.exit(1);
}

let ancien = null;
if (existsSync(cheminArtefact)) {
  try {
    ancien = JSON.parse(readFileSync(cheminArtefact, "utf8"));
  } catch (e) {
    console.error(
      `review-pr-fusionner : artefact existant illisible (${cheminArtefact}) : ${e.message}. ` +
        "Rien n'a été écrit : répare ou supprime le fichier avant de relancer.",
    );
    process.exit(1);
  }
}

const artefact = fusionner(ancien, findings, { headSha, date, modele, synthese, extraction, branche, base, source });
const cheminMarkdown = cheminArtefact.replace(/\.json$/, ".md");
mkdirSync(dirname(cheminArtefact), { recursive: true });
ecrireJson(cheminArtefact, artefact);
writeFileSync(cheminMarkdown, genererMarkdown(artefact));

console.log(
  `review-pr-fusionner : ${findings.length} finding(s) dans cette review (extraction : ${libelleExtraction(extraction)}), ` +
    `${findingsOuverts(artefact).length} bloquant(s) P0 à P2 sans statut au total.`,
);
console.log(`  ${cheminArtefact}`);
console.log(`  ${cheminMarkdown}`);
