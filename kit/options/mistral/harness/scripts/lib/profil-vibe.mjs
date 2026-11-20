#!/usr/bin/env node
// profil-vibe.mjs : contrôle le profil d'agent Vibe des relecteurs AVANT tout appel.
//
// POURQUOI : la lecture seule des relecteurs de l'option mistral tient d'abord à la construction
// de leur session (seuls read_file et grep existent). Un profil retouché qui ouvrirait un shell,
// un outil d'écriture, ou une liste d'interdits plus courte pour grep que pour read_file,
// enverrait au fournisseur ce qui ne doit pas sortir, ou laisserait écrire. Le contrôle est
// FERMÉ : tout ce qui n'est pas reconnu comme sûr est refusé.
//
// Ce n'est pas un analyseur TOML complet : il lit la forme que le kit livre (tableaux sur une ou
// plusieurs lignes, sections [tools.<nom>]). Une forme qu'il ne sait pas lire est un refus.
//
// Usage : node profil-vibe.mjs <profil.toml>
//         node profil-vibe.mjs --effectif <profil livré> <racine> <sortie.toml> [motif]...
//   --effectif : écrit le profil EFFECTIF d'une session (le profil livré, plus chaque motif de
//   relecteur.chemins_exclus ajouté aux DEUX denylists et aux exclusions du parcours de grep),
//   puis le contrôle comme le livré, en exigeant en plus chaque exclusion. Rien n'est écrit si
//   le contrôle échoue.
// Codes : 0 profil conforme ; 1 refus (chaque motif sur sa ligne) ; 2 usage.
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OUTILS_PERMIS = ["read_file", "grep"];
// Le minimum que chaque liste d'interdits doit porter : les fichiers de secrets les plus courants.
export const INTERDITS_MINIMAUX = ["*/.env", "*/.env.*", "*.pem", "*.key", "*/id_rsa*", "*/.git/*"];

// Les lignes sans commentaire (un « # » hors d'une chaîne ouvre un commentaire).
function sansCommentaires(texte) {
  return texte.split("\n").map((ligne) => {
    let dansChaine = false;
    for (let i = 0; i < ligne.length; i += 1) {
      if (ligne[i] === '"') dansChaine = !dansChaine;
      if (ligne[i] === "#" && !dansChaine) return ligne.slice(0, i);
    }
    return ligne;
  });
}

// Découpe le profil en sections : "" pour la racine, "tools.grep" pour [tools.grep]. Chaque
// section porte ses clés, les valeurs restant du texte brut (tableaux recollés en une ligne).
export function lireProfil(texte) {
  const sections = new Map([["", new Map()]]);
  let courante = "";
  let cle = null;
  let tampon = "";
  for (const ligne of sansCommentaires(String(texte))) {
    const t = ligne.trim();
    if (cle !== null) {
      tampon += t;
      if (t.endsWith("]")) {
        sections.get(courante).set(cle, tampon);
        cle = null;
        tampon = "";
      }
      continue;
    }
    if (t === "") continue;
    const section = /^\[([A-Za-z0-9_.-]+)\]$/.exec(t);
    if (section) {
      courante = section[1];
      if (!sections.has(courante)) sections.set(courante, new Map());
      continue;
    }
    const affectation = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(t);
    if (!affectation) throw new Error(`ligne illisible : « ${t} »`);
    const [, nom, valeur] = affectation;
    if (valeur.startsWith("[") && !valeur.endsWith("]")) {
      cle = nom;
      tampon = valeur;
      continue;
    }
    sections.get(courante).set(nom, valeur);
  }
  if (cle !== null) throw new Error(`tableau non fermé : « ${cle} »`);
  return sections;
}

// Un tableau de chaînes, ou null s'il ne se lit pas comme tel.
function tableau(valeur) {
  if (typeof valeur !== "string") return null;
  try {
    const v = JSON.parse(valeur.replace(/,\s*\]$/, "]"));
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

// Les seules clés de premier niveau qu'un profil du harness peut porter : un contrôle FERMÉ, une
// clé inconnue (un chemin de compétences, un prompt personnel) est un refus.
export const CLES_RACINE = [
  "display_name", "description", "safety", "enabled_tools", "include_project_context", "include_prompt_detail",
  "system_prompt_id", "include_commit_signature", "enable_update_checks", "enable_auto_update",
];
// Ce qui doit être coupé pour que rien n'entre d'office dans le prompt système (vibe 2.13,
// core/system_prompt.py) : contexte du dépôt et AGENTS.md (utilisateur et projet), détail du système,
// compétences et sous-agents, prompt système personnel.
export const CONTEXTE_COUPE = { include_project_context: "false", include_prompt_detail: "false", system_prompt_id: '"cli"' };

function refusRacine(racine) {
  const refus = [];
  for (const cle of racine.keys()) if (!CLES_RACINE.includes(cle)) refus.push(`clé « ${cle} » non permise dans le profil`);
  for (const [cle, attendu] of Object.entries(CONTEXTE_COUPE)) {
    if ((racine.get(cle) ?? "").trim() !== attendu) refus.push(`${cle} doit valoir ${attendu} : sinon vibe ajoute d'office du contexte au prompt (lu : ${racine.get(cle) ?? "absent"})`);
  }
  return refus;
}

/**
 * Le profil SANS OUTIL (tranche finale, appel du préflight) : « re:^$ » seul (une liste vide
 * voudrait dire « tous les outils »), aucune section d'outil, et le contexte coupé.
 */
export function controlerProfilSansOutils(texte) {
  let sections;
  try {
    sections = lireProfil(texte);
  } catch (e) {
    return [`profil illisible : ${e.message}`];
  }
  const racine = sections.get("");
  const refus = refusRacine(racine);
  const outils = tableau(racine.get("enabled_tools"));
  if (!outils || outils.length !== 1 || outils[0] !== "re:^$") refus.push(`enabled_tools doit valoir exactement ["re:^$"] (lu : ${racine.get("enabled_tools") ?? "rien"})`);
  for (const nom of sections.keys()) if (nom !== "") refus.push(`section [${nom}] : ce profil n'a aucun outil`);
  return refus;
}

/** Les motifs de refus du profil, un par entrée ; liste vide si le profil est conforme. */
export function controlerProfil(texte) {
  let sections;
  try {
    sections = lireProfil(texte);
  } catch (e) {
    return [`profil illisible : ${e.message}`];
  }
  const racine = sections.get("");
  const refus = refusRacine(racine);
  const outils = tableau(racine.get("enabled_tools"));
  if (!outils || outils.length !== OUTILS_PERMIS.length || outils.some((o, i) => o !== OUTILS_PERMIS[i])) {
    refus.push(`enabled_tools doit valoir exactement ${JSON.stringify(OUTILS_PERMIS)} (lu : ${racine.get("enabled_tools") ?? "rien"})`);
  }
  for (const [nom, cles] of sections) {
    for (const [cle, valeur] of cles) {
      if (/bypass/i.test(cle) && valeur.trim() !== "false") refus.push(`${nom || "racine"} : ${cle} contourne les permissions d'outil`);
    }
  }
  if (racine.has("active_model") || racine.has("models")) {
    refus.push("le profil choisit un modèle : le modèle se choisit à l'invocation, d'après la configuration du harness");
  }
  for (const nom of sections.keys()) {
    if (nom.startsWith("tools.") && !OUTILS_PERMIS.includes(nom.slice("tools.".length))) {
      refus.push(`section [${nom}] : seuls read_file et grep ont leur place dans ce profil`);
    } else if (nom !== "" && !nom.startsWith("tools.")) {
      refus.push(`section [${nom}] inattendue`);
    }
  }
  const listes = {};
  for (const outil of OUTILS_PERMIS) {
    const s = sections.get(`tools.${outil}`);
    const liste = s ? tableau(s.get("denylist")) : null;
    if (!liste || liste.length === 0) {
      refus.push(`[tools.${outil}] : denylist absente ou illisible`);
      continue;
    }
    listes[outil] = liste;
    const manquants = INTERDITS_MINIMAUX.filter((m) => !liste.includes(m));
    if (manquants.length > 0) refus.push(`[tools.${outil}] : la denylist ne porte pas ${manquants.join(", ")}`);
  }
  if (listes.read_file && listes.grep && JSON.stringify(listes.read_file) !== JSON.stringify(listes.grep)) {
    refus.push("les denylists de read_file et de grep diffèrent : elles doivent être identiques, sinon grep lit un secret nommé explicitement");
  }
  if (!tableau(sections.get("tools.grep")?.get("exclude_patterns"))) refus.push("[tools.grep] : exclude_patterns absent ou illisible");
  return refus;
}

/**
 * Les entrées de denylist qui traduisent UN motif de relecteur.chemins_exclus pour vibe 2.13.
 *
 * Format réel, lu dans le code de vibe 2.13 (core/tools/utils.py, resolve_path_permission) : le
 * chemin demandé est rendu ABSOLU et RÉSOLU (liens suivis), puis comparé à chaque motif par
 * fnmatch, où « * » traverse les « / ». C'est la même règle que les jokers du shell qu'utilise le
 * harness (chemin_couvert_par) : on ancre donc chaque motif à la racine résolue du checkout, avec
 * les mêmes extensions (un dossier couvre son contenu ; « **\/x » couvre aussi x à la racine ; un
 * motif terminé par « /** » ou « / » couvre aussi le dossier lui-même, que grep peut viser).
 */
export function entreesDenylist(motif, racine) {
  const echapper = (t) => t.replace(/[[*?]/g, (c) => `[${c}]`);
  const r = echapper(racine.replace(/\/+$/, ""));
  const variantes = [motif];
  if (motif.startsWith("**/")) variantes.push(motif.slice(3));
  const entrees = [];
  for (const v of variantes) {
    const coeur = v.replace(/\/\*\*$/, "").replace(/\/+$/, "");
    for (const e of [v, `${v.replace(/\/+$/, "")}/*`, coeur, `${coeur}/*`]) {
      if (e !== "" && e !== "/*") entrees.push(`${r}/${e}`);
    }
  }
  return [...new Set(entrees)];
}

/**
 * LA LISTE EFFECTIVE DES CHEMINS INTERDITS, calculée ici et nulle part ailleurs : les secrets du
 * profil livré (sa denylist de read_file) ∪ chaque motif de relecteur.chemins_exclus, traduit en
 * motif absolu ancré à la racine (entreesDenylist). Tout en dérive :
 *   - les denylists des DEUX outils du profil effectif (cette liste, telle quelle) ;
 *   - les exclusions du parcours de grep (equivalentsGrep de chaque entrée) ;
 *   - le contrôle de ce que le harness met lui-même dans un prompt (interditsParmi : diff,
 *     contenu complet, chemins d'un finding), et la détection des copies et déplacements.
 * Deux listes traitées par deux chemins finissaient par diverger : un secret couvert par les
 * outils mais pas par la détection des copies, un exclu couvert par la denylist mais pas par grep.
 */
/**
 * Un motif de relecteur.chemins_exclus est-il PERMIS ? Rend null s'il l'est, sinon le motif de
 * refus. Le même motif est lu par fnmatch (les denylists de vibe : « * » traverse « / ») et par
 * ripgrep (le parcours de grep : « * » ne traverse pas « / »). Un joker MÊLÉ à du texte dans un
 * segment (« private*.json », « docs/*.md ») n'a pas le même sens pour les deux : on ne traduit
 * pas, on refuse. Sont permis : les segments littéraux, un segment « * » entier en DERNIER, un
 * segment « ** » en PREMIER ou en DERNIER, et « *.ext » seul (sans dossier : les deux outils le lisent alors « ce nom de fichier, à toute
 * profondeur », ce que harness/tests/mistral.test.mjs vérifie contre le vrai ripgrep).
 */
export function refusMotif(motif) {
  const segments = String(motif).replace(/\/+$/, "").split("/");
  const comment = "réécris-le en segments entiers (« private/** », « **/fixtures/** ») ou en extension seule (« *.json »)";
  if (segments.length === 0 || segments.some((g) => g === "")) return `motif « ${motif} » illisible (segment vide) : ${comment}`;
  const dernier = segments.length - 1;
  for (const [i, g] of segments.entries()) {
    if (!/[*?[\]]/.test(g)) continue;
    // « * » et « ** » ne coïncident qu'aux bords : au milieu, ripgrep accepte zéro dossier là où
    // fnmatch en exige un (« a/** /b » couvre « a/b » pour l'un, pas pour l'autre).
    if (g === "*" && i === dernier && i > 0) continue;
    if (g === "**" && (i === 0 || i === dernier) && segments.length > 1) continue;
    if (segments.length === 1 && i === 0 && /^\*\.[^*?[\]/]+$/.test(g)) continue;
    return `motif « ${motif} » : le segment « ${g} » mêle un joker à du texte, ou le place au milieu, et n'a pas le même sens pour la denylist de vibe et pour ripgrep ; ${comment}`;
  }
  return null;
}

export function listeInterdite(texteProfil, racine, motifs = []) {
  const refus = motifs.map(refusMotif).filter(Boolean);
  if (refus.length > 0) throw new Error(`relecteur.chemins_exclus : ${refus.join(" ; ")}`);
  const secrets = tableau(lireProfil(texteProfil).get("tools.read_file")?.get("denylist"));
  if (!secrets || secrets.length === 0) throw new Error("denylist de read_file absente du profil livré");
  return [...new Set([...secrets, ...motifs.flatMap((m) => entreesDenylist(m, racine))])];
}

/**
 * Les exclusions du PARCOURS de grep qui équivalent à UNE entrée de la liste interdite. vibe les
 * passe à ripgrep (`--glob !motif`, syntaxe gitignore : « * » ne traverse pas « / », « ** » si).
 * ripgrep est EXIGÉ (mistral_preparer) : sans lui, vibe retombe sur GNU grep, dont `--exclude` ne
 * porte que sur le nom de base, et `private/data.json` ne serait plus exclu. Le dossier que le
 * modèle cherche n'est pas connu d'avance : chaque entrée donne sa forme relative ET sa forme
 * « n'importe où ». Une exclusion trop large cache un peu plus au relecteur, jamais elle ne lui
 * montre un interdit.
 */
export function equivalentsGrep(entree, racine) {
  const r = `${echapperFnmatch(racine.replace(/\/+$/, ""))}/`;
  let rel;
  if (entree.startsWith(r)) rel = entree.slice(r.length);
  else if (entree.startsWith("*/")) rel = entree.slice(2);
  else rel = entree;
  // Un segment « * » de fnmatch traverse les dossiers : en syntaxe gitignore, c'est « ** ».
  rel = rel.split("/").map((seg) => (seg === "*" ? "**" : seg)).join("/");
  return [...new Set([rel, rel.startsWith("**/") ? rel : `**/${rel}`])].filter((e) => e !== "" && e !== "**/");
}

function echapperFnmatch(t) {
  return t.replace(/[[*?]/g, (c) => `[${c}]`);
}

// Remplace le contenu d'un tableau multiligne `<cle> = [` ... `]` d'une section.
function remplacerTableau(texte, section, cle, entrees, entete) {
  const debut = texte.indexOf(`[${section}]`);
  if (debut < 0) throw new Error(`section [${section}] absente`);
  const ouverture = texte.indexOf(`${cle} = [\n`, debut);
  const suivante = texte.indexOf("\n[", debut + 1);
  if (ouverture < 0 || (suivante >= 0 && ouverture > suivante)) throw new Error(`[${section}] ${cle} absent`);
  const fermeture = texte.indexOf("\n]", ouverture);
  if (fermeture < 0) throw new Error(`[${section}] ${cle} non fermé`);
  const lignes = entrees.map((e) => `  ${JSON.stringify(e)},`).join("\n");
  return `${texte.slice(0, ouverture)}${cle} = [\n  # ${entete}\n${lignes}${texte.slice(fermeture)}`;
}

/**
 * Le profil effectif d'une session : le livré, dont les deux denylists deviennent la liste
 * interdite, et les exclusions de grep celles du livré (performance : dépendances, sorties de
 * build) plus les équivalents de chaque entrée interdite.
 */
export function profilEffectif(texte, racine, motifs) {
  const interdits = listeInterdite(texte, racine, motifs);
  const propres = tableau(lireProfil(texte).get("tools.grep")?.get("exclude_patterns")) ?? [];
  const parcours = [...new Set([...propres, ...interdits.flatMap((e) => equivalentsGrep(e, racine))])];
  const entete = "GÉNÉRÉ par lib/profil-vibe.mjs : la liste interdite (secrets du profil livré et chemins exclus du projet).";
  let t = remplacerTableau(texte, "tools.read_file", "denylist", interdits, entete);
  t = remplacerTableau(t, "tools.grep", "denylist", interdits, entete);
  return remplacerTableau(t, "tools.grep", "exclude_patterns", parcours, `${entete} Plus les exclusions de performance du profil livré.`);
}

/**
 * Le contrôle du profil effectif : celui du livré, plus deux invariants. Chaque entrée de la liste
 * interdite est dans les DEUX denylists, et chacun de ses équivalents est dans le parcours de grep.
 */
export function controlerProfilEffectif(texte, racine, motifs, texteLivre = null) {
  const refus = controlerProfil(texte);
  let sections;
  try {
    sections = lireProfil(texte);
  } catch {
    return refus;
  }
  let interdits;
  try {
    interdits = listeInterdite(texteLivre ?? texte, racine, motifs);
  } catch (e) {
    return [...refus, e.message];
  }
  const listes = ["tools.read_file", "tools.grep"].map((s) => tableau(sections.get(s)?.get("denylist")) ?? []);
  const exclusions = tableau(sections.get("tools.grep")?.get("exclude_patterns")) ?? [];
  for (const e of interdits) {
    if (!listes.every((l) => l.includes(e))) refus.push(`l'entrée interdite « ${e} » manque à une denylist`);
    for (const g of equivalentsGrep(e, racine)) {
      if (!exclusions.includes(g)) refus.push(`l'entrée interdite « ${e} » n'a pas son équivalent « ${g} » dans le parcours de grep`);
    }
  }
  return refus;
}

/**
 * fnmatch de Python (celui que vibe applique à sa denylist) : « * » vaut n'importe quelle suite,
 * « / » compris ; « ? » un caractère ; « [..] » et « [!..] » un ensemble. Sensible à la casse.
 */
export function fnmatchVersRegex(motif) {
  let re = "";
  for (let i = 0; i < motif.length; i += 1) {
    const c = motif[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const fin = motif.indexOf("]", i + 2);
      if (fin < 0) {
        re += "\\[";
      } else {
        let ens = motif.slice(i + 1, fin);
        if (ens.startsWith("!")) ens = `^${ens.slice(1)}`;
        re += `[${ens.replace(/\\/g, "\\\\")}]`;
        i = fin;
      }
    } else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/**
 * Parmi des chemins relatifs à la racine, ceux qui tombent sous la LISTE INTERDITE, sur le chemin
 * absolu lexical OU sur la cible résolue (liens suivis) : la même comparaison que vibe fait pour
 * ses outils, appliquée à ce que le harness met lui-même dans un prompt.
 */
export function interditsParmi(texteProfil, racine, motifs, chemins) {
  const reel = (() => {
    try {
      return realpathSync(racine);
    } catch {
      return resolve(racine);
    }
  })();
  const regles = listeInterdite(texteProfil, reel, motifs).map(fnmatchVersRegex);
  const touche = (abs) => regles.some((m) => m.test(abs));
  return chemins.filter((c) => {
    const lexical = resolve(reel, c);
    let resolu = lexical;
    try {
      resolu = realpathSync(lexical);
    } catch {
      // Fichier absent (supprimé par la branche) : la forme lexicale suffit.
    }
    return touche(lexical) || touche(resolu);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--interdits") {
  // node profil-vibe.mjs --interdits <profil livré> <racine> [motif]... : chemins relatifs sur
  // l'entrée, BRUTS et séparés par un octet NUL (git -z) ; rend ceux qui tombent sous la liste
  // interdite, séparés de même. Jamais de nom cité par Git (core.quotePath). Code 0 aussi quand
  // il n'y en a aucun ; 1 si le profil ne se lit pas (l'appelant refuse).
  const [, , , livre, racine, ...motifs] = process.argv;
  try {
    const chemins = readFileSync(0, "utf8").split("\0").filter(Boolean);
    for (const c of interditsParmi(readFileSync(livre, "utf8"), racine, motifs, chemins)) process.stdout.write(`${c}\0`);
    process.exit(0);
  } catch (e) {
    console.error(`  contrôle des chemins interdits impossible : ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--sans-outils") {
  // node profil-vibe.mjs --sans-outils <profil> : contrôle le profil sans outil.
  let refus;
  try {
    refus = controlerProfilSansOutils(readFileSync(process.argv[3], "utf8"));
  } catch (e) {
    refus = [`profil introuvable : ${e.message}`];
  }
  for (const r of refus) console.error(`  ${r}`);
  process.exit(refus.length === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--effectif") {
  const [, , , livre, racine, sortie, ...motifs] = process.argv;
  if (!livre || !racine || !sortie) {
    console.error("usage : node profil-vibe.mjs --effectif <profil livré> <racine> <sortie.toml> [motif]...");
    process.exit(2);
  }
  let texte;
  try {
    texte = profilEffectif(readFileSync(livre, "utf8"), racine, motifs);
  } catch (e) {
    console.error(`  profil effectif impossible à construire : ${e.message}`);
    process.exit(1);
  }
  const refus = controlerProfilEffectif(texte, racine, motifs, readFileSync(livre, "utf8"));
  for (const r of refus) console.error(`  ${r}`);
  if (refus.length > 0) process.exit(1);
  mkdirSync(dirname(sortie), { recursive: true });
  writeFileSync(`${sortie}.tmp`, texte);
  renameSync(`${sortie}.tmp`, sortie);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chemin = process.argv[2];
  if (!chemin) {
    console.error("usage : node profil-vibe.mjs <profil.toml>");
    process.exit(2);
  }
  let texte;
  try {
    texte = readFileSync(chemin, "utf8");
  } catch (e) {
    console.error(`profil introuvable : ${chemin} (${e.message})`);
    process.exit(1);
  }
  const refus = controlerProfil(texte);
  for (const r of refus) console.error(`  ${r}`);
  process.exit(refus.length === 0 ? 0 : 1);
}
