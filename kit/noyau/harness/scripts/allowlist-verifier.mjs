#!/usr/bin/env node
// allowlist-verifier.mjs : propose et contrôle les permissions accordées à l'agent.
//
// POURQUOI : une liste de permissions grossit à la main, une approbation après l'autre. On y
// retrouve vite une commande entière avec son jeton dedans, un interpréteur autorisé sans
// limite, ou le relecteur autorisé « nu » (donc avec écriture). Ici la liste est CALCULÉE
// depuis la configuration, puis contrôlée avant d'être appliquée.
//
// LA SYNTAXE DES RÈGLES, telle que la documente l'outil : « * » vaut n'importe quel texte, où
// qu'il soit ; « :* » ne se lit qu'en fin de règle et vaut « espace puis n'importe quoi » (la
// commande nue passe aussi). `Bash(git switch feat/:*)` n'autorise donc PAS
// `git switch feat/001-x` : pour un nom collé au préfixe, il faut `Bash(git switch feat/*)`.
//
// CE QUE ÇA NE GARANTIT PAS : une règle d'interdiction compare l'écriture d'une commande à un
// motif. Elle arrête le geste habituel, pas une variante écrite autrement. Le vrai verrou d'une
// branche protégée se pose sur la forge (protection de branche), pas ici.
//
// Usage :
//   allowlist-verifier.mjs proposer            la proposition, en JSON, sur la sortie
//   allowlist-verifier.mjs verifier <fichier>  contrôle un fichier de réglages ou de proposition
//   allowlist-verifier.mjs appliquer <fichier> ajoute la proposition au fichier de réglages
//
// appliquer n'enlève rien : il ajoute ce qui manque, garde le reste du fichier tel quel, et
// contrôle le RÉSULTAT avant de l'écrire. Un fichier qui portait déjà une entrée refusée
// n'est pas modifié : c'est à son propriétaire de la retirer. Le fichier n'est jamais affiché
// (il peut porter un jeton), seuls les motifs de refus le sont.
//
// Codes : 0 fait, ou fichier accepté ; 1 fichier refusé (chaque motif est listé) ; 2 usage.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chargerConfig, trouverRacine, ecrireJson, ErreurConfig } from "./lib/config.mjs";

// Ce qui ressemble à un secret. On refuse au moindre doute : un faux refus coûte une ligne à
// réécrire, un jeton commité coûte une rotation.
const MOTIFS_SECRET = [
  [/\b(sk|pk|rk)[-_](live|test|proj)[-_][A-Za-z0-9]{8,}/, "clé d'API"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/, "jeton de forge"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/, "jeton de forge"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/, "jeton de forge"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/, "jeton de messagerie"],
  [/\bAKIA[0-9A-Z]{16}\b/, "identifiant de clé d'accès"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "jeton JWT"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i, "en-tête d'autorisation"],
  [/\b(authorization|x-api-key)\s*:/i, "en-tête d'autorisation"],
  [/(token|secret|passw(or)?d|mot_?de_?passe|api[_-]?key|apikey|private[_-]?key)[A-Za-z0-9_]*\s*=\s*[^\s$*)]{4,}/i, "affectation d'un secret"],
  [/:\/\/[^\s/:@]+:[^\s/@]{3,}@/, "identifiants dans une URL"],
  [/\b[0-9]{8,10}:[A-Za-z0-9_-]{30,}/, "jeton de robot"],
];

// Une suite longue de lettres ET de chiffres, hors chemin de fichier, sent le jeton.
function sentLeJeton(texte) {
  for (const mot of texte.split(/[\s/"'=:,()[\]{}<>|;&]+/)) {
    if (mot.length < 32) continue;
    if (!/^[A-Za-z0-9+_.-]+$/.test(mot)) continue;
    if (/[A-Za-z]/.test(mot) && /[0-9]/.test(mot) && !/\.(sh|mjs|js|json|md|py|ts)$/.test(mot)) return true;
  }
  return false;
}

// Programmes qui exécutent n'importe quoi : les autoriser sans limite revient à tout autoriser.
const TROP_LARGES = ["bash", "sh", "zsh", "node", "python", "python3", "env", "eval", "sudo", "xargs", "npx", "ssh"];
// Jamais autorisés d'avance, même avec des arguments : ils sortent du dépôt ou de la machine.
const JAMAIS = ["curl", "wget", "nc", "scp"];
// Gestes qu'une liste d'autorisations ne doit jamais contenir.
const GESTES_INTERDITS = [
  [/^gh\s+pr\s+merge\b/, "merge d'une PR : c'est le geste de la personne qui approuve"],
  [/^git\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, "push forcé"],
  [/^git\s+reset\s+--hard\b/, "reset --hard"],
  [/^git\s+clean\b/, "git clean"],
  [/^rm\s+-[a-zA-Z]*r[a-zA-Z]*f|^rm\s+-[a-zA-Z]*f[a-zA-Z]*r/, "suppression récursive"],
];

// L'intérieur d'une règle « Outil(contenu) », et le joker final retiré.
function decouper(regle) {
  const m = /^([A-Za-z_]+)(?:\((.*)\))?$/s.exec(regle);
  if (!m) return null;
  const contenu = m[2] ?? null;
  if (contenu === null) return { outil: m[1], contenu: null, prefixe: null, joker: false };
  const joker = /(:\*|\s\*|\*)$/.test(contenu);
  const prefixe = contenu.replace(/(:\*|\s\*|\*)$/, "").trim();
  return { outil: m[1], contenu, prefixe, joker };
}

// Les refus qui ferment ce que le joker des pushs autorisés avale : `git push <remote>
// <préfixe>*` accepte aussi « feat/x:main », « feat/x main », « feat/x +main » et
// « feat/x --force ».
function refusDePush(config) {
  const { remote, branche_integration: integration, branche_production: production } = config.git;
  const regles = [
    "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git push --force-with-lease:*)",
    "Bash(git push * --force*)", "Bash(git push * -f)", "Bash(git push * -f *)",
    "Bash(git push * +*)",
  ];
  for (const b of [integration, production].filter(Boolean)) {
    regles.push(
      `Bash(git push ${remote} ${b}:*)`,
      // La branche protégée nommée après une autre : Git pousse les deux.
      `Bash(git push * ${b})`, `Bash(git push * ${b} *)`, `Bash(git push * refs/heads/${b}*)`,
      `Bash(git push *:${b})`, `Bash(git push *:${b} *)`, `Bash(git push *:refs/heads/${b}*)`,
    );
  }
  return regles;
}

// [règle exacte, pourquoi] : ce qu'une liste d'interdictions doit porter au minimum.
function interditesAttendues(config) {
  const attendues = [
    ["Bash(gh pr merge:*)", "le merge reste un geste humain"],
    ["Bash(git push --force:*)", "pas de push forcé"],
    ["Bash(git push * --force*)", "pas de push forcé, où que soit l'option"],
    ["Bash(git reset --hard:*)", "pas de reset --hard"],
  ];
  const { remote, branche_production: production } = config.git;
  if (production) {
    attendues.push(
      [`Bash(git push ${remote} ${production}:*)`, "pas de push direct vers la production"],
      [`Bash(git push *:${production})`, "pas de push d'une autre branche vers la production"],
      [`Bash(git push * ${production})`, "pas de production nommée après une autre branche"],
    );
  }
  return attendues;
}

export function proposer(config) {
  const { remote, prefixe_branche: prefixe, forge } = config.git;
  const scriptsBash = [
    "gate.sh", "banc.sh", "notifier.sh", "prerequis.sh", "preflight.sh", "codex-challenge.sh",
    "codex-plan-review.sh", "codex-diff-review.sh", "codex-arbitrer.sh", "review-pr-locale.sh",
  ];
  const scriptsNode = ["etat.mjs", "review-locale.mjs", "review-statut.mjs", "allowlist-verifier.mjs", "lib/config.mjs"];
  const allow = [
    ...scriptsBash.map((s) => `Bash(bash harness/scripts/${s}:*)`),
    ...scriptsNode.map((s) => `Bash(node harness/scripts/${s}:*)`),
    "Bash(node --test harness/tests/*)",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
    "Bash(git branch --show-current)", "Bash(git rev-parse:*)", "Bash(git ls-files:*)",
    "Bash(git add:*)", "Bash(git commit:*)", `Bash(git fetch ${remote}:*)`,
    // Le nom de la branche est COLLÉ au préfixe : joker seul, sans les deux-points.
    `Bash(git switch -c ${prefixe}*)`, `Bash(git switch ${prefixe}*)`,
    `Bash(git push ${remote} ${prefixe}*)`, `Bash(git push -u ${remote} ${prefixe}*)`,
  ];
  if (config.options.creneaux.actif) allow.push("Bash(bash harness/scripts/creneaux.sh:*)");
  if (config.options.valeur.actif) allow.push("Bash(bash harness/scripts/valeur-valider.sh:*)");
  if (config.options.note_story.actif) {
    allow.push("Bash(bash harness/scripts/note-valider.sh:*)", "Bash(node harness/scripts/note-index.mjs:*)");
  }
  // Clé absente d'une configuration 1.0.0 : rien n'est ajouté.
  if (config.options.mistral?.actif) {
    allow.push(
      "Bash(bash harness/scripts/mistral-securite.sh:*)", "Bash(bash harness/scripts/mistral-arbitrer.sh:*)",
      "Bash(bash harness/scripts/mistral-trancher.sh:*)", "Bash(bash harness/scripts/mistral-preflight.sh:*)",
    );
  }
  if (forge === "github") {
    allow.push("Bash(gh pr create:*)", "Bash(gh pr view:*)", "Bash(gh pr list:*)", "Bash(gh pr checks:*)", "Bash(gh run list:*)", "Bash(gh run view:*)");
  }
  const deny = [
    "Bash(gh pr merge:*)",
    ...refusDePush(config),
    "Bash(git reset --hard:*)", "Bash(git clean:*)",
    "Read(./.env)", "Read(./.env.*)", "Read(./**/.env)", "Read(./**/.env.*)",
  ];
  for (const c of config.execution.commandes_interdites) deny.push(`Bash(${c}:*)`);
  return { permissions: { allow, deny } };
}

export function verifier(reglages, config) {
  const refus = [];
  const permissions = reglages?.permissions;
  if (!permissions || typeof permissions !== "object") return ["le fichier n'a pas de bloc « permissions »"];
  const listes = { allow: permissions.allow ?? [], deny: permissions.deny ?? [], ask: permissions.ask ?? [] };
  for (const [nom, liste] of Object.entries(listes)) {
    if (!Array.isArray(liste) || liste.some((r) => typeof r !== "string")) {
      refus.push(`permissions.${nom} doit être une liste de textes`);
      listes[nom] = [];
    }
  }

  // Un refus nomme la liste et le rang (compté à partir de 0), JAMAIS le texte de la règle,
  // même tronqué : ces messages sont relus par un agent à qui on demande de ne pas ouvrir le
  // fichier, et un secret court tient dans n'importe quel extrait.

  // 1. Aucun secret, dans aucune liste.
  for (const [nom, liste] of Object.entries(listes)) {
    liste.forEach((regle, i) => {
      const motif = MOTIFS_SECRET.find(([re]) => re.test(regle));
      if (motif) refus.push(`permissions.${nom}[${i}] porte ce qui ressemble à un secret (${motif[1]})`);
      else if (sentLeJeton(regle)) refus.push(`permissions.${nom}[${i}] porte une longue suite qui ressemble à un jeton`);
    });
  }

  // 2. Ce qu'on n'autorise jamais d'avance.
  listes.allow.forEach((regle, i) => {
    const d = decouper(regle);
    const ou = `permissions.allow[${i}]`;
    if (!d) {
      refus.push(`${ou} : forme illisible (attendu Outil ou Outil(contenu))`);
      return;
    }
    if (d.outil !== "Bash") return;
    if (d.contenu === null || d.prefixe === "") {
      refus.push(`${ou} : Bash autorisé sans limite`);
      return;
    }
    const mots = d.prefixe.split(/\s+/);
    const programme = mots[0];
    if (JAMAIS.includes(programme)) refus.push(`${ou} : ${programme} ne s'autorise jamais d'avance`);
    if (TROP_LARGES.includes(programme) && mots.length === 1) refus.push(`${ou} : ${programme} sans script nommé revient à tout autoriser`);
    if (programme === "codex" || programme === "vibe") refus.push(`${ou} : le relecteur ne s'autorise jamais directement, seulement par les scripts du harness (qui forcent la lecture seule)`);
    if (programme === "git" && mots.length === 1) refus.push(`${ou} : git sans sous-commande revient à autoriser le push et le reset`);
    if (programme === "git" && mots[1] === "push" && mots.length === 2) refus.push(`${ou} : push sans destination nommée`);
    if (programme === "git" && mots[1] === "push" && mots.length > 2 && mots.filter((m) => !m.startsWith("-")).length < 4) {
      refus.push(`${ou} : push sans branche nommée (toute branche du dépôt distant serait autorisée)`);
    }
    if (programme === "gh" && mots.length < 3) refus.push(`${ou} : gh sans sous-commande précise revient à autoriser le merge`);
    for (const [re, quoi] of GESTES_INTERDITS) if (re.test(d.prefixe)) refus.push(`${ou} : ${quoi}`);
    if (config) {
      const { remote, branche_integration: integration, branche_production: production } = config.git;
      for (const b of [integration, production].filter(Boolean)) {
        if (new RegExp(`^git\\s+push\\s+(-u\\s+)?${remote}\\s+${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(d.prefixe)) {
          refus.push(`${ou} : push direct vers ${b}`);
        }
      }
    }
  });

  // 3. Les interdictions attendues sont bien là.
  if (config) {
    const interdits = listes.deny.map((r) => decouper(r)?.prefixe ?? "");
    for (const [regle, pourquoi] of interditesAttendues(config)) {
      const debut = decouper(regle).prefixe;
      if (!interdits.some((p) => p === debut)) refus.push(`permissions.deny ne porte pas « ${regle} » (${pourquoi})`);
    }
    if (!listes.deny.some((r) => /^Read\(.*\.env/.test(r))) refus.push("permissions.deny ne porte aucune interdiction de lire les fichiers .env");
  }
  return refus;
}

// appliquer : rend {refus} ou {ajouts}. N'écrit que si le résultat passe le contrôle.
export function appliquer(fichier, config) {
  let reglages = {};
  if (existsSync(fichier)) {
    try {
      reglages = JSON.parse(readFileSync(fichier, "utf8"));
    } catch (e) {
      // Pas le message de l'erreur : celui d'un JSON invalide cite le texte du fichier.
      return { refus: [`fichier illisible (${e.code ?? "JSON invalide"})`] };
    }
    if (reglages === null || typeof reglages !== "object" || Array.isArray(reglages)) return { refus: ["le fichier n'est pas un objet JSON"] };
  }
  const voulu = proposer(config).permissions;
  const permissions = { ...(reglages.permissions ?? {}) };
  const ajouts = {};
  for (const nom of ["allow", "deny"]) {
    const present = Array.isArray(permissions[nom]) ? permissions[nom] : [];
    const manquants = voulu[nom].filter((r) => !present.includes(r));
    permissions[nom] = [...present, ...manquants];
    ajouts[nom] = manquants.length;
  }
  const resultat = { ...reglages, permissions };
  const refus = verifier(resultat, config);
  if (refus.length > 0) return { refus };
  if (ajouts.allow + ajouts.deny > 0) {
    mkdirSync(dirname(fichier), { recursive: true });
    ecrireJson(fichier, resultat);
  }
  return { ajouts };
}

// Un fichier de réglages personnel créé à la main n'est pas ignoré par Git tout seul.
function estSuiviOuSuivable(fichier) {
  try {
    execFileSync("git", ["check-ignore", "-q", fichier], { cwd: trouverRacine(), stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function principal(args) {
  const [commande, fichier] = args;
  if (commande === "appliquer" && fichier) {
    const cible = resolve(fichier);
    const r = appliquer(cible, chargerConfig());
    if (r.refus) {
      console.error(`REFUS : ${fichier} n'est pas modifié\n${r.refus.map((m) => `  - ${m}`).join("\n")}`);
      return 1;
    }
    console.log(`OK : ${fichier} (${r.ajouts.allow} autorisation(s) et ${r.ajouts.deny} interdiction(s) ajoutée(s))`);
    if (/\.local\.json$/.test(fichier) && estSuiviOuSuivable(cible)) {
      console.log(`NOTE : ${fichier} n'est pas ignoré par Git. C'est un fichier personnel : l'ajouter à .gitignore.`);
    }
    return 0;
  }
  if (commande === "proposer") {
    console.log(JSON.stringify(proposer(chargerConfig()), null, 2));
    return 0;
  }
  if (commande === "verifier" && fichier) {
    let reglages;
    try {
      reglages = JSON.parse(readFileSync(fichier, "utf8"));
    } catch (e) {
      console.error(`REFUS : ${fichier} illisible (${e.code ?? "JSON invalide"})`);
      return 1;
    }
    const refus = verifier(reglages, chargerConfig());
    if (refus.length > 0) {
      console.error(`REFUS : ${fichier}\n${refus.map((r) => `  - ${r}`).join("\n")}`);
      return 1;
    }
    console.log(`OK : ${fichier} (${reglages.permissions.allow?.length ?? 0} autorisation(s), ${reglages.permissions.deny?.length ?? 0} interdiction(s))`);
    return 0;
  }
  console.error("usage : allowlist-verifier.mjs proposer | verifier <fichier.json> | appliquer <fichier.json>");
  return 2;
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
