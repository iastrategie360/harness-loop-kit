#!/usr/bin/env node
// etat.mjs : le SEUL écrivain de l'état d'une story.
//
// POURQUOI : un état édité à la main dérive. Une clé inventée ici, un compteur oublié là, et
// la boucle reprend au mauvais endroit ou ne s'arrête plus. Toute écriture passe donc par ce
// script : il applique une transition nommée, valide le résultat contre le schéma, puis
// remplace le fichier d'un seul geste (fichier temporaire, renommage).
//
// Les transitions sont MÉCANIQUES : le superviseur décide quoi faire, ce script fait
// l'arithmétique (compteurs, seuils, stage précédent) et refuse ce qui est incohérent.
//
// Codes de sortie : 0 fait ; 1 refus ou état invalide ; 2 usage ;
//                   10 `tour` : condition d'arrêt, rien n'a bougé ;
//                   11 `tour` : plafond de tours atteint, story arrêtée ;
//                   12 `echec` : trop d'échecs consécutifs, story arrêtée.
//
// Usage : node harness/scripts/etat.mjs <sous-commande> ... (voir `aide`)
import { readFileSync, existsSync, mkdirSync, rmdirSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { valider, formater } from "./lib/schema-mini.mjs";
import {
  trouverRacine, chargerConfig, lireSchema, lire, maintenant, ecrireJson, trancheActive, ErreurConfig,
} from "./lib/config.mjs";

export const ORDRE = ["INIT", "SPEC", "CHALLENGE", "PLAN", "PLAN_REVIEW", "CODE", "QA", "PR", "REGARD", "NOTE", "DONE"];
const TRAVAIL = ORDRE.filter((s) => s !== "DONE");
const GATES = ["spec", "plan", "scope", "arbitrage", "merge"];
// Exporté pour l'option jev : un finding tranché ne se rattache jamais d'office.
export const STATUTS_TRANCHES = ["faux_positif", "tranche", "differe_valeur", "ecarte_valeur"];
const PROTEGEES = [
  "schema", "story", "stage", "previous_stage", "tours", "echecs_consecutifs",
  "dernier_pas_en_echec", "gates", "rigueur", "rigueur_motif",
];

const AIDE = `etat.mjs : toute écriture d'état passe par ici.

  init <id> --titre "<titre>" --regard-client <oui|non> --perimetre <glob> [--perimetre ...]
            [--depend-de <story>:stage=<STAGE> | <story>:gate=<gate>] [--gate-spec-humaine]
  lire <id> [a.b.c]                       affiche l'état, ou une valeur
  ecrire <id> --patch '<json>'            fusionne (objets fusionnés, le reste remplacé)
  ecrire <id> --retirer <a.b.c>           retire une clé d'un objet ouvert
  ajouter <id> <a.b.c> '<json>'           ajoute un élément à une liste
  noter <id> <decisions|blocages|notes> "<texte>" [--par <nom>]
  historique <id> "<texte>"
  rigueur <id> complete --motif "<déclencheur nommé>"
  stage <id> <STAGE> [--motif "<pourquoi>"]     (motif obligatoire pour revenir en arrière)
  tour <id>                               exit 0 on continue, 10 arrêt, 11 plafond
  echec <id> <pas> | succes <id>          exit 12 si la story est arrêtée
  gate <id> <spec|plan> auto --motif "<pourquoi>"
  attendre <id> <gate> --motif "<ce qui est attendu>"
  approuver <id> --par <nom> [--pr-mergee]
  renvoyer <id> <STAGE> --par <nom> --motif "<pourquoi>"
  arreter <id> <max_tours|error> --motif "<pourquoi>"
  reprendre <id>
  ledger-round <id> --findings <fichier.json>
  finding <id> <cle> <statut> [--note "<texte>"]
  escalade <id> <cle> <arbitre|tranche|humain> --verdict "<verdict>" [--note "<texte>"]
                                          (tranche : seulement avec la tranche finale de l'option mistral)
  prerequis <id>                          exit 0 si tous les prérequis sont tenus
  valider [<id> | --tous]
  liste                                   toutes les stories, en JSON
  fil <id>                                le fil d'Ariane`;

class Refus extends Error {}
class Usage extends Error {}

// --- Arguments -----------------------------------------------------------------------------

// analyser(args, {valeurs, multiples, drapeaux}) : rend {positionnels, options}.
function analyser(args, { valeurs = [], multiples = [], drapeaux = [] } = {}) {
  const positionnels = [];
  const options = {};
  for (const m of multiples) options[m] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positionnels.push(a);
      continue;
    }
    const nom = a.slice(2);
    if (drapeaux.includes(nom)) {
      options[nom] = true;
    } else if (valeurs.includes(nom) || multiples.includes(nom)) {
      if (i + 1 >= args.length) throw new Usage(`--${nom} attend une valeur`);
      const v = args[++i];
      if (multiples.includes(nom)) options[nom].push(v);
      else options[nom] = v;
    } else {
      throw new Usage(`option inconnue : --${nom}`);
    }
  }
  return { positionnels, options };
}

function exiger(valeur, message) {
  if (valeur === undefined || valeur === null || valeur === "") throw new Usage(message);
  return valeur;
}

// --- Fichiers ------------------------------------------------------------------------------

function contexte() {
  const racine = trouverRacine();
  const config = chargerConfig(racine);
  return { racine, config, dossier: join(racine, config.chemins.etat) };
}

function cheminEtat(ctx, id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id ?? "")) {
    throw new Usage(`identifiant de story invalide : « ${id} » (minuscules, chiffres, tirets, points)`);
  }
  return join(ctx.dossier, `${id}.json`);
}

function lireEtat(ctx, id) {
  const chemin = cheminEtat(ctx, id);
  if (!existsSync(chemin)) throw new Refus(`état introuvable : ${chemin}`);
  let etat;
  try {
    etat = JSON.parse(readFileSync(chemin, "utf8"));
  } catch (e) {
    throw new Refus(`état illisible (${chemin}) : ${e.message}`);
  }
  return etat;
}

function controler(etat, chemin) {
  const erreurs = valider(lireSchema("etat.schema.json"), etat);
  if (erreurs.length > 0) throw new Refus(`état invalide (${chemin}) :\n${formater(erreurs)}`);
}

// Verrou par story : un dossier créé de façon atomique. Deux écritures concurrentes du même
// état (superviseur et tâche de fond) se suivent au lieu de s'écraser.
function avecVerrou(chemin, fn) {
  const verrou = `${chemin}.verrou`;
  const limite = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(verrou);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(verrou).mtimeMs;
      } catch { /* le verrou vient d'être rendu */ }
      if (age > 30_000) {
        try { rmdirSync(verrou); } catch { /* un autre l'a repris */ }
        continue;
      }
      if (Date.now() > limite) throw new Refus(`état verrouillé depuis plus de 10 s : ${verrou}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(verrou); } catch { /* déjà retiré */ }
  }
}

// modifier(ctx, id, fn) : lit, applique fn(etat), valide, écrit. fn rend ce que la
// sous-commande doit afficher ou rendre.
function modifier(ctx, id, fn) {
  const chemin = cheminEtat(ctx, id);
  return avecVerrou(chemin, () => {
    const etat = lireEtat(ctx, id);
    controler(etat, chemin); // on ne construit pas sur un état déjà faux
    const retour = fn(etat);
    controler(etat, chemin);
    ecrireJson(chemin, etat);
    return retour;
  });
}

function tracer(etat, note) {
  etat.historique.push({ date: maintenant(), stage: etat.stage, note });
}

// --- Règles --------------------------------------------------------------------------------

function estTravail(stage) {
  return TRAVAIL.includes(stage);
}

// Les stages qu'une story a le droit de sauter, et pourquoi.
function sautable(stage, etat, config) {
  if (stage === "PLAN_REVIEW") return etat.rigueur === "legere";
  if (stage === "REGARD") return etat.regard_client === false;
  if (stage === "NOTE") return config.options.note_story.actif !== true;
  return false;
}

function gateFranchie(etat, nom) {
  return ["auto", "approuvee"].includes(etat.gates[nom].etat);
}

function controlerAvance(etat, config, vers) {
  const i = ORDRE.indexOf(etat.stage);
  const j = ORDRE.indexOf(vers);
  for (const s of ORDRE.slice(i + 1, j)) {
    if (!sautable(s, etat, config)) {
      throw new Refus(`on ne saute pas ${s} (story en ${etat.stage}, demandé : ${vers})`);
    }
  }
  const plan = ORDRE.indexOf("PLAN");
  if (i < plan && j >= plan && !gateFranchie(etat, "spec")) {
    throw new Refus("la gate de spec n'est pas franchie : `gate <id> spec auto` ou `attendre <id> spec`");
  }
  // La gate de plan n'existe que si quelqu'un l'a demandée. Une fois en attente (plan critiqué,
  // ou renvoyé par la personne qui approuve), seule `approuver` ouvre le stage CODE.
  const code = ORDRE.indexOf("CODE");
  if (i < code && j >= code && etat.gates.plan.etat === "en_attente") {
    throw new Refus("la gate de plan attend une décision humaine : `attendre <id> plan`, puis `approuver`");
  }
}

// Une question posée à la personne qui approuve ne se perd pas en route : tant que la spec
// porte une marque de clarification, personne n'écrit de code. La marque se lève en révisant
// la spec avec la réponse. Le contrôle est à l'entrée en CODE, et non en PLAN, pour laisser
// la révision se faire après l'accord. Il est appelé par `stage` ET par `approuver` : la
// gate de plan mène en CODE sans passer par `stage`. Spec absente : rien à lire ici.
const MARQUE_CLARIFICATION = /\[NEEDS CLARIFICATION:/g;
function controlerEntreeEnCode(ctx, id, de, vers) {
  const code = ORDRE.indexOf("CODE");
  if (ORDRE.indexOf(de) >= code || ORDRE.indexOf(vers) < code) return;
  const spec = join(ctx.racine, ctx.config.chemins.specs, id, "spec.md");
  if (!existsSync(spec)) return;
  const n = (readFileSync(spec, "utf8").match(MARQUE_CLARIFICATION) ?? []).length;
  if (n > 0) {
    throw new Refus(
      `la spec porte encore ${n} marque(s) [NEEDS CLARIFICATION: une question posée n'a pas de réponse intégrée. ` +
        "Réviser la spec avec la réponse (la marque disparaît), ou renvoyer la story en SPEC",
    );
  }
}

function fusionner(cible, patch, chemin = "") {
  for (const [cle, valeur] of Object.entries(patch)) {
    const ici = chemin ? `${chemin}.${cle}` : cle;
    if (chemin === "" && PROTEGEES.includes(cle)) {
      throw new Refus(`« ${cle} » ne s'écrit pas par patch : une sous-commande dédiée existe (voir aide)`);
    }
    const objet = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (objet(valeur) && objet(cible[cle])) fusionner(cible[cle], valeur, ici);
    else cible[cle] = valeur;
  }
}

function gateVide() {
  return { etat: "non_requise", date: null, par: null, motif: null };
}

// --- Sous-commandes ------------------------------------------------------------------------

const commandes = {
  aide() {
    console.log(AIDE);
    return 0;
  },

  init(args) {
    const { positionnels, options } = analyser(args, {
      valeurs: ["titre", "regard-client"], multiples: ["perimetre", "depend-de"], drapeaux: ["gate-spec-humaine"],
    });
    const ctx = contexte();
    const id = exiger(positionnels[0], "usage : init <id> --titre ... --regard-client <oui|non> --perimetre <glob>");
    const chemin = cheminEtat(ctx, id);
    if (existsSync(chemin)) throw new Refus(`la story existe déjà : ${chemin}`);
    const titre = exiger(options.titre, "--titre est obligatoire");
    if (!["oui", "non"].includes(options["regard-client"])) {
      throw new Usage("--regard-client <oui|non> est obligatoire : un utilisateur voit-il le résultat ?");
    }
    if (options.perimetre.length === 0) {
      throw new Usage("au moins un --perimetre <glob> est obligatoire : les fichiers que la story va toucher");
    }
    const dependDe = options["depend-de"].map((brut) => {
      const m = /^([^:]+):(stage|gate)=(.+)$/.exec(brut);
      if (!m) throw new Usage(`--depend-de mal formé : « ${brut} » (attendu <story>:stage=<STAGE> ou <story>:gate=<gate>)`);
      if (m[2] === "stage" && !ORDRE.includes(m[3])) throw new Usage(`stage inconnu dans --depend-de : ${m[3]}`);
      return { story: m[1], [m[2]]: m[3] };
    });
    const gates = Object.fromEntries(GATES.map((g) => [g, gateVide()]));
    if (options["gate-spec-humaine"] || ctx.config.gates.spec === "humaine") {
      gates.spec = { etat: "en_attente", date: maintenant(), par: null, motif: "gate de spec humaine" };
    }
    const etat = {
      schema: 1,
      story: id,
      titre,
      stage: "INIT",
      previous_stage: null,
      branche: `${ctx.config.git.prefixe_branche}${id}`,
      rigueur: "legere",
      rigueur_motif: null,
      regard_client: options["regard-client"] === "oui",
      perimetre: options.perimetre,
      depend_de: dependDe,
      tours: 0,
      max_tours: ctx.config.boucle.max_tours,
      echecs_consecutifs: 0,
      dernier_pas_en_echec: null,
      gates,
      review_ledger: { code: { rounds: 0, findings: {} } },
      escalations: [],
      pr: { numero: null, url: null },
      historique: [],
      blocages: [],
      decisions: [],
      notes: [],
      extensions: {},
    };
    tracer(etat, `init : rigueur légère par défaut, regard client ${options["regard-client"]}`);
    controler(etat, chemin);
    mkdirSync(ctx.dossier, { recursive: true });
    ecrireJson(chemin, etat);
    console.log(`story créée : ${chemin}`);
    return 0;
  },

  lire(args) {
    const ctx = contexte();
    const etat = lireEtat(ctx, exiger(args[0], "usage : lire <id> [a.b.c]"));
    const valeur = args[1] ? lire(etat, args[1]) : etat;
    if (valeur === undefined || valeur === null) return 0;
    console.log(typeof valeur === "object" ? JSON.stringify(valeur, null, 2) : String(valeur));
    return 0;
  },

  ecrire(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["patch", "patch-fichier"], multiples: ["retirer"] });
    const ctx = contexte();
    const id = exiger(positionnels[0], "usage : ecrire <id> --patch '<json>' | --patch-fichier <f> | --retirer <a.b.c>");
    let patch = null;
    const brut = options["patch-fichier"] ? readFileSync(options["patch-fichier"], "utf8") : options.patch;
    if (brut !== undefined) {
      try {
        patch = JSON.parse(brut);
      } catch (e) {
        throw new Usage(`patch illisible : ${e.message}`);
      }
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new Usage("le patch doit être un objet JSON");
    }
    if (patch === null && options.retirer.length === 0) throw new Usage("rien à écrire : --patch ou --retirer");
    modifier(ctx, id, (etat) => {
      if (patch) fusionner(etat, patch);
      for (const chemin of options.retirer) {
        const cles = chemin.split(".");
        if (PROTEGEES.includes(cles[0])) throw new Refus(`« ${cles[0]} » est protégé`);
        const parent = cles.length > 1 ? lire(etat, cles.slice(0, -1).join(".")) : etat;
        if (parent && typeof parent === "object") delete parent[cles.at(-1)];
      }
    });
    console.log("état mis à jour");
    return 0;
  },

  ajouter(args) {
    const ctx = contexte();
    const [id, chemin, brut] = args;
    exiger(brut, "usage : ajouter <id> <a.b.c> '<json>'");
    let element;
    try {
      element = JSON.parse(brut);
    } catch (e) {
      throw new Usage(`élément illisible : ${e.message}`);
    }
    modifier(ctx, id, (etat) => {
      if (PROTEGEES.includes(chemin.split(".")[0])) throw new Refus(`« ${chemin} » est protégé`);
      const liste = lire(etat, chemin);
      if (!Array.isArray(liste)) throw new Refus(`« ${chemin} » n'est pas une liste`);
      liste.push(element);
    });
    console.log(`ajouté à ${chemin}`);
    return 0;
  },

  noter(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["par"] });
    const ctx = contexte();
    const [id, liste, texte] = positionnels;
    if (!["decisions", "blocages", "notes"].includes(liste)) throw new Usage("usage : noter <id> <decisions|blocages|notes> \"<texte>\" [--par <nom>]");
    exiger(texte, "le texte est obligatoire");
    modifier(ctx, id, (etat) => {
      if (liste === "notes") etat.notes.push(texte);
      else etat[liste].push({ date: maintenant(), stage: etat.stage, note: texte, ...(options.par ? { par: options.par } : {}) });
    });
    console.log(`noté dans ${liste}`);
    return 0;
  },

  historique(args) {
    const ctx = contexte();
    const [id, texte] = args;
    exiger(texte, "usage : historique <id> \"<texte>\"");
    modifier(ctx, id, (etat) => tracer(etat, texte));
    return 0;
  },

  rigueur(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["motif"] });
    const ctx = contexte();
    const [id, niveau] = positionnels;
    if (niveau !== "complete") {
      throw new Usage("usage : rigueur <id> complete --motif \"<déclencheur nommé>\" (on monte en rigueur, on ne redescend jamais)");
    }
    const motif = exiger(options.motif, "--motif est obligatoire : pas de déclencheur nommé, pas de régime complet");
    modifier(ctx, id, (etat) => {
      if (etat.rigueur === "complete") throw new Refus(`déjà en rigueur complète (${etat.rigueur_motif})`);
      etat.rigueur = "complete";
      etat.rigueur_motif = motif;
      tracer(etat, `rigueur complète : ${motif}`);
    });
    console.log(`rigueur : legere -> complete (${motif})`);
    return 0;
  },

  stage(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["motif"] });
    const ctx = contexte();
    const [id, vers] = positionnels;
    if (!estTravail(vers)) {
      throw new Usage(`usage : stage <id> <${TRAVAIL.join("|")}> [--motif ...] (DONE et les attentes ont leurs sous-commandes)`);
    }
    const de = modifier(ctx, id, (etat) => {
      if (!estTravail(etat.stage)) {
        throw new Refus(`la story est en ${etat.stage} : utiliser approuver, renvoyer ou reprendre`);
      }
      const i = ORDRE.indexOf(etat.stage);
      const j = ORDRE.indexOf(vers);
      if (i === j) throw new Refus(`la story est déjà en ${vers}`);
      if (j < i && !options.motif) throw new Refus("revenir en arrière exige --motif");
      if (j > i) {
        controlerAvance(etat, ctx.config, vers);
        controlerEntreeEnCode(ctx, id, etat.stage, vers);
      }
      const avant = etat.stage;
      etat.stage = vers;
      etat.previous_stage = null;
      tracer(etat, `${avant} -> ${vers}${options.motif ? ` : ${options.motif}` : ""}`);
      return avant;
    });
    console.log(`stage : ${de} -> ${vers}`);
    return 0;
  },

  tour(args) {
    const ctx = contexte();
    const id = exiger(args[0], "usage : tour <id>");
    return modifier(ctx, id, (etat) => {
      if (!estTravail(etat.stage)) {
        console.log(`arrêt : la story est en ${etat.stage}`);
        return 10;
      }
      if (etat.tours >= etat.max_tours) {
        etat.previous_stage = etat.stage;
        etat.stage = "stopped_max_tours";
        etat.blocages.push({ date: maintenant(), stage: etat.previous_stage, note: `plafond de ${etat.max_tours} tours atteint` });
        tracer(etat, `arrêt au plafond de tours (${etat.max_tours})`);
        console.log(`arrêt : plafond de ${etat.max_tours} tours atteint`);
        return 11;
      }
      etat.tours += 1;
      console.log(`tour ${etat.tours}/${etat.max_tours} (${etat.stage})`);
      return 0;
    });
  },

  echec(args) {
    const ctx = contexte();
    const [id, pas] = args;
    exiger(pas, "usage : echec <id> <pas>");
    const seuil = ctx.config.boucle.echecs_consecutifs;
    return modifier(ctx, id, (etat) => {
      if (!estTravail(etat.stage)) throw new Refus(`la story est en ${etat.stage}`);
      etat.echecs_consecutifs = etat.dernier_pas_en_echec === pas ? etat.echecs_consecutifs + 1 : 1;
      etat.dernier_pas_en_echec = pas;
      if (etat.echecs_consecutifs >= seuil) {
        etat.previous_stage = etat.stage;
        etat.stage = "stopped_error";
        etat.blocages.push({ date: maintenant(), stage: etat.previous_stage, note: `${seuil} échecs consécutifs sur « ${pas} »` });
        tracer(etat, `arrêt : ${seuil} échecs consécutifs sur « ${pas} »`);
        console.log(`arrêt : ${seuil} échecs consécutifs sur « ${pas} »`);
        return 12;
      }
      console.log(`échec ${etat.echecs_consecutifs}/${seuil} sur « ${pas} »`);
      return 0;
    });
  },

  succes(args) {
    const ctx = contexte();
    modifier(ctx, exiger(args[0], "usage : succes <id>"), (etat) => {
      etat.echecs_consecutifs = 0;
      etat.dernier_pas_en_echec = null;
    });
    return 0;
  },

  gate(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["motif"] });
    const ctx = contexte();
    const [id, nom, etatGate] = positionnels;
    if (!["spec", "plan"].includes(nom) || etatGate !== "auto") {
      throw new Usage("usage : gate <id> <spec|plan> auto --motif ... (les autres gates sont humaines : attendre, puis approuver)");
    }
    const motif = exiger(options.motif, "--motif est obligatoire : sur quoi repose le passage automatique ?");
    modifier(ctx, id, (etat) => {
      if (etat.gates[nom].etat === "en_attente") {
        throw new Refus(`la gate ${nom} attend une décision humaine : seule \`approuver\` la franchit`);
      }
      if (nom === "spec" && ctx.config.gates.spec === "humaine") {
        throw new Refus("ce projet a une gate de spec humaine (gates.spec dans la configuration)");
      }
      etat.gates[nom] = { etat: "auto", date: maintenant(), par: "superviseur", motif };
      tracer(etat, `gate ${nom} franchie automatiquement : ${motif}`);
    });
    console.log(`gate ${nom} : auto`);
    return 0;
  },

  attendre(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["motif"] });
    const ctx = contexte();
    const [id, nom] = positionnels;
    if (!GATES.includes(nom)) throw new Usage(`usage : attendre <id> <${GATES.join("|")}> --motif ...`);
    const motif = exiger(options.motif, "--motif est obligatoire : qu'attend-on de la personne qui approuve ?");
    modifier(ctx, id, (etat) => {
      if (!estTravail(etat.stage)) throw new Refus(`la story est déjà en ${etat.stage}`);
      if (nom === "merge") {
        if (ORDRE.indexOf(etat.stage) < ORDRE.indexOf("PR")) throw new Refus(`pas de gate de merge avant le stage PR (story en ${etat.stage})`);
        controlerAvance(etat, ctx.config, "DONE");
      }
      etat.previous_stage = etat.stage;
      etat.stage = `waiting_gate_${nom}`;
      etat.gates[nom] = { etat: "en_attente", date: maintenant(), par: null, motif };
      tracer(etat, `en attente (gate ${nom}) : ${motif}`);
    });
    console.log(`stage : waiting_gate_${nom}`);
    return 0;
  },

  approuver(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["par"], drapeaux: ["pr-mergee"] });
    const ctx = contexte();
    const id = exiger(positionnels[0], "usage : approuver <id> --par <nom> [--pr-mergee]");
    const par = exiger(options.par, "--par est obligatoire : qui approuve ?");
    const vers = modifier(ctx, id, (etat) => {
      const m = /^waiting_gate_(.+)$/.exec(etat.stage);
      if (!m) throw new Refus(`rien à approuver : la story est en ${etat.stage}`);
      const nom = m[1];
      let suite;
      if (nom === "spec") suite = "PLAN";
      else if (nom === "plan") suite = "CODE";
      else if (nom === "merge") {
        if (!options["pr-mergee"]) {
          throw new Refus("gate de merge : vérifier d'abord que la PR est RÉELLEMENT mergée, puis repasser avec --pr-mergee");
        }
        suite = "DONE";
      } else suite = etat.previous_stage;
      controlerEntreeEnCode(ctx, id, etat.previous_stage ?? suite, suite);
      etat.gates[nom] = { etat: "approuvee", date: maintenant(), par, motif: etat.gates[nom].motif };
      etat.stage = suite;
      etat.previous_stage = null;
      etat.echecs_consecutifs = 0;
      etat.dernier_pas_en_echec = null;
      tracer(etat, `gate ${nom} approuvée par ${par}`);
      return suite;
    });
    console.log(`approuvé : stage ${vers}`);
    return 0;
  },

  renvoyer(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["par", "motif"] });
    const ctx = contexte();
    const [id, vers] = positionnels;
    if (!estTravail(vers)) throw new Usage(`usage : renvoyer <id> <${TRAVAIL.join("|")}> --par <nom> --motif ...`);
    const par = exiger(options.par, "--par est obligatoire");
    const motif = exiger(options.motif, "--motif est obligatoire : que faut-il reprendre ?");
    modifier(ctx, id, (etat) => {
      const m = /^waiting_gate_(.+)$/.exec(etat.stage);
      if (!m) throw new Refus(`rien à renvoyer : la story est en ${etat.stage}`);
      // Renvoyer, c'est reprendre en amont. Viser le stage que la gate ouvre serait la franchir
      // sans l'approuver.
      const ouvre = { spec: "PLAN", plan: "CODE" }[m[1]];
      if (ouvre && ORDRE.indexOf(vers) >= ORDRE.indexOf(ouvre)) {
        throw new Refus(`renvoyer ne franchit pas la gate de ${m[1]} : viser un stage avant ${ouvre}, ou \`approuver\``);
      }
      // Une gate de spec ou de plan renvoyée par un humain reste à franchir par un humain.
      const reste = ["spec", "plan"].includes(m[1]) ? "en_attente" : "non_requise";
      etat.gates[m[1]] = { etat: reste, date: maintenant(), par, motif: `renvoyée : ${motif}` };
      etat.stage = vers;
      etat.previous_stage = null;
      tracer(etat, `gate ${m[1]} renvoyée par ${par} vers ${vers} : ${motif}`);
    });
    console.log(`renvoyé : stage ${vers}`);
    return 0;
  },

  arreter(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["motif"] });
    const ctx = contexte();
    const [id, sorte] = positionnels;
    if (!["max_tours", "error"].includes(sorte)) throw new Usage("usage : arreter <id> <max_tours|error> --motif ...");
    const motif = exiger(options.motif, "--motif est obligatoire");
    modifier(ctx, id, (etat) => {
      if (!estTravail(etat.stage)) throw new Refus(`la story est déjà en ${etat.stage}`);
      etat.previous_stage = etat.stage;
      etat.stage = `stopped_${sorte}`;
      etat.blocages.push({ date: maintenant(), stage: etat.previous_stage, note: motif });
      tracer(etat, `arrêt (${sorte}) : ${motif}`);
    });
    console.log(`stage : stopped_${sorte}`);
    return 0;
  },

  reprendre(args) {
    const ctx = contexte();
    const id = exiger(args[0], "usage : reprendre <id>");
    const vers = modifier(ctx, id, (etat) => {
      if (!etat.stage.startsWith("stopped_")) throw new Refus(`rien à reprendre : la story est en ${etat.stage}`);
      const avant = etat.stage;
      etat.stage = etat.previous_stage;
      etat.previous_stage = null;
      etat.tours = 0;
      etat.echecs_consecutifs = 0;
      etat.dernier_pas_en_echec = null;
      tracer(etat, `reprise depuis ${avant}`);
      return etat.stage;
    });
    console.log(`repris : stage ${vers}, compteurs à zéro`);
    return 0;
  },

  // ledger-round : l'arithmétique d'un round de review. Le superviseur a DÉJÀ réconcilié les
  // clés (même défaut = même clé qu'au round précédent, même si la ligne a bougé).
  "ledger-round"(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["findings"] });
    const ctx = contexte();
    const id = exiger(positionnels[0], "usage : ledger-round <id> --findings <fichier.json>");
    const fichier = exiger(options.findings, "--findings <fichier.json> est obligatoire (liste vide = round propre)");
    let presents;
    try {
      presents = JSON.parse(readFileSync(fichier, "utf8"));
    } catch (e) {
      throw new Refus(`findings illisibles (${fichier}) : ${e.message}`);
    }
    const forme = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cle", "titre", "severite", "fichier"],
        properties: {
          cle: { type: "string", minLength: 1 },
          titre: { type: "string", minLength: 1 },
          severite: { enum: ["P0", "P1", "P2"] },
          fichier: { type: ["string", "null"] },
        },
      },
    };
    const erreurs = valider(forme, presents);
    if (erreurs.length > 0) throw new Refus(`findings mal formés (${fichier}) :\n${formater(erreurs)}`);
    const cles = presents.map((f) => f.cle);
    if (new Set(cles).size !== cles.length) throw new Refus("deux findings portent la même clé : réconcilier avant d'appeler");
    const { seuil_escalade_rounds: seuilRounds, seuil_survie: seuilSurvie } = ctx.config.boucle;
    const tranche = trancheActive(ctx.config);

    const bilan = modifier(ctx, id, (etat) => {
      const ledger = etat.review_ledger.code;
      ledger.rounds += 1;
      const b = { rounds: ledger.rounds, a_corriger: [], a_escalader: [], deja_tranches: [], corriges: [], propre: false };
      for (const f of presents) {
        const connu = ledger.findings[f.cle];
        if (!connu) {
          ledger.findings[f.cle] = { titre: f.titre, severite: f.severite, fichier: f.fichier, survived: 0, escalation: null, statut: "ouvert" };
        } else if (STATUTS_TRANCHES.includes(connu.statut)) {
          b.deja_tranches.push(f.cle);
          continue;
        } else {
          connu.survived += 1;
          connu.statut = "ouvert";
          connu.severite = f.severite;
          connu.fichier = f.fichier;
        }
        const courant = ledger.findings[f.cle];
        const tenace = courant.survived >= seuilSurvie || ledger.rounds >= seuilRounds;
        // L'étage « tranche » (option mistral) s'insère entre l'arbitre et l'humain : un
        // désaccord qui survit à l'arbitrage ET à un round de correction. Jamais pour un P0 : une
        // décision contraignante d'un modèle sur un défaut critique reste celle de l'humain.
        // Option inactive, ou clé absente (configuration 1.0.0) : l'échelle est celle de 1.0.0.
        const versApresArbitre = tranche && courant.severite !== "P0" ? "tranche" : "humain";
        if (courant.escalation === "humain") b.a_escalader.push({ cle: f.cle, vers: "humain" });
        else if (courant.escalation === "tranche") b.a_escalader.push({ cle: f.cle, vers: "humain" });
        else if (courant.escalation === "arbitre") b.a_escalader.push({ cle: f.cle, vers: versApresArbitre });
        else if (tenace) b.a_escalader.push({ cle: f.cle, vers: "arbitre" });
        else b.a_corriger.push(f.cle);
      }
      for (const [cle, connu] of Object.entries(ledger.findings)) {
        if (!cles.includes(cle) && connu.statut === "ouvert") {
          connu.statut = "corrige";
          connu.survived = 0;
          b.corriges.push(cle);
        }
      }
      b.propre = b.a_corriger.length === 0 && b.a_escalader.length === 0;
      tracer(etat, `review round ${ledger.rounds} : ${b.a_corriger.length} à corriger, ${b.a_escalader.length} à escalader, ${b.deja_tranches.length} déjà tranchés`);
      return b;
    });
    console.log(JSON.stringify(bilan, null, 2));
    return 0;
  },

  finding(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["note"] });
    const ctx = contexte();
    const [id, cle, statut] = positionnels;
    exiger(statut, "usage : finding <id> <cle> <statut> [--note ...]");
    modifier(ctx, id, (etat) => {
      const f = etat.review_ledger.code.findings[cle];
      if (!f) throw new Refus(`finding inconnu : « ${cle} »`);
      if (STATUTS_TRANCHES.includes(statut) && !options.note) throw new Refus("clore un finding sans le corriger exige --note : qui a tranché, et pourquoi");
      f.statut = statut;
      if (options.note) f.note = options.note;
      // Un finding rouvert redevient un item neuf : un verdict de valeur passé ne le couvre plus.
      if (statut === "ouvert") delete f.valeur;
      tracer(etat, `finding ${cle} : ${statut}${options.note ? ` (${options.note})` : ""}`);
    });
    console.log(`finding ${cle} : ${statut}`);
    return 0;
  },

  escalade(args) {
    const { positionnels, options } = analyser(args, { valeurs: ["verdict", "note"] });
    const ctx = contexte();
    const [id, cle, niveau] = positionnels;
    if (!["arbitre", "tranche", "humain"].includes(niveau)) throw new Usage("usage : escalade <id> <cle> <arbitre|tranche|humain> --verdict ... [--note ...]");
    if (niveau === "tranche" && !trancheActive(ctx.config)) {
      throw new Refus("l'étage « tranche » n'existe qu'avec la tranche finale de l'option mistral (options.mistral : actif, arbitre, tranche_finale)");
    }
    const verdict = exiger(options.verdict, "--verdict est obligatoire");
    modifier(ctx, id, (etat) => {
      const f = etat.review_ledger.code.findings[cle];
      if (!f) throw new Refus(`finding inconnu : « ${cle} »`);
      f.escalation = niveau;
      etat.escalations.push({ date: maintenant(), cle, niveau, verdict, ...(options.note ? { note: options.note } : {}) });
      tracer(etat, `escalade ${niveau} sur ${cle} : ${verdict}`);
    });
    console.log(`escalade ${niveau} : ${cle} (${verdict})`);
    return 0;
  },

  // prerequis : fermé par défaut. Un prérequis illisible est un prérequis non tenu.
  prerequis(args) {
    const ctx = contexte();
    const etat = lireEtat(ctx, exiger(args[0], "usage : prerequis <id>"));
    const manques = [];
    for (const dep of etat.depend_de) {
      const autre = lireAutre(ctx, dep.story);
      if (!autre) {
        manques.push(`${dep.story} : état introuvable, illisible ou hors schéma (ni dans l'arbre de travail, ni sur ${ctx.config.git.remote}/${ctx.config.git.branche_integration})`);
        continue;
      }
      if (dep.gate) {
        if (!gateFranchie(autre, dep.gate)) manques.push(`${dep.story} : gate ${dep.gate} non franchie (${autre.gates?.[dep.gate]?.etat ?? "absente"})`);
      } else {
        // Une story en attente ou arrêtée en est restée au stage d'où elle vient.
        const atteint = ORDRE.includes(autre.stage) ? autre.stage : autre.previous_stage;
        if (ORDRE.indexOf(atteint) < ORDRE.indexOf(dep.stage)) manques.push(`${dep.story} : stage ${dep.stage} attendu, ${autre.stage} constaté`);
      }
    }
    if (manques.length > 0) {
      console.log(`prérequis non tenus :\n${manques.map((m) => `  ${m}`).join("\n")}`);
      return 1;
    }
    console.log(etat.depend_de.length === 0 ? "aucun prérequis" : "prérequis tenus");
    return 0;
  },

  valider(args) {
    const ctx = contexte();
    const ids = args[0] === "--tous" ? listerIds(ctx) : [exiger(args[0], "usage : valider <id> | --tous")];
    let invalides = 0;
    for (const id of ids) {
      try {
        controler(lireEtat(ctx, id), cheminEtat(ctx, id));
        console.log(`OK : ${id}`);
      } catch (e) {
        if (!(e instanceof Refus)) throw e;
        invalides += 1;
        console.error(e.message);
      }
    }
    return invalides === 0 ? 0 : 1;
  },

  liste() {
    const ctx = contexte();
    const schema = lireSchema("etat.schema.json");
    const lignes = listerIds(ctx).map((id) => {
      try {
        const e = lireEtat(ctx, id);
        if (valider(schema, e).length > 0) return { story: id, invalide: true };
        return {
          story: e.story, titre: e.titre, stage: e.stage, previous_stage: e.previous_stage,
          tours: e.tours, max_tours: e.max_tours, rigueur: e.rigueur, regard_client: e.regard_client,
          pr: e.pr.numero, dernier_evenement: e.historique.at(-1) ?? null,
        };
      } catch {
        return { story: id, invalide: true };
      }
    });
    console.log(JSON.stringify(lignes, null, 2));
    return 0;
  },

  fil(args) {
    const ctx = contexte();
    const etat = lireEtat(ctx, exiger(args[0], "usage : fil <id>"));
    console.log(rendreFil(etat, ctx.config));
    return 0;
  },
};

function listerIds(ctx) {
  if (!existsSync(ctx.dossier)) return [];
  return readdirSync(ctx.dossier)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
}

// L'état d'une autre story, pour juger un prérequis. Un fichier lisible mais hors schéma
// (abîmé, ou réduit à la main à « {"stage":"DONE"} ») ne prouve rien : il vaut état absent.
function lireAutre(ctx, story) {
  const local = join(ctx.dossier, `${story}.json`);
  try {
    let autre;
    if (existsSync(local)) {
      autre = JSON.parse(readFileSync(local, "utf8"));
    } else {
      const ref = `${ctx.config.git.remote}/${ctx.config.git.branche_integration}:${ctx.config.chemins.etat}/${story}.json`;
      autre = JSON.parse(execFileSync("git", ["-C", ctx.racine, "show", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    }
    return valider(lireSchema("etat.schema.json"), autre).length === 0 ? autre : null;
  } catch {
    return null;
  }
}

// Le fil d'Ariane : où en est la story, d'un coup d'oeil.
export function rendreFil(etat, config) {
  const lignes = [`[${etat.story}] tour ${etat.tours}/${etat.max_tours}`];
  if (etat.stage.startsWith("waiting_gate_")) {
    lignes.push(`⏸ ${etat.stage} (en attente de ${config.projet.approbateur})`);
    return lignes.join("\n");
  }
  if (etat.stage.startsWith("stopped_")) {
    lignes.push(`■ ${etat.stage} (reprise : /harness resume ${etat.story})`);
    return lignes.join("\n");
  }
  // PLAN_REVIEW s'affiche dans PLAN ; MERGE est la gate humaine finale.
  const affiche = ["INIT", "SPEC", "CHALLENGE", "PLAN", "CODE", "QA", "PR"];
  if (etat.regard_client) affiche.push("REGARD");
  if (config.options.note_story.actif) affiche.push("NOTE");
  affiche.push("MERGE");
  const courant = etat.stage === "PLAN_REVIEW" ? "PLAN" : etat.stage === "DONE" ? null : etat.stage;
  const rang = courant ? affiche.indexOf(courant) : affiche.length;
  lignes.push(affiche.map((s, i) => (i < rang ? `✓ ${s}` : i === rang ? `◀ ${s}` : s)).join(" · "));
  const ledger = etat.review_ledger.code;
  if (etat.stage === "CODE" && ledger.rounds > 0) {
    const ouverts = Object.values(ledger.findings).filter((f) => f.statut === "ouvert");
    const niveau = ["humain", "tranche", "arbitre"].find((n) => ouverts.some((f) => f.escalation === n)) ?? "aucune";
    lignes.push(`    review CODE : round ${ledger.rounds} · ouverts ${ouverts.length} · escalade ${niveau}`);
  }
  return lignes.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [nom, ...args] = process.argv.slice(2);
  try {
    const commande = commandes[nom ?? "aide"];
    if (!commande) throw new Usage(`sous-commande inconnue : « ${nom} »\n\n${AIDE}`);
    process.exit(commande(args));
  } catch (e) {
    if (e instanceof Usage) {
      console.error(e.message);
      process.exit(2);
    }
    if (e instanceof Refus || e instanceof ErreurConfig) {
      console.error(`REFUS : ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
