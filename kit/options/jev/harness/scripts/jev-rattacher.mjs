#!/usr/bin/env node
// jev-rattacher.mjs : reconnaît la reformulation d'un finding déjà connu, et la rattache à sa clé.
// Option `jev` du harness (1.2.0). Les règles et l'appel vivent dans lib/jev.mjs ; ici, les deux
// registres qui les appliquent :
//
//   - stage CODE : `code <id> --findings <f>`, lancé par le superviseur entre codex-diff-review.sh
//     et `etat.mjs ledger-round` (point `avant_ledger_round`). Il réécrit la clé d'un finding
//     reconnu dans le fichier de findings, puis ledger-round fait son arithmétique habituelle :
//     le finding connu survit un round de plus, et l'échelle d'escalade le voit ;
//   - stage PR : `rattacherPr(...)`, appelée par review-pr-fusionner.mjs AVANT la fusion. Elle pose
//     sur le finding reconnu la clé du connu (`cle`) et la trace du rattachement.
//
// Chaque rattachement et chaque signalement s'écrit dans l'état (stage CODE) ou l'artefact
// (stage PR), et dans le journal `harness/.travail/jev/journal.jsonl`. Défaire : jev-defaire.mjs.
//
// Usage :
//   jev-rattacher.mjs code <id> --findings <findings.json> [--corps <corps.json>]
//   jev-rattacher.mjs journal [<id>]          les rattachements et signalements, lisibles
//   jev-rattacher.mjs preflight [--appel]     accord et présence de la clé ; --appel : un appel réel
//
// Codes : 0 fait (y compris quand l'option se tait : elle le dit sur la sortie d'erreur) ;
//         1 refus (fichier illisible, état introuvable, préflight non tenu) ; 64 usage.
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { chargerConfig, trouverRacine, ecrireJson, maintenant, ErreurConfig } from "./lib/config.mjs";
import { cleFinding, statutTraite } from "./lib/review-pr-artefact.mjs";
import { STATUTS_TRANCHES } from "./etat.mjs";
import {
  JevIndisponible, comparer, preparer, reglagesJev, fichiersExclus, refusEnvoi, plusGrave, estComparable,
  scorer, TAILLE_MAX_CORPS,
} from "./lib/jev.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const ETAT = join(ICI, "etat.mjs");

export function cheminJournal(racine) {
  return join(racine, "harness", ".travail", "jev", "journal.jsonl");
}

function journaliser(racine, entrees) {
  if (entrees.length === 0) return;
  const chemin = cheminJournal(racine);
  mkdirSync(dirname(chemin), { recursive: true });
  appendFileSync(chemin, entrees.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

const arrondi = (x) => Math.round(x * 1000) / 1000;

function dire(message) {
  console.error(`option jev indisponible : ${message}. Aucun rattachement : le registre suit la règle de 1.1.0.`);
}

// Y a-t-il au moins une paire à poser ? Sans elle, ni clé ni réseau ne sont nécessaires, et
// l'option n'a rien à dire.
function pairesPossibles(neufs, connus) {
  return neufs.some(
    (n) => n.fichier && estComparable(n.severite) && connus.some((c) => c.fichier === n.fichier && estComparable(c.severite)),
  );
}

// --- Stage PR -------------------------------------------------------------------------------

/**
 * rattacherPr : appelée par review-pr-fusionner.mjs. Rend la liste des findings à fusionner :
 * la même, intacte, si l'option se tait ; sinon les mêmes findings, dont certains portent `cle`
 * (la clé du connu), une sévérité jamais plus basse, et `rattachement` ou `signalements`.
 */
export async function rattacherPr({ racine, config, ancien, nouveaux, headSha, date, artefact, env = process.env }) {
  const connusBruts = ancien?.findings && typeof ancien.findings === "object" ? ancien.findings : {};
  const clesNouveaux = new Map();
  for (const nf of nouveaux) {
    const cle = cleFinding(nf.file, nf.titre);
    const deja = clesNouveaux.get(cle);
    if (!deja || plusGrave(deja.severity, nf.severity) !== deja.severity) clesNouveaux.set(cle, nf);
  }
  const neufs = [...clesNouveaux.entries()]
    .filter(([cle]) => !Object.hasOwn(connusBruts, cle))
    .map(([cle, nf]) => ({ cle, titre: nf.titre, corps: nf.corps ?? "", fichier: nf.file || null, severite: nf.severity }));
  const connus = Object.entries(connusBruts)
    .filter(([cle, f]) => !clesNouveaux.has(cle) && f && typeof f === "object")
    .map(([cle, f]) => ({
      cle, titre: f.titre ?? "", corps: f.corps ?? "", fichier: f.file || null, severite: f.severity,
      // `corrige`, une absence de statut, ou une coquille : non tranché, donc rattachable.
      tranche: statutTraite(f.statut) && f.statut !== "corrige",
    }));
  if (!pairesPossibles(neufs, connus)) return nouveaux;

  const cible = isAbsolute(artefact) ? relative(racine, artefact) : artefact;
  let decision;
  try {
    const { reglages, demander } = preparer(config, racine, env);
    const exclus = fichiersExclus(racine, [...neufs, ...connus].map((f) => f.fichier), env);
    decision = { reglages, ...(await comparer({ neufs, connus, reglages, demander, exclus })) };
  } catch (e) {
    if (!(e instanceof JevIndisponible)) throw e;
    dire(e.message);
    journaliser(racine, [{ date, registre: "pr", cible, action: "indisponible", motif: e.message }]);
    return nouveaux;
  }

  const parSource = new Map(decision.rattachements.map((r) => [r.source.cle, r]));
  const signauxParSource = new Map();
  for (const s of decision.signalements) {
    const liste = signauxParSource.get(s.source.cle) ?? [];
    liste.push({ date, head_sha: headSha, type: s.type, candidat: s.candidat.cle, score: arrondi(s.score), modele: s.modele, motif: s.motif });
    signauxParSource.set(s.source.cle, liste);
  }
  const rendus = nouveaux.map((nf) => {
    const cle = cleFinding(nf.file, nf.titre);
    const r = parSource.get(cle);
    const signaux = signauxParSource.get(cle);
    let sortie = nf;
    if (r) {
      sortie = {
        ...nf,
        cle: r.cible.cle,
        severity: plusGrave(nf.severity, r.cible.severite),
        rattachement: {
          date, head_sha: headSha, cle_source: cle, titre: nf.titre, corps: nf.corps ?? "", severity: nf.severity,
          file: nf.file, lines: nf.lines, score: arrondi(r.score), ab: r.ab, ba: r.ba, modele: r.modele,
        },
      };
    }
    if (signaux) sortie = { ...sortie, signalements: signaux };
    return sortie;
  });

  const entrees = [];
  for (const r of decision.rattachements) {
    console.log(`jev : « ${r.source.titre} » rattaché à \`${r.cible.cle}\` (score ${arrondi(r.score)}, modèle ${r.modele})`);
    entrees.push({ date, registre: "pr", cible, action: "rattachement", cle_source: r.source.cle, cle_cible: r.cible.cle, score: arrondi(r.score), ab: r.ab, ba: r.ba, modele: r.modele });
  }
  for (const s of decision.signalements) {
    console.log(`jev : SIGNALÉ \`${s.source.cle}\` : ${s.motif}`);
    entrees.push({ date, registre: "pr", cible, action: "signalement", type: s.type, cle_source: s.source.cle, cle_cible: s.candidat.cle, score: arrondi(s.score), ab: s.ab, ba: s.ba, modele: s.modele, motif: s.motif });
  }
  journaliser(racine, entrees);
  console.log(`jev : ${decision.rattachements.length} rattachement(s), ${decision.signalements.length} signalement(s), ${decision.paires} paire(s) posée(s) dans les deux ordres`);
  return rendus;
}

// --- Stage CODE -----------------------------------------------------------------------------

function etat(args, { lecture = true } = {}) {
  const sortie = execFileSync(process.execPath, [ETAT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return lecture ? sortie : null;
}

function historique(id, texte) {
  try {
    etat(["historique", id, texte], { lecture: false });
  } catch (e) {
    console.error(`jev : ligne d'historique non écrite (${String(e.stderr ?? e.message).trim()})`);
  }
}

function lireJsonOuRefus(chemin, quoi) {
  try {
    return JSON.parse(readFileSync(chemin, "utf8"));
  } catch (e) {
    throw new ErreurConfig(`${quoi} illisible (${chemin}) : ${e.message}`);
  }
}

// Un connu OUVERT absent du round est tenu pour corrigé par ledger-round, et sa persistance repart
// à zéro : ce qu'un rattachement plus ancien lui avait ajouté n'y est plus. On le note sur la
// trace (`remis_a_zero`), pour que défaire ne retire pas une persistance gagnée après.
function marquerRemises(rattachements, clesFinales, ledger, round) {
  return rattachements.map((r) => (
    !r.defait && r.remis_a_zero === undefined && !clesFinales.has(r.cle_cible) && ledger.findings[r.cle_cible]?.statut === "ouvert"
      ? { ...r, remis_a_zero: round }
      : r));
}

// Les rounds que l'option a vus passer. Un round sans elle (option coupée) a pu remettre un connu à
// zéro sans que la trace le dise : défaire ne retire alors rien (jev-defaire.mjs).
function vus(ext, round) {
  return [...new Set([...(ext.rounds_vus ?? []), round])].sort((a, b) => a - b);
}

function ecrireExtension(racine, id, jev) {
  const patch = join(racine, "harness", ".travail", "jev", `patch-${id}.json`);
  mkdirSync(dirname(patch), { recursive: true });
  writeFileSync(patch, JSON.stringify({ extensions: { jev } }));
  try {
    etat(["ecrire", id, "--patch-fichier", patch], { lecture: false });
  } catch (err) {
    throw new ErreurConfig(`état non écrit : ${String(err.stderr ?? err.message).trim()}`);
  }
}

async function code(racine, config, id, cheminFindings, cheminCorps) {
  if (!reglagesJev(config)) {
    console.log("option jev inactive : le fichier de findings est laissé tel quel");
    return 0;
  }
  const presents = lireJsonOuRefus(cheminFindings, "fichier de findings");
  if (!Array.isArray(presents)) throw new ErreurConfig(`fichier de findings mal formé (${cheminFindings}) : une liste est attendue`);
  const corpsCheminDefaut = cheminFindings.replace(/\.json$/, "") + ".corps.json";
  const corpsDuRound = existsSync(cheminCorps ?? corpsCheminDefaut) ? lireJsonOuRefus(cheminCorps ?? corpsCheminDefaut, "fichier des corps") : {};
  let e;
  try {
    e = JSON.parse(etat(["lire", id]));
  } catch (err) {
    throw new ErreurConfig(`état de « ${id} » illisible : ${String(err.stderr ?? err.message).trim()}`);
  }
  const ledger = e.review_ledger.code;
  const ext = e.extensions?.jev ?? {};
  const corpsConnus = ext.corps ?? {};
  const clesPresentes = new Set(presents.map((f) => f.cle));
  const neufs = presents
    .filter((f) => !Object.hasOwn(ledger.findings, f.cle))
    .map((f) => ({ cle: f.cle, titre: f.titre, corps: String(corpsDuRound[f.cle] ?? ""), fichier: f.fichier, severite: f.severite }));
  const connus = Object.entries(ledger.findings)
    .filter(([cle]) => !clesPresentes.has(cle))
    .map(([cle, f]) => ({
      cle, titre: f.titre, corps: String(corpsConnus[cle] ?? ""), fichier: f.fichier, severite: f.severite,
      tranche: STATUTS_TRANCHES.includes(f.statut),
    }));
  const date = maintenant();
  const round = ledger.rounds + 1;

  let exclus;
  let decision = { rattachements: [], signalements: [], paires: 0 };
  try {
    exclus = fichiersExclus(racine, [...presents.map((f) => f.fichier), ...connus.map((f) => f.fichier)]);
    if (pairesPossibles(neufs, connus)) {
      const { reglages, demander } = preparer(config, racine);
      decision = await comparer({ neufs, connus, reglages, demander, exclus });
    }
  } catch (err) {
    if (!(err instanceof JevIndisponible)) throw err;
    dire(err.message);
    historique(id, `option jev indisponible : ${err.message} (round ${round} : aucun rattachement)`);
    journaliser(racine, [{ date, registre: "code", cible: id, action: "indisponible", round, motif: err.message }]);
    ecrireExtension(racine, id, {
      ...ext,
      rattachements: marquerRemises(ext.rattachements ?? [], clesPresentes, ledger, round),
      rounds_vus: vus(ext, round),
    });
    return 0;
  }

  // Le fichier de findings, réécrit seulement s'il change : la clé du connu, une sévérité jamais
  // plus basse. Le titre reste celui du relecteur.
  const parSource = new Map(decision.rattachements.map((r) => [r.source.cle, r]));
  if (parSource.size > 0) {
    const reecrits = presents.map((f) => {
      const r = parSource.get(f.cle);
      return r ? { ...f, cle: r.cible.cle, severite: plusGrave(f.severite, r.cible.severite) } : f;
    });
    ecrireJson(cheminFindings, reecrits);
  }

  // Ce que l'option garde dans l'état : le corps des findings envoyables (pour comparer au round
  // suivant, sous la clé finale), les rattachements et les signalements, avec le round.
  const corps = { ...corpsConnus };
  for (const f of presents) {
    const texte = String(corpsDuRound[f.cle] ?? "");
    if (refusEnvoi({ titre: f.titre, corps: texte, fichier: f.fichier }, exclus)) continue;
    corps[parSource.get(f.cle)?.cible.cle ?? f.cle] = texte.slice(0, TAILLE_MAX_CORPS);
  }
  const nouveauxRattachements = decision.rattachements.map((r) => ({
    date, round, cle_source: r.source.cle, cle_cible: r.cible.cle, titre: r.source.titre, severite: r.source.severite,
    fichier: r.source.fichier, score: arrondi(r.score), ab: r.ab, ba: r.ba, modele: r.modele,
  }));
  const nouveauxSignalements = decision.signalements.map((s) => ({
    date, round, type: s.type, cle: s.source.cle, candidat: s.candidat.cle, score: arrondi(s.score), modele: s.modele, motif: s.motif,
  }));
  const jev = {
    rounds_vus: vus(ext, round),
    corps,
    rattachements: [
      ...marquerRemises(ext.rattachements ?? [], new Set(presents.map((f) => parSource.get(f.cle)?.cible.cle ?? f.cle)), ledger, round),
      ...nouveauxRattachements,
    ],
    signalements: [...(ext.signalements ?? []), ...nouveauxSignalements],
  };
  ecrireExtension(racine, id, jev);
  const entrees = [];
  for (const r of nouveauxRattachements) {
    const ligne = `jev : « ${r.titre} » (\`${r.cle_source}\`) rattaché à \`${r.cle_cible}\` (score ${r.score}, modèle ${r.modele})`;
    console.log(ligne);
    historique(id, ligne);
    entrees.push({ date, registre: "code", cible: id, action: "rattachement", ...r });
  }
  for (const s of nouveauxSignalements) {
    const ligne = `jev : SIGNALÉ \`${s.cle}\` : ${s.motif}`;
    console.log(ligne);
    historique(id, ligne);
    entrees.push({ date, registre: "code", cible: id, action: "signalement", ...s });
  }
  journaliser(racine, entrees);
  console.log(`jev : ${nouveauxRattachements.length} rattachement(s), ${nouveauxSignalements.length} signalement(s), ${decision.paires} paire(s) posée(s) dans les deux ordres. Suite : etat.mjs ledger-round ${id} --findings ${cheminFindings}`);
  return 0;
}

// --- Lecture du journal, préflight ----------------------------------------------------------

function journal(racine, id) {
  const chemin = cheminJournal(racine);
  if (!existsSync(chemin)) {
    console.log("journal jev vide : aucun rattachement, aucun signalement");
    return 0;
  }
  let n = 0;
  for (const ligne of readFileSync(chemin, "utf8").split("\n")) {
    if (!ligne.trim()) continue;
    let e;
    try {
      e = JSON.parse(ligne);
    } catch {
      continue;
    }
    if (id && e.cible !== id && !String(e.cible ?? "").includes(`/${id}/`)) continue;
    n += 1;
    const ou = `${e.date} ${e.registre} ${e.cible}`;
    if (e.action === "rattachement") console.log(`${ou} RATTACHÉ ${e.cle_source} -> ${e.cle_cible} (score ${e.score}, modèle ${e.modele})`);
    else if (e.action === "signalement") console.log(`${ou} SIGNALÉ ${e.cle_source ?? e.cle} (${e.type}) : ${e.motif}`);
    else console.log(`${ou} ${String(e.action).toUpperCase()} : ${e.motif ?? ""}`);
  }
  if (n === 0) console.log("aucune entrée pour cette cible");
  return 0;
}

async function preflight(racine, config, appel) {
  try {
    const { reglages, demander } = preparer(config, racine);
    console.log(`option jev : accord donné, clé présente (jamais affichée), modèle ${reglages.modele}, seuils ${reglages.seuil_bas} / ${reglages.seuil_haut}`);
    if (!appel) return 0;
    const a = { titre: "Division by zero when the list is empty", corps: "average() divides by len(values) without checking for an empty list." };
    const b = { titre: "average() crashes on an empty list", corps: "len(values) can be 0, and the division then raises." };
    const s = await scorer(demander, a, b);
    console.log(`appel réel : score ${arrondi(s.score)} (deux ordres : ${arrondi(s.ab)} et ${arrondi(s.ba)}), modèle répondu ${s.modele}`);
    return 0;
  } catch (e) {
    if (!(e instanceof JevIndisponible)) throw e;
    console.error(`REFUS : option jev non prête : ${e.message}`);
    return 1;
  }
}

async function principal(argv) {
  const [commande, ...reste] = argv;
  const val = (nom) => {
    const i = reste.indexOf(nom);
    return i >= 0 && i + 1 < reste.length ? reste[i + 1] : null;
  };
  const racine = trouverRacine();
  const config = chargerConfig(racine);
  if (commande === "code") {
    const id = reste[0];
    const findings = val("--findings");
    if (!id || id.startsWith("--") || !findings) {
      console.error("usage : jev-rattacher.mjs code <id> --findings <findings.json> [--corps <corps.json>]");
      return 64;
    }
    return code(racine, config, id, findings, val("--corps"));
  }
  if (commande === "journal") return journal(racine, reste[0] ?? null);
  if (commande === "preflight") return preflight(racine, config, reste.includes("--appel"));
  console.error("usage : jev-rattacher.mjs code <id> --findings <f> [--corps <f>] | journal [<id>] | preflight [--appel]");
  return 64;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await principal(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof ErreurConfig)) throw e;
    console.error(`REFUS : ${e.message}`);
    process.exitCode = 1;
  }
}
