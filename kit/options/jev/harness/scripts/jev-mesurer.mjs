#!/usr/bin/env node
// jev-mesurer.mjs : re-mesure les seuils de l'option `jev` sur les reviews du projet.
//
// Les seuils de la configuration (seuil_bas, seuil_haut) ne valent que pour un modèle, une
// formulation de la question et un relecteur. Quand l'un des trois change, ils se re-mesurent :
// c'est cet outil. Le protocole (deux étiqueteurs indépendants, désaccords exclus) est dans
// harness/options/jev.md.
//
// Trois gestes, dans l'ordre :
//   jev-mesurer.mjs paires --sortie <paires.json>
//       construit les paires candidates depuis les artefacts de review de PR du projet : deux
//       findings du MÊME fichier, d'un même artefact, vus pour la première fois à deux commits
//       différents. Les findings d'un chemin exclu, ou qui portent un motif de secret, sont
//       écartés (ils ne partent jamais). Aucun appel.
//   jev-mesurer.mjs interroger --paires <paires.json> --scores <scores.json> [--modele <m>]
//       pose chaque paire dans les deux ordres, garde le minimum. Reprend là où il s'est arrêté :
//       une paire déjà notée n'est pas reposée. Exige l'accord d'envoi et la clé, comme l'option.
//   jev-mesurer.mjs tableau --scores <scores.json> --etiquettes <etiquettes.json> [--seuils 0.5,0.6]
//       avec un fichier d'étiquettes {id: "meme" | "different"}, imprime par seuil les doublons
//       reconnus et les nouveaux défauts tus, avec et sans les artefacts de review.
//
// Codes : 0 fait ; 1 refus ou échec ; 64 usage.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chargerConfig, trouverRacine, ecrireJson, ErreurConfig } from "./lib/config.mjs";
import { JevIndisponible, preparer, scorer, fichiersExclus, refusEnvoi } from "./lib/jev.mjs";

const SEUILS_DEFAUT = [0.5, 0.6, 0.7, 0.8, 0.9];

// Un finding qui porte sur un artefact de review lui-même (son head_sha en retard sur HEAD, par
// exemple) est un bruit connu du relecteur, pas un défaut du code : la mesure se lit avec et sans.
export function estArtefactDeReview(fichier, config) {
  const f = String(fichier ?? "");
  const reviews = String(config.chemins.reviews ?? "").replace(/\/+$/, "");
  return /(^|\/)review-(pr|securite)\.(json|md)$/.test(f) || (reviews !== "" && f.startsWith(`${reviews}/`));
}

function artefactsDuProjet(racine, config) {
  const trouves = [];
  const specs = join(racine, config.chemins.specs);
  if (existsSync(specs)) {
    for (const story of readdirSync(specs).sort()) {
      for (const nom of ["review-pr.json", "review-securite.json"]) {
        const c = join(specs, story, nom);
        if (existsSync(c)) trouves.push(c);
      }
    }
  }
  const reviews = join(racine, config.chemins.reviews);
  if (existsSync(reviews) && statSync(reviews).isDirectory()) {
    for (const nom of readdirSync(reviews).sort()) if (nom.endsWith(".json")) trouves.push(join(reviews, nom));
  }
  return trouves;
}

export function construirePaires(racine, config, env = process.env) {
  const brutes = [];
  for (const chemin of artefactsDuProjet(racine, config)) {
    let a;
    try {
      a = JSON.parse(readFileSync(chemin, "utf8"));
    } catch {
      continue;
    }
    const ordre = new Map((a.reviews ?? []).map((r, i) => [r.head_sha, i]));
    const rang = (f) => ordre.get(f.first_seen_sha) ?? Number.MAX_SAFE_INTEGER;
    const findings = Object.entries(a.findings ?? {})
      .filter(([, f]) => f && typeof f.file === "string" && f.file !== "" && f.first_seen_sha)
      .map(([cle, f]) => ({ cle, titre: f.titre ?? "", corps: f.corps ?? "", fichier: f.file, first_seen_sha: f.first_seen_sha }));
    findings.sort((x, y) => rang(x) - rang(y) || x.cle.localeCompare(y.cle));
    brutes.push({ artefact: relative(racine, chemin), findings });
  }
  const exclus = fichiersExclus(racine, brutes.flatMap((b) => b.findings.map((f) => f.fichier)), env);
  const paires = [];
  let ecartes = 0;
  for (const { artefact, findings } of brutes) {
    const envoyables = findings.filter((f) => {
      const refus = refusEnvoi(f, exclus);
      if (refus) ecartes += 1;
      return !refus;
    });
    for (let i = 0; i < envoyables.length; i++) {
      for (let j = i + 1; j < envoyables.length; j++) {
        const [x, y] = [envoyables[i], envoyables[j]];
        if (x.fichier !== y.fichier || x.first_seen_sha === y.first_seen_sha) continue;
        paires.push({
          id: `${artefact}|${x.cle}|${y.cle}`,
          artefact,
          fichier: x.fichier,
          artefact_de_review: estArtefactDeReview(x.fichier, config),
          a: { cle: x.cle, titre: x.titre, corps: x.corps },
          b: { cle: y.cle, titre: y.titre, corps: y.corps },
        });
      }
    }
  }
  return { paires, ecartes };
}

async function interroger(racine, config, cheminPaires, cheminScores, modele) {
  const paires = JSON.parse(readFileSync(cheminPaires, "utf8"));
  const deja = existsSync(cheminScores) ? JSON.parse(readFileSync(cheminScores, "utf8")) : {};
  // La mesure se fait AVANT d'activer l'option : seul l'accord d'envoi est exigé, pas `actif`.
  if (!config.options.jev) throw new ErreurConfig("options.jev absente de harness/projet.json : recopier le bloc de projet.exemple.json");
  const configMesure = { ...config, options: { ...config.options, jev: { ...config.options.jev, actif: true, ...(modele ? { modele } : {}) } } };
  const { demander } = preparer(configMesure, racine);
  const file = paires.filter((p) => !deja[p.id]);
  let fait = 0;
  async function ouvrier() {
    while (file.length > 0) {
      const p = file.shift();
      const s = await scorer(demander, { titre: p.a.titre, corps: p.a.corps }, { titre: p.b.titre, corps: p.b.corps });
      deja[p.id] = { score: s.score, ab: s.ab, ba: s.ba, modele: s.modele, artefact_de_review: p.artefact_de_review };
      fait += 1;
      if (fait % 20 === 0) ecrireJson(cheminScores, deja);
    }
  }
  try {
    await Promise.all(Array.from({ length: 4 }, ouvrier));
  } finally {
    ecrireJson(cheminScores, deja);
  }
  console.log(`paires notées : ${Object.keys(deja).length} (dont ${fait} à ce passage) -> ${cheminScores}`);
  return 0;
}

// tableau : par seuil, combien de vrais doublons sont reconnus, et combien de défauts DIFFÉRENTS
// seraient pris pour un doublon (« tus » : rattachés, donc ils ne paraîtraient pas comme neufs).
export function calculerTableau(scores, etiquettes, seuils) {
  const lignes = (filtre) => {
    const meme = [];
    const different = [];
    for (const [id, e] of Object.entries(etiquettes)) {
      const s = scores[id];
      if (!s || !filtre(s)) continue;
      if (e === "meme") meme.push(s.score);
      else if (e === "different") different.push(s.score);
    }
    return {
      meme: meme.length,
      different: different.length,
      plus_proche_faux_meme: different.length > 0 ? Math.max(...different) : null,
      seuils: seuils.map((t) => ({ seuil: t, reconnus: meme.filter((x) => x >= t).length, tus: different.filter((x) => x >= t).length })),
    };
  };
  return { toutes: lignes(() => true), hors_artefacts: lignes((s) => !s.artefact_de_review) };
}

function imprimer(titre, t) {
  console.log(`\n${titre} (${t.meme} vrais doublons, ${t.different} défauts différents)`);
  console.log("| seuil | doublons reconnus | nouveaux défauts tus |");
  console.log("|---|---|---|");
  for (const l of t.seuils) console.log(`| ${l.seuil} | ${l.reconnus}/${t.meme} | ${l.tus}/${t.different} |`);
  console.log(`plus proche faux « même » : ${t.plus_proche_faux_meme === null ? "aucun" : Math.round(t.plus_proche_faux_meme * 1000) / 1000}`);
}

async function principal(argv) {
  const [commande, ...reste] = argv;
  const val = (nom) => {
    const i = reste.indexOf(nom);
    return i >= 0 && i + 1 < reste.length ? reste[i + 1] : null;
  };
  const racine = trouverRacine();
  const config = chargerConfig(racine);
  if (commande === "paires" && val("--sortie")) {
    const { paires, ecartes } = construirePaires(racine, config);
    ecrireJson(val("--sortie"), paires);
    console.log(`${paires.length} paire(s) candidate(s), ${ecartes} finding(s) écarté(s) (chemin exclu ou motif de secret) -> ${val("--sortie")}`);
    return 0;
  }
  if (commande === "interroger" && val("--paires") && val("--scores")) {
    return interroger(racine, config, val("--paires"), val("--scores"), val("--modele"));
  }
  if (commande === "tableau" && val("--scores") && val("--etiquettes")) {
    const scores = JSON.parse(readFileSync(val("--scores"), "utf8"));
    const etiquettes = JSON.parse(readFileSync(val("--etiquettes"), "utf8"));
    const seuils = val("--seuils") ? val("--seuils").split(",").map(Number) : SEUILS_DEFAUT;
    if (seuils.some((s) => !Number.isFinite(s) || s <= 0 || s > 1)) {
      console.error("--seuils attend des nombres de 0 (exclu) à 1, séparés par des virgules");
      return 64;
    }
    const t = calculerTableau(scores, etiquettes, seuils);
    const sansEtiquette = Object.keys(scores).filter((id) => !(id in etiquettes)).length;
    imprimer("Toutes les paires étiquetées", t.toutes);
    imprimer("Hors artefacts de review", t.hors_artefacts);
    console.log(`\npaires notées sans étiquette (ignorées) : ${sansEtiquette}`);
    return 0;
  }
  console.error("usage : jev-mesurer.mjs paires --sortie <f> | interroger --paires <f> --scores <f> [--modele <m>] | tableau --scores <f> --etiquettes <f> [--seuils 0.5,0.6]");
  return 64;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await principal(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ErreurConfig) {
      console.error(`REFUS : ${e.message}`);
      process.exitCode = 1;
    } else if (e instanceof JevIndisponible) {
      console.error(`ÉCHEC : ${e.message} (les paires déjà notées sont gardées, relancer reprend la suite)`);
      process.exitCode = 1;
    } else {
      throw e;
    }
  }
}
