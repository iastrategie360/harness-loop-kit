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
//
// Option `jev` (1.2.0), si elle est active et posée : AVANT la fusion, elle compare chaque finding
// neuf aux findings connus du même fichier, et rattache à sa clé la reformulation d'un défaut
// connu et non tranché (cf. harness/options/jev.md). Elle ne fait jamais échouer la fusion : au
// moindre problème, elle le dit sur la sortie d'erreur et la fusion est celle de 1.1.0.
// Codes : 0 artefact écrit (json puis md) ; 1 rien n'est écrit ; 64 usage.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseSortieCodex, fusionner, findingsOuverts, genererMarkdown, libelleExtraction, preuvesDeLAttestation,
} from "./lib/review-pr-artefact.mjs";
import { ecrireJson, maintenant, chargerConfig, jevActive } from "./lib/config.mjs";

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

// Le point de l'option jev. Configuration illisible ou sans la clé (1.1.0), option coupée : rien
// n'est chargé, et la fusion reçoit les findings tels que le relecteur les a rendus.
async function avecJev(nouveaux) {
  let config;
  try {
    config = chargerConfig(racine);
  } catch {
    return nouveaux;
  }
  if (!jevActive(config)) return nouveaux;
  const module = join(dirname(fileURLToPath(import.meta.url)), "jev-rattacher.mjs");
  if (!existsSync(module)) {
    console.error("option jev indisponible : jev-rattacher.mjs n'est pas posé (relancer /harness-install). Fusion sans rattachement.");
    return nouveaux;
  }
  try {
    const { rattacherPr } = await import(pathToFileURL(module).href);
    return await rattacherPr({ racine, config, ancien, nouveaux, headSha, date, artefact: cheminArtefact });
  } catch (e) {
    console.error(`option jev indisponible : ${e?.message ?? e}. Fusion sans rattachement.`);
    return nouveaux;
  }
}

const aFusionner = await avecJev(findings);
const artefact = fusionner(ancien, aFusionner, { headSha, date, modele, synthese, extraction, branche, base, source });
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
