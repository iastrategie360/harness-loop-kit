#!/usr/bin/env node
// note-index.mjs : tout ce qui, dans la note d'une story et dans l'index des stories, se
// DÉDUIT de l'état. Une prose recopiée à la main se périme ; ce qui est généré ici se régénère,
// et le mode --verifier dit si c'est à jour.
//
// Usage :
//   note-index.mjs note <story-id> [--verifier]
//       Crée la note <specs>/<id>/README.md d'après harness/gabarits/note-story.md si elle
//       n'existe pas, puis réécrit ses deux parties générées : l'en-tête (entre les deux lignes
//       « --- ») et la liste des documents (entre les deux marqueurs « documents »). Le reste
//       de la note, écrit à la main, n'est jamais touché.
//   note-index.mjs index [--verifier]
//       Réécrit l'index des stories (options.note_story.index), une ligne par état de story.
//   --verifier : n'écrit rien ; code 1 si le fichier n'est pas à jour.
//
// Codes : 0 fait (« écrit » ou « inchangé ») ; 1 refus ou fichier pas à jour ; 2 usage.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chargerConfig, trouverRacine, ErreurConfig } from "./lib/config.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const GABARIT = join(ICI, "..", "gabarits", "note-story.md");
const DEBUT = "<!-- documents:debut -->";
const FIN = "<!-- documents:fin -->";

// Les documents qu'une story peut produire, dans l'ordre où on les lit.
const DOCUMENTS = [
  ["brief.md", "Brief"],
  ["spec.md", "Spec"],
  ["challenge.md", "Challenge de la spec"],
  ["regard-amont.md", "Regard en amont"],
  ["plan.md", "Plan"],
  ["tasks.md", "Tâches"],
  ["qa-rapport.md", "Rapport de QA"],
  ["review-pr.md", "Review de la PR"],
  ["regard-aval.md", "Regard en aval"],
  ["reports-de-valeur.md", "Reports de valeur"],
];

class Refus extends Error {}

function lireEtat(racine, config, id) {
  const chemin = join(racine, config.chemins.etat, `${id}.json`);
  if (!existsSync(chemin)) throw new Refus(`état introuvable : ${chemin}`);
  return JSON.parse(readFileSync(chemin, "utf8"));
}

const jour = (date) => (typeof date === "string" ? date.slice(0, 10) : "");
const terminee = (etat) => etat.stage === "DONE";
const dateFin = (etat) => (terminee(etat) ? jour(etat.gates?.merge?.date) : "");

function entete(etat) {
  return [
    "---",
    `story: ${etat.story}`,
    `titre: ${JSON.stringify(etat.titre)}`,
    `etat: ${terminee(etat) ? "terminee" : "en_cours"}`,
    `rigueur: ${etat.rigueur}`,
    `regard_client: ${etat.regard_client}`,
    `ouverte_le: ${jour(etat.historique?.[0]?.date)}`,
    `terminee_le: ${dateFin(etat)}`,
    "---",
  ].join("\n");
}

function blocDocuments(dossier) {
  const lignes = DOCUMENTS.filter(([nom]) => existsSync(join(dossier, nom))).map(([nom, libelle]) => `- [${libelle}](${nom})`);
  return [DEBUT, "## Documents", "", ...(lignes.length > 0 ? lignes : ["- aucun document pour l'instant"]), FIN].join("\n");
}

// Rend la note attendue : le texte existant, dont seules les deux parties générées changent.
function noteAttendue(racine, config, id) {
  const etat = lireEtat(racine, config, id);
  const dossier = join(racine, config.chemins.specs, id);
  const chemin = join(dossier, "README.md");
  let texte;
  if (existsSync(chemin)) {
    texte = readFileSync(chemin, "utf8");
  } else {
    if (!existsSync(GABARIT)) throw new Refus(`gabarit absent : ${GABARIT}`);
    texte = readFileSync(GABARIT, "utf8").replaceAll("<id>", id).replaceAll("<titre>", etat.titre);
  }

  const corps = /^---\n[\s\S]*?\n---\n?/.test(texte) ? texte.replace(/^---\n[\s\S]*?\n---\n?/, "") : texte;
  texte = `${entete(etat)}\n${corps.startsWith("\n") ? "" : "\n"}${corps}`;

  const i = texte.indexOf(DEBUT);
  const j = texte.indexOf(FIN);
  if (i === -1 || j === -1 || j < i) {
    throw new Refus(`${chemin} : les deux marqueurs « ${DEBUT} » et « ${FIN} » sont attendus, dans cet ordre. Les remettre, sur deux lignes voisines, là où la liste des documents doit paraître.`);
  }
  texte = `${texte.slice(0, i)}${blocDocuments(dossier)}${texte.slice(j + FIN.length)}`;
  return { chemin, texte };
}

function indexAttendu(racine, config) {
  const chemin = join(racine, config.options.note_story.index);
  const dossierEtats = join(racine, config.chemins.etat);
  const etats = existsSync(dossierEtats)
    ? readdirSync(dossierEtats).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dossierEtats, f), "utf8")))
    : [];
  etats.sort((a, b) => a.story.localeCompare(b.story, "fr", { numeric: true }));
  const cellule = (s) => String(s).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
  const lignes = etats.map((e) => {
    const note = join(racine, config.chemins.specs, e.story, "README.md");
    const lien = existsSync(note) ? `[note](${relative(dirname(chemin), note).replaceAll("\\", "/")})` : "absente";
    const etat = terminee(e) ? `terminée le ${dateFin(e)}` : "en cours";
    return `| \`${e.story}\` | ${cellule(e.titre)} | ${etat} | ${e.rigueur === "complete" ? "complète" : "légère"} | ${e.regard_client ? "oui" : "non"} | ${lien} |`;
  });
  const n = etats.length;
  const texte = [
    "# Stories",
    "",
    "| Story | Titre | État | Rigueur | Regard client | Note |",
    "|---|---|---|---|---|---|",
    ...lignes,
    "",
    `_${n} ${n > 1 ? "stories" : "story"}. Page générée par \`harness/scripts/note-index.mjs\` : ne pas la modifier à la main._`,
    "",
  ].join("\n");
  return { chemin, texte };
}

function poser({ chemin, texte }, verifier, racine) {
  const nom = relative(racine, chemin);
  const actuel = existsSync(chemin) ? readFileSync(chemin, "utf8") : null;
  if (actuel === texte) {
    console.log(`inchangé : ${nom}`);
    return 0;
  }
  if (verifier) {
    console.log(`${actuel === null ? "absent" : "pas à jour"} : ${nom}`);
    return 1;
  }
  mkdirSync(dirname(chemin), { recursive: true });
  const tmp = `${chemin}.tmp-${process.pid}`;
  writeFileSync(tmp, texte);
  renameSync(tmp, chemin);
  console.log(`écrit : ${nom}`);
  return 0;
}

function principal(argv) {
  const verifier = argv.includes("--verifier");
  const args = argv.filter((a) => a !== "--verifier");
  const racine = trouverRacine();
  const config = chargerConfig(racine);
  if (args[0] === "index" && args.length === 1) return poser(indexAttendu(racine, config), verifier, racine);
  if (args[0] === "note" && args.length === 2) return poser(noteAttendue(racine, config, args[1]), verifier, racine);
  console.error("usage : note-index.mjs note <story-id> [--verifier] | index [--verifier]");
  return 2;
}

try {
  process.exit(principal(process.argv.slice(2)));
} catch (e) {
  if (e instanceof Refus || e instanceof ErreurConfig) {
    console.error(`REFUS : ${e.message}`);
    process.exit(1);
  }
  throw e;
}
