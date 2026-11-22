// jev.mjs : le seul endroit qui parle à Jev (TypeSafe AI), et les règles qui décident d'un
// rattachement. Option `jev` du harness (1.2.0).
//
// LE PROBLÈME. La clé d'un finding est son fichier et son titre normalisé. Quand le relecteur
// REFORMULE le titre d'un défaut déjà connu, il passe pour neuf : sa persistance repart à zéro,
// l'échelle d'escalade ne se déclenche jamais, et la boucle de review tourne sans converger.
//
// CE QUE FAIT CE FICHIER. Il pose à Jev, modèle de décision, une question oui ou non sur une
// paire de findings du même fichier (« finding_b est-il le même défaut que finding_a ? »), dans
// les deux ordres, et retient le MINIMUM des deux probabilités. Puis il range chaque finding neuf
// dans une bande : re-détection (rattachement possible), douteux (signalé), neuf.
//
// CE QU'IL NE FAIT JAMAIS : fermer un finding, baisser une sévérité, toucher la gate, rattacher
// un P0, rattacher à un finding tranché (ce serait le faire taire), envoyer autre chose que le
// titre et le corps, envoyer un finding d'un chemin exclu ou qui porte un secret, afficher la clé.
//
// FAIL-OPEN BRUYANT. Toute panne (clé absente, réseau, HTTP non réessayable, réponse mal formée,
// délai) lève `JevIndisponible` : l'appelant ne rattache alors RIEN et le dit. La review ne doit
// jamais échouer à cause de cette option.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ressembleAUnSecret } from "../allowlist-verifier.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const CODEX_COMMUN = join(ICI, "..", "codex-common.sh");

export const BASE_DEFAUT = "https://api.typesafe.ai";

// La formulation MESURÉE (417 paires, modèle jev-1.14.0). Les seuils de la configuration ne valent
// que pour elle : la changer, c'est re-mesurer (harness/options/jev.md).
export const QUESTION = {
  type: "noul",
  instructions:
    "Two code-review findings were reported on the same file in different review rounds of the same pull request. Does finding_b report the SAME underlying defect as finding_a (same flaw at the same place, so one fix closes both), merely reworded or re-reported?",
  criteria: {
    true: "Same defect at the same code location; one fix closes both; finding_b adds nothing new.",
    false:
      "A distinct defect, or the same class of defect on another code path, another side, or another input form, or a defect created by the fix of finding_a. Requires its own fix.",
  },
};

// L'API refuse au-delà d'environ 32 000 jetons d'état. Deux corps bornés à 12 000 caractères
// restent loin dessous ; un corps plus long est coupé, jamais envoyé en entier.
export const TAILLE_MAX_CORPS = 12000;
export const TAILLE_MAX_TITRE = 500;
const ESSAIS = 3;
const PARALLELE = 4;

// Sévérités qu'on compare. Un P0 n'est jamais rattaché, ni comme neuf ni comme cible ; un P3 ne
// bloque rien, il n'a rien à gagner à être reconnu.
const COMPARABLES = ["P1", "P2", "P?"];
const RANG = { P0: 0, P1: 1, P2: 2, "P?": 2, P3: 3 };

export class JevIndisponible extends Error {}

// La plus grave des deux sévérités : un rattachement ne baisse JAMAIS une sévérité.
export function plusGrave(a, b) {
  return (RANG[b] ?? 2) < (RANG[a] ?? 2) ? b : a;
}

export function estComparable(severite) {
  return COMPARABLES.includes(severite);
}

// --- La clé ---------------------------------------------------------------------------------

function deplier(chemin, env) {
  if (chemin === "~") return env.HOME || homedir();
  if (chemin.startsWith("~/")) return join(env.HOME || homedir(), chemin.slice(2));
  return chemin;
}

// lireCle(reglages, racine) : la clé, ou JevIndisponible. TYPESAFE_API_KEY d'abord, sinon le
// fichier configuré. La valeur n'apparaît dans AUCUN message : un message dit ce qui manque, pas
// ce qui a été lu.
export function lireCle(reglages, racine, env = process.env) {
  const parEnv = String(env.TYPESAFE_API_KEY ?? "").trim();
  if (parEnv !== "") return parEnv;
  const chemin = resolve(deplier(reglages.fichier_cle, env));
  if (racine) {
    let reel = chemin;
    try {
      reel = realpathSync(chemin);
    } catch { /* absent : le refus vient plus bas */ }
    let depot = resolve(racine);
    try {
      depot = realpathSync(racine);
    } catch { /* racine introuvable : rien à comparer */ }
    const rel = relative(depot, reel);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new JevIndisponible("le fichier de clé (options.jev.fichier_cle) est dans le dépôt : il partirait avec lui, il n'est pas lu");
    }
  }
  if (!existsSync(chemin)) {
    throw new JevIndisponible("clé absente (ni TYPESAFE_API_KEY, ni le fichier options.jev.fichier_cle)");
  }
  let cle;
  try {
    cle = readFileSync(chemin, "utf8").trim();
  } catch (e) {
    throw new JevIndisponible(`fichier de clé illisible (${e.code ?? "erreur de lecture"})`);
  }
  if (cle === "") throw new JevIndisponible("fichier de clé vide");
  return cle;
}

// --- L'appel --------------------------------------------------------------------------------

function borner(texte, taille) {
  const t = String(texte ?? "");
  return t.length > taille ? t.slice(0, taille) : t;
}

// Le corps d'une question. L'état est un OBJET à clés nommées, jamais un tableau : mesuré, les
// index positionnels sont peu fiables. Rien d'autre que le titre et le corps ne part.
export function corpsRequete(modele, a, b) {
  return {
    model: modele,
    state: {
      finding_a: { title: borner(a.titre, TAILLE_MAX_TITRE), body: borner(a.corps, TAILLE_MAX_CORPS) },
      finding_b: { title: borner(b.titre, TAILLE_MAX_TITRE), body: borner(b.corps, TAILLE_MAX_CORPS) },
    },
    questions: { meme: QUESTION },
  };
}

const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Un identifiant d'erreur court, lisible sans risque (« max_tokens_exceeded »). Rien d'autre du
// corps de la réponse n'est repris : il pourrait renvoyer ce qu'on a envoyé.
function codeErreur(texte) {
  try {
    const j = JSON.parse(texte);
    const c = j?.error?.type ?? j?.error?.code ?? j?.code ?? j?.type;
    if (typeof c === "string" && /^[a-z0-9_.-]{1,60}$/i.test(c)) return c;
  } catch { /* pas du JSON : pas de code */ }
  return null;
}

// client(reglages, cle, env) : rend demander(a, b) -> {p, modele}. 429 et 5xx se réessaient, le
// reste non. Chaque essai a son délai (delai_ms).
export function client(reglages, cle, env = process.env) {
  const base = String(env.TYPESAFE_BASE_URL || BASE_DEFAUT).replace(/\/+$/, "");
  const url = `${base}/v1/systemone`;
  const pause = Number(env.HARNESS_JEV_PAUSE_MS ?? 400);
  return async function demander(a, b) {
    const corps = JSON.stringify(corpsRequete(reglages.modele, a, b));
    let dernier = "";
    for (let essai = 1; essai <= ESSAIS; essai++) {
      let r;
      try {
        r = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
          body: corps,
          signal: AbortSignal.timeout(reglages.delai_ms),
        });
      } catch (e) {
        if (e?.name === "TimeoutError" || e?.name === "AbortError") {
          throw new JevIndisponible(`délai dépassé (${reglages.delai_ms} ms)`);
        }
        throw new JevIndisponible(`réseau (${e?.cause?.code ?? e?.name ?? "erreur"})`);
      }
      let texte;
      try {
        texte = await r.text();
      } catch (e) {
        if (e?.name === "TimeoutError" || e?.name === "AbortError") {
          throw new JevIndisponible(`délai dépassé (${reglages.delai_ms} ms)`);
        }
        throw new JevIndisponible("réponse interrompue");
      }
      if (r.ok) {
        let j;
        try {
          j = JSON.parse(texte);
        } catch {
          throw new JevIndisponible("réponse mal formée (pas du JSON)");
        }
        const p = j?.answers?.meme?.noul;
        if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
          throw new JevIndisponible("réponse mal formée (answers.meme.noul absent ou hors de 0..1)");
        }
        const modele = typeof j.model === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(j.model) ? j.model : null;
        if (!modele) throw new JevIndisponible("réponse mal formée (modèle absent)");
        return { p, modele };
      }
      const code = codeErreur(texte);
      dernier = `HTTP ${r.status}${code ? ` (${code})` : ""}`;
      if (r.status !== 429 && r.status < 500) throw new JevIndisponible(dernier);
      if (essai < ESSAIS) await attendre(pause * essai);
    }
    throw new JevIndisponible(`${dernier}, après ${ESSAIS} essais`);
  };
}

// scorer(demander, a, b) : les deux ordres, le MINIMUM retenu. Un ordre haut et l'autre bas ne
// font pas un doublon.
export async function scorer(demander, a, b) {
  const [ab, ba] = await Promise.all([demander(a, b), demander(b, a)]);
  const modele = ab.modele === ba.modele ? ab.modele : `${ab.modele}/${ba.modele}`;
  return { score: Math.min(ab.p, ba.p), ab: ab.p, ba: ba.p, modele };
}

// --- La confidentialité ---------------------------------------------------------------------

// fichiersExclus(racine, fichiers) : un Set des fichiers couverts par relecteur.chemins_exclus,
// jugés par la fonction du noyau (chemin_exclu de codex-common.sh), la même que celle qui garde
// le relecteur : une seule sémantique de motifs. Le contrôle impossible lève JevIndisponible :
// dans le doute, rien ne part.
export function fichiersExclus(racine, fichiers, env = process.env) {
  const liste = [...new Set(fichiers.filter((f) => typeof f === "string" && f !== ""))];
  if (liste.length === 0) return new Set();
  const script = '. "$1" || exit 90; shift; for f in "$@"; do if chemin_exclu "$f"; then echo 1; else echo 0; fi; done';
  const r = spawnSync("bash", ["-c", script, "jev", CODEX_COMMUN, ...liste], {
    encoding: "utf8", env: { ...env, HARNESS_RACINE: racine }, cwd: racine,
  });
  const lignes = (r.stdout ?? "").split("\n").filter((l) => l !== "");
  if (r.status !== 0 || lignes.length !== liste.length || lignes.some((l) => l !== "0" && l !== "1")) {
    throw new JevIndisponible("contrôle des chemins exclus impossible (codex-common.sh)");
  }
  return new Set(liste.filter((_, i) => lignes[i] === "1"));
}

// Le motif qui interdit d'envoyer ce finding, ou null.
export function refusEnvoi(f, exclus) {
  if (exclus.has(f.fichier)) return "chemin exclu (relecteur.chemins_exclus)";
  const secret = ressembleAUnSecret(f.titre) ?? ressembleAUnSecret(f.corps);
  if (secret) return `motif de secret (${secret})`;
  return null;
}

// --- La décision ----------------------------------------------------------------------------

// Au premier échec, plus aucune paire neuve ne part (un résultat partiel ne sert à rien : l'appelant
// ne rattache alors rien) ; on attend celles déjà en vol, puis l'échec remonte.
async function parLots(taches, n) {
  const resultats = new Array(taches.length);
  let i = 0;
  let arret = false;
  async function ouvrier() {
    while (i < taches.length && !arret) {
      const k = i++;
      try {
        resultats[k] = await taches[k]();
      } catch (e) {
        arret = true;
        throw e;
      }
    }
  }
  const issues = await Promise.allSettled(Array.from({ length: Math.min(n, taches.length) }, ouvrier));
  const echec = issues.find((x) => x.status === "rejected");
  if (echec) throw echec.reason;
  return resultats;
}

const arrondi = (x) => Math.round(x * 1000) / 1000;

/**
 * comparer({ neufs, connus, reglages, demander, exclus }) : le coeur de l'option.
 *
 *   neufs  : [{cle, titre, corps, fichier, severite}] les findings dont la clé est INCONNUE du
 *            registre ;
 *   connus : [{cle, titre, corps, fichier, severite, tranche}] les findings du registre que la
 *            review courante ne re-signale PAS sous leur propre clé (deux findings d'un même
 *            round ne partagent jamais une clé) ;
 *
 * Rend { rattachements: [{source, cible, score, ab, ba, modele}], signalements: [...], paires }.
 * Règles, dans l'ordre :
 *   1. un neuf sans fichier, P0 (ou mineur), interdit d'envoi : aucune comparaison ;
 *   2. ses candidats : les connus du MÊME fichier, comparables et envoyables ;
 *   3. score haut contre un connu NON tranché : candidat au rattachement ; le meilleur gagne, et
 *      deux meilleurs ex aequo ne rattachent rien (au superviseur) ;
 *   4. score haut contre un connu TRANCHÉ : jamais rattaché, signalé ;
 *   5. bande douteuse, sans score haut : signalé avec son meilleur candidat ;
 *   6. deux neufs qui visent la même cible : le meilleur score la prend, l'égalité ne la donne à
 *      personne ; les autres restent neufs, signalés.
 * Toute panne d'appel remonte (JevIndisponible) : l'appelant ne rattache alors rien.
 */
export async function comparer({ neufs, connus, reglages, demander, exclus }) {
  const { seuil_haut: haut, seuil_bas: bas } = reglages;
  const signalements = [];
  const paires = [];
  const parNeuf = new Map();
  for (const n of neufs) {
    if (!n.fichier || !estComparable(n.severite) || refusEnvoi(n, exclus)) continue;
    const candidats = connus.filter(
      (c) => c.fichier === n.fichier && estComparable(c.severite) && !refusEnvoi(c, exclus),
    );
    if (candidats.length === 0) continue;
    parNeuf.set(n.cle, { neuf: n, scores: [] });
    for (const c of candidats) paires.push({ n, c });
  }
  const resultats = await parLots(paires.map(({ n, c }) => () => scorer(demander, c, n)), PARALLELE);
  paires.forEach(({ n, c }, i) => parNeuf.get(n.cle).scores.push({ connu: c, ...resultats[i] }));

  const propositions = [];
  for (const { neuf, scores } of parNeuf.values()) {
    const hauts = scores.filter((s) => s.score >= haut);
    const libres = hauts.filter((s) => !s.connu.tranche);
    for (const s of hauts.filter((x) => x.connu.tranche)) {
      signalements.push(signal(neuf, s, "tranche", `doublon probable de \`${s.connu.cle}\` tranchée (score ${arrondi(s.score)}) : à confirmer par un statut délibéré, il reste neuf et bloquant`));
    }
    if (libres.length > 0) {
      const meilleur = Math.max(...libres.map((s) => s.score));
      const tete = libres.filter((s) => s.score === meilleur);
      if (tete.length > 1) {
        signalements.push(signal(neuf, tete[0], "ex_aequo", `ex aequo entre ${tete.map((s) => `\`${s.connu.cle}\``).join(" et ")} (score ${arrondi(meilleur)}) : aucun rattachement, au superviseur`));
      } else {
        propositions.push({ neuf, s: tete[0] });
      }
      continue;
    }
    if (hauts.length > 0) continue;
    const douteux = scores.filter((s) => s.score >= bas);
    if (douteux.length > 0) {
      const s = douteux.reduce((m, x) => (x.score > m.score ? x : m));
      signalements.push(signal(neuf, s, "douteux", `douteux : peut-être \`${s.connu.cle}\` reformulé (score ${arrondi(s.score)}, entre les deux seuils) ; il reste neuf`));
    }
  }

  // Règle 6 : une cible, un seul rattachement.
  const parCible = new Map();
  for (const p of propositions) {
    const liste = parCible.get(p.s.connu.cle) ?? [];
    liste.push(p);
    parCible.set(p.s.connu.cle, liste);
  }
  const rattachements = [];
  for (const [cible, liste] of parCible) {
    const meilleur = Math.max(...liste.map((p) => p.s.score));
    const tete = liste.filter((p) => p.s.score === meilleur);
    const gagnant = tete.length === 1 ? tete[0] : null;
    if (gagnant) {
      const { s } = gagnant;
      rattachements.push({ source: gagnant.neuf, cible: s.connu, score: s.score, ab: s.ab, ba: s.ba, modele: s.modele });
    }
    for (const p of liste.filter((x) => x !== gagnant)) {
      signalements.push(signal(p.neuf, p.s, "conflit", `vise aussi \`${cible}\` (score ${arrondi(p.s.score)}), rattachée à un autre finding de ce round : il reste neuf`));
    }
  }
  return { rattachements, signalements, paires: paires.length };
}

function signal(neuf, s, type, motif) {
  return { type, source: neuf, candidat: s.connu, score: s.score, ab: s.ab, ba: s.ba, modele: s.modele, motif };
}

// reglagesJev(config) : les réglages, ou null si l'option est absente ou coupée.
export function reglagesJev(config) {
  const r = config?.options?.jev;
  return r?.actif === true ? r : null;
}

// preparer(config, racine) : refuse (JevIndisponible) ce qui empêche tout appel, avant de lire
// le moindre finding : l'accord, puis la clé.
export function preparer(config, racine, env = process.env) {
  const reglages = reglagesJev(config);
  if (!reglages) throw new JevIndisponible("option inactive");
  if (reglages.accord_envoi_externe !== true) {
    throw new JevIndisponible("options.jev.accord_envoi_externe est à false : aucun finding ne part chez TypeSafe AI sans cet accord");
  }
  const cle = lireCle(reglages, racine, env);
  return { reglages, demander: client(reglages, cle, env) };
}
