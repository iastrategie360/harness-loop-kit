#!/usr/bin/env node
// decouper-diff.mjs : écrit les lots d'un diff de branche pour les relecteurs de l'option mistral.
//
// Appelé par mistral-commun.sh (mistral_decouper). Toute la logique vit dans
// lib/decoupe-diff.mjs (pure, éprouvée par harness/tests/mistral.test.mjs).
//
// Usage :
//   node decouper-diff.mjs --diff <fichier.diff> --sortie <dossier> [--max 45000]
//        [--exclure <motif>]... [--empreinte <texte>] [--reprise]
//
// --reprise (MISTRAL_REPRISE=1 côté shell) : après une relecture INCOMPLÈTE, garde les réponses
// des lots dont le texte est IDENTIQUE au caractère près, pour ne relancer que les lots
// manquants. Tout lot dont le texte a changé perd ses réponses : on ne reprend jamais une réponse
// portant sur un autre diff. Les réponses sont aussi LIÉES À L'INSTANTANÉ du dépôt
// (--empreinte) : le relecteur lit des fichiers hors du lot (un appelant, une configuration),
// donc une réponse obtenue sur un autre état du dépôt ne vaut plus, même pour un lot de texte
// identique. Empreinte différente : le dossier repart à neuf.
//
// Écrit <dossier>/lot-001.diff, lot-002.diff, ... et <dossier>/index.json :
//   { lots: [{ index, chemin, fichiers, octets }], exclus: [...], fichiers: [...], max }
// Codes : 0 lots écrits (zéro lot est un résultat : diff entièrement exclu) ; 1 erreur d'usage
// ou de lecture (jamais un index vide pris pour « rien à lire »).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decouperDiff } from "./lib/decoupe-diff.mjs";

const argv = process.argv.slice(2);
function arg(nom, defaut = null) {
  const i = argv.indexOf(`--${nom}`);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : defaut;
}
const exclusions = [];
argv.forEach((a, i) => {
  if (a === "--exclure" && argv[i + 1] !== undefined) exclusions.push(argv[i + 1]);
});

const cheminDiff = arg("diff");
const sortie = arg("sortie");
const max = Number(arg("max", "45000"));
if (!cheminDiff || !sortie) {
  console.error("usage : node decouper-diff.mjs --diff <f.diff> --sortie <dossier> [--max N] [--exclure motif]... [--empreinte t] [--reprise]");
  process.exit(1);
}

let diff;
try {
  diff = readFileSync(cheminDiff, "utf8");
} catch (e) {
  console.error(`ERREUR : diff illisible (${cheminDiff}) : ${e.message}`);
  process.exit(1);
}

let resultat;
try {
  resultat = decouperDiff(diff, { max, exclusions });
} catch (e) {
  console.error(`ERREUR : découpe impossible : ${e.message}`);
  process.exit(1);
}

const empreinte = arg("empreinte", "");
const fichierEmpreinte = join(sortie, "empreinte");
let reprise = argv.includes("--reprise");
if (reprise && existsSync(sortie)) {
  const precedente = existsSync(fichierEmpreinte) ? readFileSync(fichierEmpreinte, "utf8").trim() : null;
  if (!empreinte || precedente !== empreinte) {
    console.error("decouper-diff : reprise REFUSÉE, le dépôt a changé depuis les réponses gardées : tout est relu.");
    reprise = false;
  }
}
const nomLot = (i) => `lot-${String(i).padStart(3, "0")}.diff`;
if (!reprise) {
  // Dossier repris à neuf : un lot d'un passage précédent ne doit jamais être relu par erreur.
  rmSync(sortie, { recursive: true, force: true });
} else if (existsSync(sortie)) {
  // Reprise : on efface les réponses de tout lot dont le texte ne sera plus le même, et tout ce
  // qui dépasse le nouveau nombre de lots. Seules survivent les réponses d'un lot identique.
  const nouveaux = new Map(resultat.lots.map((l) => [nomLot(l.index), l.texte]));
  for (const f of readdirSync(sortie)) {
    const m = /^(lot-\d{3}\.diff)(.*)$/.exec(f);
    if (!m) continue;
    const ancien = existsSync(join(sortie, m[1])) ? readFileSync(join(sortie, m[1]), "utf8") : null;
    if (!nouveaux.has(m[1]) || nouveaux.get(m[1]) !== ancien) {
      rmSync(join(sortie, f), { recursive: true, force: true });
    }
  }
}
mkdirSync(sortie, { recursive: true });
const index = { lots: [], exclus: resultat.exclus, fichiers: resultat.fichiers, max };
for (const lot of resultat.lots) {
  const nom = nomLot(lot.index);
  writeFileSync(join(sortie, nom), lot.texte);
  index.lots.push({ index: lot.index, chemin: join(sortie, nom), fichiers: lot.fichiers, octets: lot.octets });
}
writeFileSync(join(sortie, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
writeFileSync(fichierEmpreinte, `${empreinte}\n`);
console.log(
  `decouper-diff : ${index.lots.length} lot(s), ${resultat.fichiers.length} fichier(s) retenu(s), ` +
    `${resultat.exclus.length} exclu(s).`,
);
