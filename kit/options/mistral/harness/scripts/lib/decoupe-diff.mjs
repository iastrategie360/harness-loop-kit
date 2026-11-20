/**
 * decoupe-diff.mjs : decoupe un diff de branche en LOTS bornes, sans rien perdre.
 *
 * Pourquoi. Les relecteurs de l'option `mistral` recoivent le diff DANS leur prompt, et ce prompt
 * est un argument unique de `vibe -p`, que Linux borne a MAX_ARG_STRLEN = 131072 octets. Un diff
 * de story depasse couramment cette borne (un diff d'un million d'octets a ete mesure). Le
 * tronquer ferait conclure « propre » sur un prefixe : c'est le faux vert que ce module rend
 * impossible. On decoupe donc PAR FICHIER, puis par hunk, puis par groupe de lignes si un hunk
 * seul est trop gros, et chaque lot part dans une session distincte. La couverture est garantie
 * par construction : la concatenation des morceaux rend exactement le diff retenu, ce que
 * `harness/tests/mistral.test.mjs` verifie.
 *
 * Les fichiers EXCLUS (motifs fournis par l'appelant, `options.mistral.exclusions`) ne
 * disparaissent pas en silence : ils sont listes, et l'artefact de la relecture les nomme.
 *
 * Fonctions PURES, sans entree/sortie : le CLI `harness/scripts/decouper-diff.mjs` fait l'ecriture.
 */

/** Taille en octets UTF-8 (l'unite de la limite argv, pas le nombre de caracteres). */
export function octets(texte) {
  return Buffer.byteLength(String(texte ?? ""), "utf8");
}

/**
 * Decode un chemin cite par git (`"b/src/\303\251.ts"`) : echappements C et octets en octal,
 * recolles en UTF-8. Git cite tout chemin non ASCII (core.quotePath, vrai par defaut) ou portant
 * un caractere special.
 */
export function decoderCheminGit(cite) {
  const s = String(cite);
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  const corps = s.slice(1, -1);
  const octetsLus = [];
  const SIMPLES = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 0; i < corps.length; i += 1) {
    const c = corps[i];
    if (c !== "\\") {
      for (const o of Buffer.from(c, "utf8")) octetsLus.push(o);
      continue;
    }
    const suite = corps[i + 1];
    if (/[0-7]/.test(suite ?? "")) {
      octetsLus.push(parseInt(corps.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      octetsLus.push(SIMPLES[suite] ?? suite.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(octetsLus).toString("utf8");
}

/** Chemin de destination d'une ligne `diff --git`, cite ou non ; null si ce n'en est pas une. */
export function cheminEnTete(ligne) {
  const l = String(ligne).replace(/\r?\n$/, "");
  if (!l.startsWith("diff --git ")) return null;
  const reste = l.slice("diff --git ".length);
  // Forme citee (chemin non ASCII ou special) : le dernier argument est le chemin b/ cite.
  const cite = /(?:^|\s)("b\/(?:[^"\\]|\\.)*")$/.exec(reste);
  if (cite) return decoderCheminGit(cite[1]).slice(2);
  // Forme nue : `a/<p> b/<p>`. Pour un fichier non renomme les deux moities sont egales, ce qui
  // leve l'ambiguite d'un chemin contenant « b/ » ou des espaces.
  const moitie = (reste.length - 1) / 2;
  if (Number.isInteger(moitie) && reste.startsWith("a/") && reste.slice(moitie + 1).startsWith("b/")
      && reste.slice(2, moitie) === reste.slice(moitie + 3)) {
    return reste.slice(moitie + 3);
  }
  const m = /^a\/.*? b\/(.*)$/.exec(reste);
  return m ? m[1] : reste;
}

/**
 * Coupe un diff `git diff` en blocs par fichier. Chaque bloc commence a sa ligne
 * `diff --git a/... b/...` et porte le chemin de destination (celui de `b/`).
 * Un eventuel preambule avant le premier `diff --git` (rare) forme un bloc `(preambule)`.
 */
export function blocsParFichier(diff) {
  const texte = String(diff ?? "");
  if (texte === "") return [];
  const lignes = texte.split(/(?<=\n)/);
  const blocs = [];
  let courant = null;
  for (const ligne of lignes) {
    const chemin = cheminEnTete(ligne);
    if (chemin !== null) {
      if (courant) blocs.push(courant);
      courant = { fichier: chemin, texte: ligne };
      continue;
    }
    if (!courant) courant = { fichier: "(preambule)", texte: "" };
    courant.texte += ligne;
  }
  if (courant) blocs.push(courant);
  return blocs;
}

/**
 * Motif glob minimal, ancre sur le chemin entier :
 *  - `*` et `?` ne traversent pas `/` ;
 *  - `**\/` en tete ou apres un `/` vaut un prefixe de dossiers OPTIONNEL termine par `/` :
 *    `**\/test/**` couvre `test/x.js` et `a/test/x.js`, jamais `src/contest/auth.js`. Traduit en
 *    `.*`, il excluait tout chemin finissant par « test/... », et un lot vide rendait un artefact
 *    propre sans relecture : une exclusion trop large est un faux vert ;
 *  - `/**` final couvre le dossier et tout ce qu'il contient ;
 *  - un `**` ailleurs vaut n'importe quelle suite de caracteres.
 */
export function globVersRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const enDebutDeSegment = i === 0 || glob[i - 1] === "/";
      if (enDebutDeSegment && glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else if (enDebutDeSegment && i + 2 === glob.length && i > 0) {
        // `x/**` : le `/` deja ecrit devient optionnel avec ce qui suit.
        re = `${re.slice(0, -1)}(?:/.*)?`;
        i += 1;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function estExclu(fichier, exclusions = []) {
  return exclusions.some((g) => globVersRegex(g).test(fichier));
}

/**
 * Fragmente un bloc de fichier trop gros. Ordre de coupe : aux frontieres de hunk (`@@`), puis,
 * pour un hunk qui depasse seul la borne, par groupes de lignes. L'en-tete du fichier (lignes
 * avant le premier `@@`) est RECOPIE en tete de chaque fragment pour que le relecteur sache
 * toujours de quel fichier il lit la suite. Aucune ligne n'est jamais retiree.
 */
export function fragmenterBloc(bloc, max) {
  if (octets(bloc.texte) <= max) return [{ ...bloc, partie: 1, parties: 1, corps: bloc.texte }];
  const lignes = bloc.texte.split(/(?<=\n)/);
  const iPremierHunk = lignes.findIndex((l) => l.startsWith("@@"));
  const entete = iPremierHunk > 0 ? lignes.slice(0, iPremierHunk).join("") : "";
  const corps = iPremierHunk >= 0 ? lignes.slice(iPremierHunk) : lignes;
  // Marge pour l'en-tete recopie et la mention de suite.
  const budget = Math.max(1024, max - octets(entete) - 200);

  // Tailles tenues a la main : recalculer celle du tampon a chaque ligne serait quadratique
  // sur un fichier de plusieurs centaines de Ko.
  const morceaux = [];
  let tampon = "";
  let tailleTampon = 0;
  const pousser = () => {
    if (tampon !== "") morceaux.push(tampon);
    tampon = "";
    tailleTampon = 0;
  };
  for (const ligne of corps) {
    const t = octets(ligne);
    if (tailleTampon + t > budget) pousser();
    // Une ligne seule plus grosse que le budget (fichier minifie) : on la coupe en tranches,
    // la troncature n'etant jamais une option. Coupe aux frontieres de CARACTERE (jamais au
    // milieu d'une sequence UTF-8 multi-octets, qui corromprait le texte recolle).
    if (t > budget) {
      let tranche = "";
      let tailleTranche = 0;
      for (const car of ligne) {
        const tc = octets(car);
        if (tailleTranche + tc > budget) {
          morceaux.push(tranche);
          tranche = "";
          tailleTranche = 0;
        }
        tranche += car;
        tailleTranche += tc;
      }
      if (tranche !== "") morceaux.push(tranche);
      continue;
    }
    tampon += ligne;
    tailleTampon += t;
  }
  pousser();
  return morceaux.map((m, i) => ({
    fichier: bloc.fichier,
    partie: i + 1,
    parties: morceaux.length,
    // `corps` = la part ORIGINALE du diff (sert au controle de couverture) ;
    // `texte` = ce qui est montre au relecteur (en-tete recopie + mention de suite).
    corps: i === 0 ? entete + m : m,
    texte:
      i === 0
        ? entete + m
        : `${entete}[suite du diff de ${bloc.fichier}, partie ${i + 1}/${morceaux.length}]\n${m}`,
  }));
}

/**
 * Decoupe un diff en lots d'au plus `max` octets.
 * @param {string} diff
 * @param {{max?: number, exclusions?: string[]}} [options]
 * @returns {{lots: {index:number, fichiers:string[], texte:string, corps:string, octets:number}[], exclus:string[], fichiers:string[]}}
 */
export function decouperDiff(diff, { max = 90000, exclusions = [] } = {}) {
  if (!Number.isFinite(max) || max < 4096) throw new Error(`borne de lot invalide : ${max}`);
  const exclus = [];
  const retenus = [];
  for (const b of blocsParFichier(diff)) {
    if (estExclu(b.fichier, exclusions)) exclus.push(b.fichier);
    else retenus.push(b);
  }
  const fragments = retenus.flatMap((b) => fragmenterBloc(b, max));
  const lots = [];
  let courant = null;
  for (const f of fragments) {
    const t = octets(f.texte);
    if (!courant || courant.octets + t > max) {
      courant = { index: lots.length + 1, fichiers: [], texte: "", octets: 0, corps: "" };
      lots.push(courant);
    }
    courant.texte += f.texte;
    courant.corps += f.corps;
    courant.octets += t;
    const etiquette = f.parties > 1 ? `${f.fichier} (partie ${f.partie}/${f.parties})` : f.fichier;
    courant.fichiers.push(etiquette);
  }
  return {
    lots: lots.map(({ corps, ...l }) => ({ ...l, corps })),
    exclus,
    fichiers: retenus.map((b) => b.fichier),
  };
}
