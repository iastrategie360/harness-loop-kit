#!/usr/bin/env node
// config.mjs : lecture de harness/projet.json, la source unique des VALEURS du projet.
//
// Tout script du harness passe par ici (ou par `cfg` dans commun.sh) pour lire une branche,
// un chemin, un seuil. Aucune de ces valeurs n'est écrite en dur ailleurs.
//
// Usage en ligne de commande :
//   node config.mjs valider                      exit 0 si la configuration est valide
//   node config.mjs lire <a.b.c> [--lignes]      affiche une valeur (un élément par ligne avec --lignes)
//   node config.mjs options                      affiche les options actives, une par ligne
//   node config.mjs prouver <nom> --exit <n> --duree <s> [--base-rouge]
//                                                enregistre la preuve d'une commande (nom, ou statique:<nom>)
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { valider, formater } from "./schema-mini.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
export const DOSSIER_SCHEMAS = join(ICI, "..", "..", "schemas");
// L'ORDRE compte : à un même point d'extension, une option qui produit des items (personas)
// passe avant celle qui les filtre (valeur), et celle qui ferme le chantier (creneaux) en dernier.
// `mistral` (1.1.0) n'a que des points à elle ; elle passe après le filtre de valeur, qui retire
// des findings avant toute escalade. `jev` (1.2.0) lit les findings APRÈS les relectures (elle
// partage le point `apres_review_pr` avec mistral : la relecture sécurité d'abord, la lecture
// des signalements ensuite).
export const NOMS_OPTIONS = ["personas", "valeur", "mistral", "jev", "note_story", "creneaux"];

export class ErreurConfig extends Error {}

// La racine est celle du CHECKOUT courant (un second arbre de travail a la sienne).
export function trouverRacine() {
  if (process.env.HARNESS_RACINE) return process.env.HARNESS_RACINE;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new ErreurConfig("pas dans un dépôt Git : le harness se lance depuis le dépôt du projet.");
  }
}

export function cheminConfig(racine = trouverRacine()) {
  return join(racine, "harness", "projet.json");
}

export function lireSchema(nom) {
  return JSON.parse(readFileSync(join(DOSSIER_SCHEMAS, nom), "utf8"));
}

export function chargerConfig(racine = trouverRacine()) {
  const chemin = cheminConfig(racine);
  if (!existsSync(chemin)) {
    throw new ErreurConfig(`configuration absente : ${chemin}. Lancer /harness-install.`);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(chemin, "utf8"));
  } catch (e) {
    throw new ErreurConfig(`configuration illisible (${chemin}) : ${e.message}`);
  }
  const erreurs = valider(lireSchema("projet.schema.json"), config);
  if (erreurs.length > 0) {
    throw new ErreurConfig(`configuration invalide (${chemin}) :\n${formater(erreurs)}`);
  }
  const croisees = controlesCroises(config);
  if (croisees.length > 0) {
    throw new ErreurConfig(`configuration invalide (${chemin}) :\n${formater(croisees)}`);
  }
  return config;
}

// Les contraintes qui lient deux valeurs, et que le schéma ne sait pas dire. Même forme que les
// erreurs du validateur, pour un seul message de refus.
export function controlesCroises(config) {
  const erreurs = [];
  // Option jev (1.2.0), clé absente d'une configuration 1.1.0 : rien à contrôler. Deux seuils
  // égaux ou inversés vident la bande douteuse, ou rendent la re-détection plus facile que le
  // simple signalement : refusé, jamais corrigé en silence.
  const jev = config.options?.jev;
  if (jev && typeof jev.seuil_bas === "number" && typeof jev.seuil_haut === "number" && !(jev.seuil_bas < jev.seuil_haut)) {
    erreurs.push({ chemin: "/options/jev/seuil_bas", message: `doit être strictement inférieur à seuil_haut (${jev.seuil_bas} >= ${jev.seuil_haut})` });
  }
  return erreurs;
}

// lire(config, "git.branche_integration") : undefined si le chemin n'existe pas.
export function lire(objet, chemin) {
  let noeud = objet;
  for (const cle of chemin.split(".").filter(Boolean)) {
    if (noeud === null || typeof noeud !== "object" || !Object.hasOwn(noeud, cle)) return undefined;
    noeud = noeud[cle];
  }
  return noeud;
}

export function optionsActives(config) {
  return NOMS_OPTIONS.filter((nom) => config.options[nom]?.actif === true);
}

// L'option `mistral` est arrivée en 1.1.0 : une configuration posée en 1.0.0 n'a pas sa clé, et
// reste valide (la clé n'est pas requise). Ces deux lectures rendent donc `false` sur une clé
// absente : sans elle, le noyau se comporte exactement comme en 1.0.0.
export function securiteExigee(config) {
  const m = config.options?.mistral;
  return m?.actif === true && m.securite_pr === true;
}
export function trancheActive(config) {
  const m = config.options?.mistral;
  return m?.actif === true && m.arbitre === true && m.tranche_finale === true;
}

// L'option `jev` est arrivée en 1.2.0 : même règle, une clé absente rend `false`.
export function jevActive(config) {
  return config.options?.jev?.actif === true;
}

// Date du jour et horodatage. HARNESS_DATE fige l'horloge pour les tests.
export function maintenant() {
  return process.env.HARNESS_DATE ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
export function aujourdhui() {
  return maintenant().slice(0, 10);
}

// Écriture atomique : fichier temporaire dans le même dossier, puis renommage.
export function ecrireJson(chemin, objet) {
  const tmp = `${chemin}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(objet, null, 2)}\n`);
  renameSync(tmp, chemin);
}

// cheminArtefactReview(config, racine, cible) : où vit l'artefact de review de PR, en chemin
// RELATIF à la racine du dépôt (c'est ainsi que Git le nomme). <cible> est un identifiant de
// story, un nom de branche, ou directement un chemin vers un fichier .json.
export function cheminArtefactReview(config, racine, cible) {
  if (cible.endsWith(".json")) return isAbsolute(cible) ? relative(racine, cible) : cible;
  const deStory = join(config.chemins.specs, cible, "review-pr.json");
  if (existsSync(join(racine, deStory))) return deStory;
  const deBranche = join(config.chemins.reviews, `${cible.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  if (existsSync(join(racine, deBranche))) return deBranche;
  return deStory;
}

// trouverCommande(config, "tests") ou (config, "statique:lint") : rend {conteneur, cle}.
function trouverCommande(config, nom) {
  if (nom.startsWith("statique:")) {
    const cherche = nom.slice("statique:".length);
    const i = config.commandes.statique.findIndex((c) => c.nom === cherche);
    if (i < 0) throw new ErreurConfig(`commande statique inconnue : « ${cherche} »`);
    return { conteneur: config.commandes.statique, cle: i };
  }
  if (nom === "statique" || !Object.hasOwn(config.commandes, nom)) {
    throw new ErreurConfig(`commande inconnue : « ${nom} »`);
  }
  return { conteneur: config.commandes, cle: nom };
}

export function lireCommande(config, nom) {
  const { conteneur, cle } = trouverCommande(config, nom);
  return conteneur[cle];
}

function afficher(valeur, enLignes) {
  if (valeur === undefined || valeur === null) return;
  if (enLignes && Array.isArray(valeur)) {
    for (const v of valeur) console.log(typeof v === "string" ? v : JSON.stringify(v));
  } else if (typeof valeur === "object") {
    console.log(JSON.stringify(valeur));
  } else {
    console.log(String(valeur));
  }
}

function principal(args) {
  const [commande, ...reste] = args;
  const racine = trouverRacine();
  switch (commande) {
    case "valider": {
      chargerConfig(racine);
      if (!reste.includes("--silencieux")) console.log(`OK : ${cheminConfig(racine)}`);
      return 0;
    }
    case "lire": {
      const chemin = reste.find((a) => !a.startsWith("--"));
      if (!chemin) throw new ErreurConfig("usage : config.mjs lire <a.b.c> [--lignes]");
      afficher(lire(chargerConfig(racine), chemin), reste.includes("--lignes"));
      return 0;
    }
    case "options": {
      for (const nom of optionsActives(chargerConfig(racine))) console.log(nom);
      return 0;
    }
    case "commande": {
      // Rend la commande au format « cmd » sur la sortie, ou rien si elle est absente (null).
      const c = lireCommande(chargerConfig(racine), reste[0] ?? "");
      if (c) console.log(JSON.stringify(c));
      return 0;
    }
    case "prouver": {
      const nom = reste[0];
      const iExit = reste.indexOf("--exit");
      const iDuree = reste.indexOf("--duree");
      if (!nom || iExit < 0 || iDuree < 0) {
        throw new ErreurConfig("usage : config.mjs prouver <nom> --exit <n> --duree <s> [--base-rouge]");
      }
      const exit = Number(reste[iExit + 1]);
      const duree = Number(reste[iDuree + 1]);
      if (!Number.isInteger(exit) || !Number.isFinite(duree) || duree < 0) {
        throw new ErreurConfig("--exit attend un entier et --duree un nombre positif");
      }
      const config = chargerConfig(racine);
      const { conteneur, cle } = trouverCommande(config, nom);
      if (!conteneur[cle]) throw new ErreurConfig(`la commande « ${nom} » est déclarée absente (null) : rien à prouver`);
      conteneur[cle] = {
        ...conteneur[cle],
        prouvee_le: aujourdhui(),
        exit,
        duree_s: duree,
        base_rouge: reste.includes("--base-rouge") ? true : exit !== 0 ? conteneur[cle].base_rouge : false,
      };
      const erreurs = valider(lireSchema("projet.schema.json"), config);
      erreurs.push(...(erreurs.length === 0 ? controlesCroises(config) : []));
      if (erreurs.length > 0) throw new ErreurConfig(`écriture refusée :\n${formater(erreurs)}`);
      ecrireJson(cheminConfig(racine), config);
      console.log(`preuve enregistrée : ${nom} (exit ${exit}, ${duree} s)`);
      return 0;
    }
    default:
      throw new ErreurConfig("usage : config.mjs valider | lire <a.b.c> [--lignes] | options | commande <nom> | prouver <nom> --exit <n> --duree <s>");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(principal(process.argv.slice(2)));
  } catch (e) {
    console.error(`ERREUR : ${e.message}`);
    process.exit(e instanceof ErreurConfig ? 1 : 2);
  }
}
