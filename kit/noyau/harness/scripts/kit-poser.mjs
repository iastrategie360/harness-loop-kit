#!/usr/bin/env node
// kit-poser.mjs : pose les fichiers du kit dans le projet, et sait les mettre à jour.
//
// POURQUOI un script : copier soixante fichiers à la main, c'est en oublier un, ou écraser
// celui que le projet avait retouché. Ici chaque fichier posé laisse son empreinte dans
// harness/kit-installe.json, et c'est elle qui dit, à la mise à jour suivante, si le fichier
// a été modifié sur place.
//
// Source : harness/.kit/ (déposé par poser.sh), soit VERSION, noyau/ et options/<nom>/.
// Sont posés : tout le noyau, et l'arbre de chaque option ACTIVE dans harness/projet.json.
//
// Usage :
//   node kit-poser.mjs plan [--json]   ce qui serait fait, sans rien écrire
//   node kit-poser.mjs appliquer       le fait, puis écrit harness/kit-installe.json
//
// Pour chaque fichier du kit :
//   absent du projet                        -> posé
//   identique                               -> rien
//   différent, intact depuis la dernière pose -> remplacé
//   différent, modifié sur place (ou d'origine inconnue)
//                                           -> JAMAIS écrasé : la version du kit est posée à
//                                              côté, en <fichier>.nouveau
// Un fichier posé autrefois et absent du kit actuel (option coupée, fichier retiré) est
// signalé et laissé en place. Rien n'est jamais supprimé, sauf un <fichier>.nouveau devenu
// identique au fichier qu'il accompagne.
//
// Ne sont JAMAIS dans la liste : harness/projet.json, harness/PROJET.md, les états, les specs,
// les reviews. Le script refuse un kit qui les contiendrait.
//
// Codes : 0 fait (ou rien à faire) ; 1 refus ; 2 usage.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, chmodSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chargerConfig, trouverRacine, optionsActives, maintenant, ecrireJson, ErreurConfig } from "./lib/config.mjs";

const REGISTRE = join("harness", "kit-installe.json");
// Lignes que le harness ajoute à .gitignore : ses fichiers de travail, et le kit déposé.
const IGNORES = ["harness/.travail/", "harness/.kit/"];

function empreinte(contenu) {
  return createHash("sha256").update(contenu).digest("hex");
}

function lister(dossier, prefixe = "") {
  const fichiers = [];
  for (const nom of readdirSync(dossier).sort()) {
    const chemin = join(dossier, nom);
    const relatif = prefixe ? `${prefixe}/${nom}` : nom;
    if (statSync(chemin).isDirectory()) fichiers.push(...lister(chemin, relatif));
    else fichiers.push(relatif);
  }
  return fichiers;
}

// Ce qui appartient au projet et qu'aucune version du kit ne doit jamais porter.
function appartientAuProjet(relatif, config) {
  if (relatif === "harness/projet.json" || relatif === "harness/PROJET.md" || relatif === REGISTRE) return true;
  return [config.chemins.specs, config.chemins.etat, config.chemins.reviews].some((d) => relatif === d || relatif.startsWith(`${d}/`));
}

function dossierKit(racine) {
  return process.env.HARNESS_KIT ?? join(racine, "harness", ".kit");
}

// La liste des fichiers à poser : {relatif, source}. Une option qui porterait le même chemin
// que le noyau ou qu'une autre option est une erreur de kit, pas un cas à arbitrer ici.
function fichiersDuKit(racine, config) {
  const kit = dossierKit(racine);
  if (!existsSync(join(kit, "noyau")) || !existsSync(join(kit, "VERSION"))) {
    throw new ErreurConfig(`kit introuvable dans ${kit} (attendu : VERSION, noyau/, options/). Le déposer avec poser.sh.`);
  }
  const version = readFileSync(join(kit, "VERSION"), "utf8").trim();
  const sources = [["noyau", join(kit, "noyau")]];
  for (const nom of optionsActives(config)) {
    const dossier = join(kit, "options", nom);
    if (!existsSync(dossier)) throw new ErreurConfig(`l'option « ${nom} » est active mais absente du kit (${dossier})`);
    sources.push([`option ${nom}`, dossier]);
  }
  const fichiers = new Map();
  for (const [origine, dossier] of sources) {
    for (const relatif of lister(dossier)) {
      if (appartientAuProjet(relatif, config)) throw new ErreurConfig(`le kit (${origine}) porte « ${relatif} », qui appartient au projet : kit refusé`);
      if (fichiers.has(relatif)) throw new ErreurConfig(`« ${relatif} » est porté deux fois (${fichiers.get(relatif).origine} et ${origine}) : kit refusé`);
      fichiers.set(relatif, { relatif, origine, source: join(dossier, relatif) });
    }
  }
  return { version, fichiers: [...fichiers.values()] };
}

function lireRegistre(racine) {
  const chemin = join(racine, REGISTRE);
  if (!existsSync(chemin)) return null;
  try {
    const r = JSON.parse(readFileSync(chemin, "utf8"));
    if (typeof r.version !== "string" || typeof r.fichiers !== "object" || r.fichiers === null) throw new Error("forme inattendue");
    return r;
  } catch (e) {
    throw new ErreurConfig(`${REGISTRE} illisible (${e.message}). Sans lui, tout fichier différent du kit est traité comme modifié sur place.`);
  }
}

// planifier : décide du sort de chaque fichier, sans rien écrire.
export function planifier(racine, config) {
  const { version, fichiers } = fichiersDuKit(racine, config);
  const registre = lireRegistre(racine);
  const connus = registre?.fichiers ?? {};
  const gestes = [];
  for (const f of fichiers) {
    const cible = join(racine, f.relatif);
    const duKit = readFileSync(f.source);
    const sommeKit = empreinte(duKit);
    if (!existsSync(cible)) {
      gestes.push({ ...f, geste: "poser", somme: sommeKit });
      continue;
    }
    const somme = empreinte(readFileSync(cible));
    if (somme === sommeKit) gestes.push({ ...f, geste: "a_jour", somme: sommeKit });
    else if (connus[f.relatif] === somme) gestes.push({ ...f, geste: "remplacer", somme: sommeKit });
    else gestes.push({ ...f, geste: "a_cote", somme: sommeKit });
  }
  const duKit = new Set(fichiers.map((f) => f.relatif));
  const orphelins = Object.keys(connus).filter((r) => !duKit.has(r) && existsSync(join(racine, r))).sort();
  const ignoresManquants = lignesIgnoreManquantes(racine);
  const aFaire = gestes.some((g) => g.geste !== "a_jour") || ignoresManquants.length > 0;
  let mode = "installation";
  if (registre) mode = registre.version !== version ? "mise_a_jour" : aFaire ? "reparation" : "a_jour";
  return { mode, version, version_installee: registre?.version ?? null, options: optionsActives(config), gestes, orphelins, ignores_manquants: ignoresManquants };
}

function lignesIgnoreManquantes(racine) {
  const chemin = join(racine, ".gitignore");
  const lignes = existsSync(chemin) ? readFileSync(chemin, "utf8").split("\n").map((l) => l.trim()) : [];
  return IGNORES.filter((l) => !lignes.includes(l) && !lignes.includes(`/${l}`));
}

function copier(source, cible) {
  mkdirSync(dirname(cible), { recursive: true });
  writeFileSync(cible, readFileSync(source));
  chmodSync(cible, statSync(source).mode & 0o777);
}

export function appliquer(racine, config) {
  const plan = planifier(racine, config);
  const anciens = lireRegistre(racine)?.fichiers ?? {};
  const fichiers = {};
  for (const g of plan.gestes) {
    const cible = join(racine, g.relatif);
    const voisin = `${cible}.nouveau`;
    if (g.geste === "a_cote") {
      copier(g.source, voisin);
      // L'ancienne empreinte reste : le fichier continuera d'être vu comme modifié sur place.
      if (anciens[g.relatif]) fichiers[g.relatif] = anciens[g.relatif];
      continue;
    }
    if (g.geste !== "a_jour") copier(g.source, cible);
    fichiers[g.relatif] = g.somme;
    if (existsSync(voisin) && empreinte(readFileSync(voisin)) === g.somme) unlinkSync(voisin);
  }
  // Un orphelin garde son empreinte : on saura encore, plus tard, qu'il venait du kit.
  for (const r of plan.orphelins) fichiers[r] = anciens[r];
  if (plan.ignores_manquants.length > 0) {
    const chemin = join(racine, ".gitignore");
    const avant = existsSync(chemin) ? readFileSync(chemin, "utf8") : "";
    const jonction = avant === "" || avant.endsWith("\n") ? "" : "\n";
    writeFileSync(chemin, `${avant}${jonction}# harness : fichiers de travail locaux et kit déposé\n${plan.ignores_manquants.join("\n")}\n`);
  }
  const triees = Object.fromEntries(Object.keys(fichiers).sort().map((r) => [r, fichiers[r]]));
  const registre = { version: plan.version, options: plan.options, fichiers: triees };
  // La date ne bouge que si quelque chose a bougé : relancer sans effet ne produit aucun diff.
  const precedent = lireRegistre(racine);
  const inchange = precedent && JSON.stringify({ version: precedent.version, options: precedent.options, fichiers: precedent.fichiers }) === JSON.stringify(registre);
  if (!inchange) ecrireJson(join(racine, REGISTRE), { version: registre.version, pose_le: maintenant(), options: registre.options, fichiers: registre.fichiers });
  return plan;
}

const LIBELLES = {
  poser: ["POSER    ", "POSÉ     "],
  remplacer: ["REMPLACER", "REMPLACÉ "],
  a_cote: ["À CÔTÉ   ", "À CÔTÉ   "],
};
const MODES = { installation: "installation", mise_a_jour: "mise à jour", reparation: "réparation", a_jour: "à jour" };

function afficher(plan, fait) {
  const i = fait ? 1 : 0;
  const suite = plan.version_installee && plan.version_installee !== plan.version ? ` (installé : ${plan.version_installee})` : "";
  console.log(`kit ${plan.version}${suite}, mode : ${MODES[plan.mode]}, options : ${plan.options.join(", ") || "aucune"}`);
  for (const g of plan.gestes) {
    if (g.geste === "a_jour") continue;
    const detail = g.geste === "a_cote" ? ` (modifié sur place : version du kit dans ${g.relatif}.nouveau)` : "";
    console.log(`  ${LIBELLES[g.geste][i]}  ${g.relatif}${detail}`);
  }
  for (const r of plan.orphelins) console.log(`  ORPHELIN   ${r} (plus dans le kit ou option coupée : laissé en place)`);
  for (const l of plan.ignores_manquants) console.log(`  .gitignore ${fait ? "reçoit" : "recevra"} « ${l} »`);
  const n = (geste) => plan.gestes.filter((g) => g.geste === geste).length;
  console.log(`${fait ? "fait" : "plan"} : ${n("poser")} posé(s), ${n("remplacer")} remplacé(s), ${n("a_cote")} à côté, ${n("a_jour")} déjà à jour, ${plan.orphelins.length} orphelin(s)`);
}

function principal(args) {
  const [commande, ...reste] = args;
  if (commande !== "plan" && commande !== "appliquer") {
    console.error("usage : kit-poser.mjs plan [--json] | appliquer");
    return 2;
  }
  const racine = trouverRacine();
  const config = chargerConfig(racine);
  if (commande === "plan") {
    const plan = planifier(racine, config);
    if (reste.includes("--json")) console.log(JSON.stringify({ ...plan, gestes: plan.gestes.map(({ relatif, origine, geste }) => ({ relatif, origine, geste })) }, null, 2));
    else afficher(plan, false);
    return 0;
  }
  afficher(appliquer(racine, config), true);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(principal(process.argv.slice(2)));
  } catch (e) {
    if (!(e instanceof ErreurConfig)) throw e;
    console.error(`REFUS : ${e.message}`);
    process.exit(1);
  }
}
