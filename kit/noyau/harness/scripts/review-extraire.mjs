#!/usr/bin/env node
// review-extraire.mjs : tire d'une sortie de review les findings BLOQUANTS, au format attendu
// par « etat.mjs ledger-round ».
//
// La clé d'un finding est la même que celle de l'artefact de review de PR (fichier + titre
// normalisé, jamais la ligne) : un défaut garde donc son identité d'un round à l'autre, et de
// la review de travail à la review de PR.
//
// Usage : review-extraire.mjs --brut <fichier> [--jsonl <fichier>] [--racine <dossier>] --sortie <findings.json>
// Codes : 0 aucun finding bloquant ; 1 sortie non exploitable (rien n'est écrit) ;
//         2 au moins un finding P0 à P2 ; 64 usage.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseSortieCodex, cleFinding, SEVERITES_BLOQUANTES, libelleExtraction } from "./lib/review-pr-artefact.mjs";
import { ecrireJson } from "./lib/config.mjs";

function arg(nom) {
  const i = process.argv.indexOf(nom);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const cheminBrut = arg("--brut");
const cheminJsonl = arg("--jsonl");
const cheminSortie = arg("--sortie");
const racine = arg("--racine") ?? "";
if (!cheminBrut || !cheminSortie) {
  console.error("usage : review-extraire.mjs --brut <fichier> [--jsonl <fichier>] [--racine <dossier>] --sortie <findings.json>");
  process.exit(64);
}

const lireSiPresent = (chemin) => (chemin && existsSync(chemin) ? readFileSync(chemin, "utf8") : "");
const { findings, extraction, exploitable, motif } = parseSortieCodex(lireSiPresent(cheminBrut), lireSiPresent(cheminJsonl), racine);
if (!exploitable) {
  console.error(
    `review-extraire : sortie de review NON EXPLOITABLE (extraction : ${extraction}). ` +
      `Motif : ${motif}. Ce n'est pas une review propre : rien n'est écrit. Sortie brute : ${cheminBrut}`,
  );
  process.exit(1);
}

// Un finding de sévérité illisible est REGARDÉ, pas ignoré : il compte comme un P2.
const RANG = { P0: 0, P1: 1, P2: 2 };
const parCle = new Map();
let mineurs = 0;
for (const f of findings) {
  if (!SEVERITES_BLOQUANTES.includes(f.severity)) {
    mineurs += 1;
    continue;
  }
  const severite = f.severity === "P?" ? "P2" : f.severity;
  const cle = cleFinding(f.file, f.titre);
  const deja = parCle.get(cle);
  // Deux findings de même clé dans une même review : on garde le plus grave.
  if (!deja || RANG[severite] < RANG[deja.severite]) {
    parCle.set(cle, { cle, titre: f.titre || "(sans titre)", severite, fichier: f.file || null });
  }
}
const bloquants = [...parCle.values()].sort((a, b) => RANG[a.severite] - RANG[b.severite] || a.cle.localeCompare(b.cle));

mkdirSync(dirname(cheminSortie), { recursive: true });
ecrireJson(cheminSortie, bloquants);
for (const f of bloquants) console.log(`  ${f.severite} ${f.fichier ?? "(fichier non précisé)"} : ${f.titre}`);
console.log(
  `review-extraire : ${bloquants.length} finding(s) bloquant(s) P0 à P2, ${mineurs} mineur(s) écarté(s) ` +
    `(extraction : ${libelleExtraction(extraction)}). Pour le ledger : ${cheminSortie}`,
);
process.exit(bloquants.length > 0 ? 2 : 0);
