#!/usr/bin/env node
// jev-defaire.mjs : défait un rattachement de l'option `jev`, quand un humain juge que la
// reformulation reconnue était en fait un AUTRE défaut.
//
// Défaire, c'est ROUVRIR COMME NEUF : le finding reformulé reprend sa propre clé (fichier + titre),
// ouvert, persistance à zéro, et bloque comme tout finding neuf. Le finding connu perd la
// persistance que le rattachement lui avait ajoutée ; son statut ne bouge pas (s'il avait été
// rouvert par le rattachement, il reste ouvert : rien ne se ferme jamais seul, pose toi-même
// `corrige` si c'est le cas). Le rattachement n'est pas effacé : il est marqué défait, avec la note.
//
// Usage :
//   jev-defaire.mjs code <id> <cle_cible> <cle_source> --note "<pourquoi>"
//   jev-defaire.mjs pr <id | artefact.json> <cle_cible> <cle_source> --note "<pourquoi>"
//
// Au stage CODE, le geste vient APRÈS le `ledger-round` du round qui a rattaché (avant, le
// fichier de findings porte encore la clé réécrite : relance plutôt jev-rattacher sur la sortie
// brute, ou corrige la clé à la main dans le fichier de findings).
//
// Codes : 0 défait ; 1 refus ; 64 usage.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chargerConfig, trouverRacine, cheminArtefactReview, ecrireJson, maintenant, ErreurConfig } from "./lib/config.mjs";
import { genererMarkdown, findingsOuverts } from "./lib/review-pr-artefact.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const ETAT = join(ICI, "etat.mjs");

function refuser(message) {
  throw new ErreurConfig(message);
}

function etat(args) {
  try {
    return execFileSync(process.execPath, [ETAT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    refuser(String(e.stderr ?? e.message).trim());
  }
  return "";
}

function defaireCode(racine, id, cible, source, note) {
  const e = JSON.parse(etat(["lire", id]));
  const ledger = e.review_ledger.code;
  const jev = e.extensions?.jev ?? {};
  const liste = jev.rattachements ?? [];
  // Une même reformulation peut avoir été rattachée à plusieurs rounds : on les défait TOUS, et la
  // plus récente donne ce qui est rouvert (titre, sévérité).
  const actifs = liste.map((x, k) => [x, k]).filter(([x]) => x.cle_cible === cible && x.cle_source === source && !x.defait);
  if (actifs.length === 0) refuser(`aucun rattachement actif de « ${source} » vers « ${cible} » dans extensions.jev.rattachements`);
  const r = actifs.at(-1)[0];
  const indices = new Set(actifs.map(([, k]) => k));
  if (ledger.rounds < r.round) refuser(`le round ${r.round} qui a rattaché n'est pas encore passé par ledger-round : rien à défaire dans le registre`);
  if (Object.hasOwn(ledger.findings, source)) refuser(`« ${source} » est déjà dans le registre : il n'y a rien à rouvrir`);
  const connu = ledger.findings[cible];
  if (!connu) refuser(`« ${cible} » n'est pas dans le registre`);
  const date = maintenant();
  const rattachements = liste.map((x, k) => (indices.has(k) ? { ...x, defait: { date, note } } : x));
  const survived = Math.max(0, connu.survived - actifs.length);
  const patch = {
    review_ledger: {
      code: {
        findings: {
          [source]: { titre: r.titre, severite: r.severite, fichier: r.fichier, survived: 0, escalation: null, statut: "ouvert" },
          [cible]: { survived },
        },
      },
    },
    extensions: { jev: { rattachements } },
  };
  const fichier = join(racine, "harness", ".travail", "jev", `defaire-${id}.json`);
  mkdirSync(dirname(fichier), { recursive: true });
  writeFileSync(fichier, JSON.stringify(patch));
  etat(["ecrire", id, "--patch-fichier", fichier]);
  etat(["historique", id, `jev : rattachement défait, ${source} rouvert comme neuf (était rattaché à ${cible}) : ${note}`]);
  console.log(`${actifs.length} rattachement(s) défait(s) : ${source} rouvert comme neuf, ${cible} garde son statut (persistance ${survived})`);
  return 0;
}

function defairePr(racine, config, cibleArg, cible, source, note) {
  const relatif = cheminArtefactReview(config, racine, cibleArg);
  const chemin = join(racine, relatif);
  if (!existsSync(chemin)) refuser(`artefact absent : ${relatif}`);
  let artefact;
  try {
    artefact = JSON.parse(readFileSync(chemin, "utf8"));
  } catch (e) {
    refuser(`artefact illisible : ${relatif} (${e.message})`);
  }
  const connu = artefact.findings?.[cible];
  if (!connu) refuser(`clé inconnue dans ${relatif} : « ${cible} »`);
  const liste = connu.rattachements ?? [];
  const actifs = liste.map((x, k) => [x, k]).filter(([x]) => x.cle_source === source && !x.defait);
  if (actifs.length === 0) refuser(`aucun rattachement actif de « ${source} » sur « ${cible} »`);
  if (Object.hasOwn(artefact.findings, source)) refuser(`« ${source} » est déjà dans l'artefact : il n'y a rien à rouvrir`);
  const r = actifs.at(-1)[0];
  const indices = new Set(actifs.map(([, k]) => k));
  const ajoute = actifs.reduce((n, [x]) => n + (x.survived_ajoute ?? 0), 0);
  const date = maintenant();
  artefact.findings[source] = {
    severity: r.severity,
    file: r.file,
    lines: r.lines,
    titre: r.titre,
    corps: r.corps,
    first_seen_sha: r.head_sha,
    last_seen_sha: r.head_sha,
    survived: 0,
    statut: null,
    note: `rouvert comme neuf le ${date} : rattachement jev à ${cible} défait (${note})`,
    date_statut: null,
    auto: false,
    escalation: null,
    reouvertures: [],
  };
  artefact.findings[cible] = {
    ...connu,
    survived: Math.max(0, (connu.survived ?? 0) - ajoute),
    rattachements: liste.map((x, k) => (indices.has(k) ? { ...x, defait: { date, note } } : x)),
  };
  artefact.synthese = { ...(artefact.synthese ?? {}), open_p0_p2: findingsOuverts(artefact).length };
  ecrireJson(chemin, artefact);
  writeFileSync(chemin.replace(/\.json$/, ".md"), genererMarkdown(artefact));
  console.log(`rattachement défait : ${source} rouvert comme neuf dans ${relatif} ; ${cible} garde son statut. À commiter : ${relatif} et ${relatif.replace(/\.json$/, ".md")}`);
  return 0;
}

function principal(argv) {
  const positionnels = [];
  let note = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--note") {
      note = String(argv[i + 1] ?? "").trim();
      i += 1;
    } else positionnels.push(argv[i]);
  }
  const [registre, quoi, cible, source] = positionnels;
  if (!["code", "pr"].includes(registre) || !quoi || !cible || !source || positionnels.length !== 4) {
    console.error('usage : jev-defaire.mjs <code|pr> <id | artefact.json> <cle_cible> <cle_source> --note "<pourquoi>"');
    return 64;
  }
  if (note === "") refuser("--note est obligatoire : qui a jugé que ce n'était pas le même défaut, et pourquoi");
  const racine = trouverRacine();
  const config = chargerConfig(racine);
  return registre === "code" ? defaireCode(racine, quoi, cible, source, note) : defairePr(racine, config, quoi, cible, source, note);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof ErreurConfig)) throw e;
    console.error(`REFUS : ${e.message}`);
    process.exitCode = 1;
  }
}
