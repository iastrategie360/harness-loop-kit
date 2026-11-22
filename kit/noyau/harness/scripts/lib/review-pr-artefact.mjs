/**
 * review-pr-artefact.mjs : le coeur de la review de PR LOCALE.
 *
 * La review d'une PR est faite par le CLI du relecteur, sur la machine. Sa tracabilite ne vit
 * pas dans les fils de discussion d'une forge : elle vit dans un ARTEFACT COMMITE sur la branche
 * (`<specs>/<id>/review-pr.json`, source de verite machine, + `review-pr.md` genere pour la
 * lecture humaine dans la PR).
 *
 * Ce fichier ne contient que des FONCTIONS PURES (aucune entree/sortie disque, aucun appel
 * git) : c'est ce qui permet de les eprouver sans consommer de quota ni monter un depot de
 * test. Les effets de bord vivent dans `review-pr-fusionner.mjs` (ecriture) et
 * `review-locale.mjs` (lecture + gate), qui appellent ces fonctions.
 */

/** Version du format de l'artefact. A incrementer si la forme change de facon incompatible. */
export const VERSION_ARTEFACT = 1;

/**
 * Statuts de traitement d'un finding. Le flux local abandonne l'appariement par MOT-CLE
 * (sous-chaine dans une prose libre), qui ferme des fils par accident : ici la
 * gate lit un CHAMP ENUMERE, jamais du texte. La prose (locution d'arbitrage de valeur, motif
 * de refutation) vit dans `note`, purement narrative, et n'a aucun effet sur la gate.
 */
export const STATUTS = [
  "corrige",
  "refute",
  "faux_positif",
  "perime",
  "differe_valeur",
  "ecarte_valeur",
];

/**
 * Severites qui BLOQUENT la gate tant qu'elles n'ont pas de statut.
 *
 * `P?` (severite que le parseur n'a pas su lire, ex. un champ `priority` renomme ou absent dans
 * une sortie structuree) en fait PARTIE, volontairement : un finding que Codex a bel et bien
 * emis mais qu'on n'a pas su classer doit etre REGARDE, pas ignore. Le laisser hors de la liste
 * le faisait disparaitre de la gate en silence, et une review pouvait rendre 0 tout en portant
 * un finding non classifie. Seul `P3`, explicitement
 * mineur, ne bloque pas.
 */
export const SEVERITES_BLOQUANTES = ["P0", "P1", "P2", "P?"];

/**
 * Slug stable : minuscules, accents retires, tout caractere non alphanumerique replie sur un
 * tiret. Sert a fabriquer la cle d'un finding.
 */
function slug(texte) {
  return String(texte ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Cle d'identite d'un finding : FICHIER + TITRE normalise, JAMAIS la ligne.
 *
 * C'est la meme regle que le ledger du stage CODE, et pour la meme raison : les
 * numeros de ligne bougent a chaque correctif voisin. Une cle qui contiendrait la ligne ferait
 * apparaitre le meme defaut comme un finding NEUF a chaque round, ce qui rendrait la mesure de
 * persistance (et donc l'escalade) impossible.
 */
export function cleFinding(fichier, titre) {
  return `${slug(fichier)}--${slug(titre)}`;
}

/**
 * Normalise une severite quelconque en P0..P3, `P?` si illisible.
 *
 * Trois ecritures sont lues, dans cet ordre : `P1` (ou `p1`), le NOMBRE 0 a 3 que rend le
 * format structure par defaut du relecteur, et a defaut le prefixe `[P1]` que ce meme format
 * place en tete du titre. Tout le reste donne `P?`, qui bloque : une severite qu'on ne sait pas
 * lire n'est jamais rangee d'office parmi les mineures.
 */
function normaliserSeverite(valeur, titre = "") {
  const texte = String(valeur ?? "").trim();
  const lettre = /P([0-3])/i.exec(texte);
  if (lettre) return `P${lettre[1]}`;
  if (/^[0-3]$/.test(texte)) return `P${texte}`;
  const prefixe = PREFIXE_SEVERITE.exec(String(titre ?? ""));
  return prefixe ? `P${prefixe[1]}` : "P?";
}

// Le prefixe de severite que le format par defaut du relecteur pose en tete de titre.
const PREFIXE_SEVERITE = /^\s*\[P([0-3])\]\s*/i;

/** Rend un chemin relatif a la racine du depot (le CLI rend parfois un chemin absolu). */
function cheminRelatif(fichier, racine) {
  const brut = String(fichier ?? "").trim();
  if (!racine) return brut;
  const prefixe = racine.endsWith("/") ? racine : `${racine}/`;
  return brut.startsWith(prefixe) ? brut.slice(prefixe.length) : brut;
}

/**
 * Extraction des findings depuis la sortie du CLI, en TROIS niveaux de repli.
 *
 * Pourquoi trois : `codex exec review` peut honorer `--output-schema` (niveau 1), sinon les
 * findings structures transitent dans le flux JSONL de `--json` (niveau 2), sinon il ne reste
 * que le markdown de la review par defaut (niveau 3). Coder les trois d'emblee evite que la
 * chaine casse silencieusement le jour ou le CLI change de comportement : le niveau reellement
 * utilise est trace dans l'artefact (`extraction`), donc une derive se voit.
 *
 * `exploitable` dit si la sortie atteste d'une review REELLEMENT menee : c'est ce que l'appelant
 * lit pour refuser d'ecrire un artefact (fail-closed) plutot que de prendre une sortie illisible
 * pour une review propre. Quand elle ne l'est pas, `motif` dit pourquoi en une phrase.
 *
 * REGLE DU ZERO FINDING, valable a tous les niveaux : une sortie sans finding n'est tenue pour
 * une review propre que si le flux d'evenements PROUVE le travail (cf. `preuvesDuFlux`). Une
 * liste structuree vide en est une forme comme une autre : un relecteur qui n'a rien pu lire
 * peut la rendre aussi bien qu'une phrase.
 *
 * @returns {{findings: Array, synthese: string, extraction: "schema"|"jsonl"|"markdown"|"vide", exploitable: boolean, motif: string}}
 */
export function parseSortieCodex(brut, jsonl, racine = "", preuvesImposees = null) {
  // Une reponse STRUCTUREE qu'on ne sait pas lire en entier n'est pas une review propre, et ce
  // n'est pas de la prose non plus : on ne retombe pas sur le niveau suivant, on refuse.
  const illisible = (niveau) => ({
    findings: [],
    synthese: String(brut ?? "").trim(),
    extraction: niveau,
    exploitable: false,
    motif: "la reponse structuree porte un element qu'on ne sait pas lire comme un finding",
  });
  // Un producteur sans flux d'evenements (la relecture securite de l'option `mistral`) apporte
  // ses propres preuves, tirees de son attestation (cf. `preuvesDeLAttestation`). Sans elles, on
  // retombe sur le flux : rien n'est jamais tenu pour acquis par defaut.
  const preuves = preuvesImposees ?? preuvesDuFlux(jsonl);
  const structure = (resultat, niveau) => {
    const manque = resultat.findings.length === 0 ? preuveManquante(preuves) : "";
    return { ...resultat, extraction: niveau, exploitable: manque === "", motif: manque };
  };

  // Niveau 1 : le dernier message est le JSON conforme au schema demande.
  const parSchema = parseNiveauSchema(brut, racine);
  if (parSchema === ILLISIBLE) return illisible("schema");
  if (parSchema) return structure(parSchema, "schema");

  // Niveau 2 : le flux JSONL porte un evenement final avec des findings structures.
  const parJsonl = parseNiveauJsonl(jsonl, racine);
  if (parJsonl === ILLISIBLE) return illisible("jsonl");
  if (parJsonl) return structure(parJsonl, "jsonl");

  // Niveau 3 : le markdown de la review par defaut.
  const parMarkdown = parseNiveauMarkdown(brut, racine);
  if (parMarkdown === ILLISIBLE) return illisible("markdown");
  if (parMarkdown) return { ...parMarkdown, extraction: "markdown", exploitable: true, motif: "" };

  // Aucune structure reconnue et aucun finding. Trois choses se ressemblent ici : une review
  // reellement PROPRE (prose sans finding, cas legitime et frequent), une sortie tronquee, et un
  // message d'echec. Aucun marqueur ne permet de les distinguer de facon fiable, et une premiere
  // tentative de le faire par mots-cles a laisse passer les deux derniers cas.
  //
  // On cesse donc de PARIER sur la nature de la prose, et on rend l'inference dangereuse
  // IMPOSSIBLE : ce niveau ne conclut jamais qu'un finding est resolu. C'est `fusionner` qui
  // applique la regle (l'auto-cloture exige une extraction STRUCTUREE, cf. son commentaire),
  // donc une prose inconnue ne peut plus fermer quoi que ce soit, quelle qu'elle soit.
  //
  // Reste a decider si cette prose atteste d'une review REELLEMENT MENEE. Deux garde-fous, dont
  // le second est une PREUVE POSITIVE et non une devinette sur le texte :
  //
  //  1. un texte qui ANNONCE des findings sans qu'aucun soit extractible signale un parseur qui
  //     ne sait plus lire son format ;
  //  2. surtout, on exige les deux preuves du flux `--json` (cf. `preuvesDuFlux`). Sans elles,
  //     une PREMIERE review (aucun artefact anterieur) rendant une prose d'echec avec un code de
  //     sortie 0 produirait un artefact a zero finding et la gate certifierait la PR sans
  //     qu'aucune review n'ait eu lieu.
  const texte = String(brut ?? "").trim();
  // La cle `"findings":` dans une prose : du JSON entoure d'une phrase ou d'une cloture de code,
  // que le niveau 1 n'a donc pas reconnu.
  const sentSaFindings = /full review comments|\[P[0-3]\]|"findings"\s*:/i.test(texte);
  let motif = "";
  if (texte.length === 0) motif = "la sortie est vide";
  else if (sentSaFindings) motif = "le texte annonce des findings que le parseur ne sait pas lire";
  else motif = preuveManquante(preuves);
  return { findings: [], synthese: texte, extraction: "vide", exploitable: motif === "", motif };
}

/**
 * Ce que le flux d'evenements du CLI PROUVE, sans rien deviner du texte rendu :
 *
 *  - `tourAcheve` : la marque de fin de tour (`turn.completed`). Une troncature ou un abandon en
 *    cours de route n'en portent pas ;
 *  - `commandeReussie` : au moins une commande que le relecteur a lancee dans le depot s'est
 *    terminee par un code 0 (`item.completed` de type `command_execution`).
 *
 * Pourquoi la seconde : la fin de tour dit que le relecteur a FINI de repondre, pas qu'il a LU.
 * Un refus poli (« je n'ai pas pu lire le depot ») finit son tour comme une review. Or une
 * review se fait en lisant le diff, donc en lancant des commandes : les flux reels releves
 * avant d'ecrire cette regle en portaient tous au moins une reussie, review propre comprise.
 *
 * Limite connue : un relecteur qui lit le depot PUIS refuse de conclure passe encore pour
 * propre. La regle ferme le refus sans lecture, elle ne juge pas la qualite de la lecture.
 * Absence de flux = on ne peut rien prouver, donc rien n'est tenu pour acquis (fail-closed).
 */
function preuvesDuFlux(jsonl) {
  const preuves = { tourAcheve: false, commandeReussie: false };
  if (!jsonl) return preuves;
  for (const ligne of String(jsonl).split("\n")) {
    const t = ligne.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue; // ligne illisible : sans effet, on continue de chercher.
    }
    if (ev?.type === "turn.completed") preuves.tourAcheve = true;
    if (ev?.type === "item.completed" && ev.item?.type === "command_execution" && ev.item.exit_code === 0) {
      preuves.commandeReussie = true;
    }
  }
  return preuves;
}

/** La preuve qui manque pour croire un zero finding, en une phrase ; chaine vide si rien ne manque. */
function preuveManquante(preuves) {
  if (!preuves.tourAcheve) return "le flux ne porte pas la marque de fin de tour : reponse tronquee ou abandonnee";
  if (!preuves.commandeReussie) {
    return "aucune commande reussie dans le flux : rien ne prouve que le relecteur a lu le depot";
  }
  return "";
}

/**
 * Les preuves d'une relecture DECOUPEE EN LOTS, tirees de l'attestation que son producteur ecrit
 * apres avoir valide chaque lot (option `mistral`, `mistral-securite.sh`).
 *
 * Un tel relecteur n'a pas de flux d'evenements : la preuve d'une relecture menee au bout est que
 * CHAQUE lot a rendu une reponse conforme au schema. Une attestation partielle (un lot de moins
 * que prevu) ne prouve rien : une relecture a laquelle manque un lot n'est pas une relecture.
 * Zero lot n'est recevable que si le diff etait entierement exclu, et que l'attestation nomme les
 * fichiers exclus : c'est la seule facon d'arriver la sans avoir rien lu par erreur.
 *
 * @returns {{preuves: object|null, motif: string}} `preuves` a null quand l'attestation ne prouve rien
 */
export function preuvesDeLAttestation(attestation) {
  const refus = (motif) => ({ preuves: null, motif });
  if (attestation === null || typeof attestation !== "object" || Array.isArray(attestation)) {
    return refus("attestation absente ou illisible");
  }
  const { lots_total: total, lots_relus: relus, exclus = [], fichiers = [] } = attestation;
  if (!Number.isInteger(total) || !Number.isInteger(relus) || total < 0 || relus < 0) {
    return refus("attestation sans compte de lots entier");
  }
  if (!Array.isArray(exclus) || !Array.isArray(fichiers)) return refus("attestation sans liste de fichiers");
  if (relus !== total) return refus(`${relus} lot(s) relu(s) sur ${total} : une relecture a laquelle manque un lot n'en est pas une`);
  if (total === 0 && (exclus.length === 0 || fichiers.length > 0)) {
    return refus("zero lot relu sans que le diff soit entierement exclu");
  }
  return { preuves: { tourAcheve: true, commandeReussie: true }, motif: "" };
}

// Ce que rend un niveau structure quand il reconnait sa forme mais ne sait pas la lire en entier.
const ILLISIBLE = Symbol("illisible");

/**
 * Rend la liste normalisee, ou `null` des qu'un element n'est pas un finding lisible.
 *
 * Pourquoi `null` et pas un filtre : un finding sans titre ni fichier etait ecarte en silence,
 * et il restait une liste VIDE, donc une review « propre » alors que le relecteur avait signale
 * un defaut. Un finding qu'on ne sait pas lire n'est pas un finding absent : c'est toute la
 * sortie qui devient non exploitable. Un finding sans titre mais avec un corps garde sa place,
 * la premiere ligne du corps lui sert de titre.
 */
function normaliserListe(liste, racine) {
  const rendus = [];
  for (const f of liste) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) return null;
    const corps = String(f.body ?? f.corps ?? f.description ?? "").trim();
    // Deux formes : celle du schema demande (`file`, `line_start`, `line_end`) et celle que le
    // relecteur rend par defaut (`code_location.absolute_file_path`, `code_location.line_range`).
    // Lire la seconde compte autant que la premiere : sans le fichier, deux findings de meme
    // titre dans deux fichiers partagent une seule cle et l'un des deux disparait.
    const lieu = f.code_location !== null && typeof f.code_location === "object" ? f.code_location : {};
    const plage = lieu.line_range !== null && typeof lieu.line_range === "object" ? lieu.line_range : {};
    const file = cheminRelatif(f.file ?? f.path ?? lieu.absolute_file_path ?? lieu.file ?? "", racine);
    const titreBrut = String(f.title ?? f.titre ?? "").trim();
    // Le prefixe `[P1]` sert a lire la severite, puis il sort du titre : la cle d'un finding ne
    // doit pas changer selon que le relecteur a repondu en prose ou en structure.
    let titre = titreBrut.replace(PREFIXE_SEVERITE, "").trim();
    if (titre === "" && corps !== "") titre = corps.split("\n")[0].trim().slice(0, 120);
    if (titre === "" && file === "") return null;
    const debut = Number(f.line_start ?? f.lineStart ?? f.line ?? plage.start ?? 0) || 0;
    rendus.push({
      severity: normaliserSeverite(f.priority ?? f.severity, titreBrut),
      file,
      lines: [debut, Number(f.line_end ?? f.lineEnd ?? plage.end ?? 0) || debut],
      titre,
      corps,
    });
  }
  return rendus;
}

function parseNiveauSchema(brut, racine) {
  const texte = String(brut ?? "").trim();
  if (!texte.startsWith("{")) return null;
  let objet;
  try {
    objet = JSON.parse(texte);
  } catch {
    // Une reponse qui COMMENCE comme du JSON et ne se lit pas (tronquee, mal fermee) n'est pas
    // de la prose : la laisser descendre au dernier niveau en ferait une review sans finding.
    return ILLISIBLE;
  }
  // Un objet JSON qui n'a pas la forme demandee (pas de liste `findings`, ou un finding qu'on ne
  // sait pas lire) ne doit pas finir en « prose sans finding » au dernier niveau.
  if (!Array.isArray(objet?.findings)) return ILLISIBLE;
  const findings = normaliserListe(objet.findings, racine);
  if (findings === null) return ILLISIBLE;
  return { findings, synthese: String(objet.overall_explanation ?? "").trim() };
}

function parseNiveauJsonl(jsonl, racine) {
  if (!jsonl) return null;
  let trouve = null;
  let illisible = false;
  for (const ligne of String(jsonl).split("\n")) {
    const t = ligne.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    // On cherche, a n'importe quelle profondeur raisonnable, un objet portant `findings`.
    const candidat = ev?.findings ? ev : (ev?.msg?.findings ? ev.msg : null);
    if (candidat && Array.isArray(candidat.findings)) {
      const findings = normaliserListe(candidat.findings, racine);
      if (findings === null) {
        illisible = true;
        continue;
      }
      trouve = {
        findings,
        synthese: String(
          candidat.overall_explanation ?? candidat.explanation ?? ev?.msg?.overall_explanation ?? "",
        ).trim(),
      };
    }
  }
  return illisible ? ILLISIBLE : trouve;
}

/**
 * Niveau 3 : le markdown de la review par defaut. Forme observee (le separateur entre le titre
 * et la localisation est un tiret long PRODUIT PAR LE RELECTEUR : c'est de la DONNEE a
 * reconnaitre, ecrite ici et dans la regex par son code Unicode, U+2014 ou U+2013) :
 *   - [P2] Titre du finding <U+2014> /chemin/absolu/fichier.ext:120-134
 *     Explication en prose, possiblement sur plusieurs lignes indentees.
 *
 * Le marqueur `[Px]` est cherche en TETE de ligne (ancre), jamais n'importe ou dans le texte :
 * une severite citee au fil d'une phrase ne doit pas creer un finding fantome.
 *
 * Une sortie lue A MOITIE est pire qu'une sortie illisible : le finding non reconnu part dans
 * le corps du precedent, et la fusion ferme par absence celui qu'il re-signalait. D'ou deux
 * regles : la severite entre crochets en tete de ligne vaut finding meme sans puce, et la meme
 * severite derriere une marque inconnue fait refuser toute la sortie (`ILLISIBLE`).
 */
function parseNiveauMarkdown(brut, racine) {
  const texte = String(brut ?? "");
  const lignes = texte.split("\n");
  const findings = [];
  let courant = null;

  // Une puce puis la severite, ou la severite ENTRE CROCHETS seule en tete de ligne.
  const enTete = /^\s*(?:(?:[-*>#]+|\d+[.)])\s*(?:\*\*\s*)?\[?(P[0-3])\]?|(?:\*\*\s*)?\[(P[0-3])\])\s*(?:\*\*)?\s*(.*)$/;
  // La severite entre crochets en tete de ligne, derriere autre chose (une puce qu'on ne
  // connait pas, une cellule de tableau).
  const marqueInconnue = /^[^\p{L}\p{N}[]*(?:\d+[.)])?[^\p{L}\p{N}[]*\[P[0-3]\]/u;

  for (const ligne of lignes) {
    const m = enTete.exec(ligne);
    if (!m && marqueInconnue.test(ligne)) return ILLISIBLE;
    if (m) {
      if (courant) findings.push(courant);
      const reste = m[3] ?? "";
      // Separateur titre / localisation : tiret long (U+2014), tiret moyen (U+2013) ou " - ".
      const sep = reste.split(/\s+[\u2014\u2013-]\s+/);
      const titre = (sep[0] ?? "").replace(/\*\*/g, "").trim();
      const localisation = sep.length > 1 ? sep[sep.length - 1].trim() : "";
      const loc = /^(.*?):(\d+)(?:-(\d+))?\s*$/.exec(localisation);
      courant = {
        severity: normaliserSeverite(m[1] ?? m[2]),
        file: cheminRelatif(loc ? loc[1] : localisation, racine),
        lines: loc ? [Number(loc[2]), Number(loc[3] ?? loc[2])] : [0, 0],
        titre,
        corps: "",
      };
      continue;
    }
    if (courant) {
      const suite = ligne.trim();
      if (suite) courant.corps = courant.corps ? `${courant.corps}\n${suite}` : suite;
    }
  }
  if (courant) findings.push(courant);
  if (findings.length === 0) return null;

  // La synthese est ce qui precede la premiere puce de finding.
  const idx = texte.search(enTete.source ? new RegExp(enTete, "m") : /$^/);
  const synthese = idx > 0 ? texte.slice(0, idx).trim() : "";
  return { findings, synthese };
}

/** Artefact vierge, pour une premiere review. */
export function artefactVierge(branche, base) {
  return {
    version: VERSION_ARTEFACT,
    branche,
    base,
    head_sha: null,
    date: null,
    modele: null,
    rounds: 0,
    reviews: [],
    findings: {},
    synthese: { verdict: "", open_p0_p2: 0 },
  };
}

/**
 * Fusionne une nouvelle review dans l'artefact existant. C'est le coeur de la mecanique : la
 * fusion est ce qui donne au flux local ce que les fils d'une forge donnent gratuitement, a
 * savoir la MEMOIRE d'un finding entre deux rounds (statut deja pose, persistance).
 *
 * Cinq cas, chacun paye par une propriete qu'on veut garantir :
 *  1. finding NEUF -> ajoute, statut null (il bloque la gate tant qu'il n'est pas traite) ;
 *  2. re-signale SANS statut -> rafraichi ; `survived++` UNIQUEMENT si le head_sha a change
 *     depuis la derniere review. Sans cette condition, relancer deux fois la review sur le
 *     MEME commit gonflerait la persistance et declencherait une escalade imaginaire ;
 *  3. ABSENT de la re-review alors qu'il n'avait pas de statut -> `corrige` (auto) : le
 *     correctif a porte. On ne SUPPRIME jamais l'entree, la trace reste dans l'artefact ;
 *  4. re-signale alors qu'il etait `corrige` -> REOUVERTURE : le statut est efface (il bloque
 *     donc a nouveau la gate), `survived++`, et l'evenement est trace. C'est le cas qui
 *     empeche un faux "corrige" de tenir ;
 *  5. re-signale avec un statut DELIBERE (refute, faux_positif, perime, differe_valeur,
 *     ecarte_valeur) -> statut CONSERVE. Un arbitrage rendu ne se rejoue pas a chaque round ;
 *     le reveil d'un differe reste un geste du superviseur (test du declencheur).
 */
// Rang de gravite pour departager deux findings de meme cle. Une severite illisible bloque :
// elle se range avec les P2, jamais derriere un mineur.
const RANG_SEVERITE = { P0: 0, P1: 1, "P?": 2, P2: 2, P3: 3 };

/**
 * Une review peut rendre deux findings de meme cle (meme fichier, titres qui se normalisent
 * pareil, ou coupes a la meme longueur). Le dernier lu ecrasait le premier : un P1 suivi d'un
 * P3 laissait un P3, et la gate s'ouvrait. On garde le plus grave, une seule fois par review
 * (deux passages feraient aussi monter deux fois la persistance).
 */
function plusGravesParCle(nouveaux) {
  const parCle = new Map();
  for (const nf of nouveaux) {
    const cle = cleDuNouveau(nf);
    const deja = parCle.get(cle);
    if (!deja || (RANG_SEVERITE[nf.severity] ?? 2) < (RANG_SEVERITE[deja.severity] ?? 2)) parCle.set(cle, nf);
  }
  return [...parCle.values()];
}

/**
 * La cle sous laquelle un finding rendu par la review entre dans l'artefact. C'est TOUJOURS
 * fichier + titre, sauf quand l'option `jev` (1.2.0) a reconnu la reformulation d'un finding
 * connu et non tranche : elle pose alors `cle` sur le finding, celle du connu, avec la trace du
 * rattachement (`rattachement`). Sans l'option, aucun finding ne porte `cle` : la fusion est
 * celle de 1.1.0.
 */
function cleDuNouveau(nf) {
  return typeof nf.cle === "string" && nf.cle !== "" ? nf.cle : cleFinding(nf.file, nf.titre);
}

export function fusionner(ancien, nouveaux, contexte) {
  const { headSha, date, modele, synthese = "", extraction = "schema" } = contexte;
  const artefact = ancien
    ? { ...ancien, findings: { ...(ancien.findings ?? {}) } }
    : artefactVierge(contexte.branche, contexte.base);

  const shaPrecedent = artefact.head_sha ?? null;
  const commitChange = shaPrecedent !== headSha;
  const vus = new Set();

  for (const nf of plusGravesParCle(nouveaux)) {
    const cle = cleDuNouveau(nf);
    vus.add(cle);
    const existant = artefact.findings[cle];

    if (!existant) {
      // Cas 1 : neuf.
      artefact.findings[cle] = {
        severity: nf.severity,
        file: nf.file,
        lines: nf.lines,
        titre: nf.titre,
        corps: nf.corps,
        first_seen_sha: headSha,
        last_seen_sha: headSha,
        survived: 0,
        statut: null,
        note: null,
        date_statut: null,
        auto: false,
        escalation: null,
        reouvertures: [],
        // Option jev : un doublon PROBABLE d'un finding tranche, ou un cas douteux. Le finding
        // reste neuf et bloquant ; la trace dit au superviseur ce qu'il doit confirmer.
        ...(nf.signalements?.length ? { signalements: nf.signalements } : {}),
      };
      continue;
    }

    const maj = {
      ...existant,
      severity: nf.severity,
      lines: nf.lines,
      corps: nf.corps,
      last_seen_sha: headSha,
    };

    if (!statutTraite(existant.statut)) {
      // Cas 2 : toujours ouvert. La persistance ne compte que sur un commit different.
      if (commitChange) maj.survived = (existant.survived ?? 0) + 1;
    } else if (existant.statut === "corrige") {
      // Cas 4 : reouverture.
      maj.statut = null;
      maj.note = null;
      maj.date_statut = null;
      maj.auto = false;
      maj.survived = (existant.survived ?? 0) + 1;
      maj.reouvertures = [
        ...(existant.reouvertures ?? []),
        { date, head_sha: headSha, motif: "re-signalé après avoir été tenu pour corrigé" },
      ];
    }
    // Cas 5 : statut delibere -> rien a faire, il est conserve tel quel.

    // Option jev : la reformulation rattachee laisse sa trace sur le finding connu, avec ce
    // qu'elle a ajoute a la persistance, pour qu'un humain puisse la defaire (jev-defaire.mjs).
    if (nf.rattachement) {
      maj.rattachements = [
        ...(existant.rattachements ?? []),
        { ...nf.rattachement, survived_ajoute: (maj.survived ?? 0) - (existant.survived ?? 0) },
      ];
    }
    if (nf.signalements?.length) maj.signalements = [...(existant.signalements ?? []), ...nf.signalements];

    artefact.findings[cle] = maj;
  }

  // Cas 3 : ceux qui ont disparu de la review alors qu'ils etaient encore ouverts.
  //
  // L'auto-cloture n'a lieu QUE si la sortie du CLI a ete positivement RECONNUE comme une
  // structure de review (`schema`, `jsonl`, ou markdown dont on a su extraire des findings).
  // Autrement dit : « ce finding est absent d'une review que j'ai su lire » est une preuve ;
  // « ce finding est absent d'une prose que je n'ai pas su interpreter » n'en est PAS une.
  //
  // Sans cette condition, n'importe quelle prose (message d'echec du CLI, sortie tronquee,
  // format qui derive) fermerait AUTOMATIQUEMENT tous les findings ouverts et ouvrirait la gate
  // sans review valable : le faux vert le plus grave de cette chaine. On ne cherche donc plus a reconnaitre la mauvaise prose (c'est
  // indecidable), on rend l'inference impossible quand la preuve manque.
  //
  // Consequence assumee : apres une review PROPRE (prose, zero finding), les findings encore
  // ouverts ne se ferment PAS tout seuls. Le superviseur pose leur statut, ce qui est de toute
  // facon le geste que la procedure demande (dire `corrige` est une affirmation dont on repond,
  // pas une deduction tiree d'une absence).
  const extractionStructuree = extraction === "schema" || extraction === "jsonl" || extraction === "markdown";
  if (extractionStructuree) {
    for (const [cle, f] of Object.entries(artefact.findings)) {
      if (vus.has(cle)) continue;
      if (!statutTraite(f.statut)) {
        artefact.findings[cle] = {
          ...f,
          statut: "corrige",
          note: `absent de la re-review de ${String(headSha).slice(0, 7)}`,
          date_statut: date,
          auto: true,
        };
      }
    }
  }

  artefact.head_sha = headSha;
  artefact.date = date;
  artefact.modele = modele;
  // Source de l'artefact : absente pour la review de code, `securite` pour la relecture securite
  // de l'option `mistral`. Elle ne sert qu'au rendu : la gate lit chaque artefact par son CHEMIN.
  if (contexte.source) artefact.source = contexte.source;
  // Note portee PAR l'artefact, a l'attention de tout relecteur (humain ou reviewer automatique).
  // L'artefact fait partie du diff de la branche : chaque review le relit et constate que son
  // `head_sha` est en retard sur HEAD, puisque le commit qui enregistre une review vient
  // forcement APRES le commit qu'elle a reviewe. Un relecteur le signale volontiers comme un
  // defaut ; c'est le fonctionnement voulu, deja gere par la gate. On l'ecrit ici plutot que de
  // le refuter a chaque round, sur chaque story.
  artefact._lecture = {
    head_sha:
      "Commit reviewe par la DERNIERE review enregistree. Il est normalement en retard sur le " +
      "HEAD de la branche : le commit qui enregistre une review suit celui qu'elle a examine. " +
      "Ce n'est pas un defaut. La gate (harness/scripts/review-locale.mjs) tranche : elle rend 3 si du " +
      "CODE a change depuis, et tolere les commits qui ne touchent que l'artefact ou les " +
      "documents narratifs de gestion de la story.",
    statut:
      "Un finding P0-P2 ne cesse de bloquer que si `statut` vaut l'une des valeurs documentees " +
      "(corrige, refute, faux_positif, perime, differe_valeur, ecarte_valeur). Toute autre " +
      "valeur, y compris une coquille, laisse le finding bloquant.",
  };
  artefact.reviews = [
    ...(artefact.reviews ?? []),
    {
      date,
      head_sha: headSha,
      resultat: nouveaux.length > 0 ? "findings" : "propre",
      extraction,
    },
  ];
  artefact.synthese = { verdict: synthese, open_p0_p2: compterOuverts(artefact) };
  // `rounds` compte les runs qui ont laisse au moins un bloquant non traite : c'est le nombre
  // que l'echelle d'escalade compare a son seuil.
  if (artefact.synthese.open_p0_p2 > 0) artefact.rounds = (artefact.rounds ?? 0) + 1;
  return artefact;
}

/**
 * Un finding est TRAITE seulement si son statut appartient a l'enumeration documentee.
 *
 * L'artefact est un fichier COMMITE, donc edite a la main par le superviseur : une coquille
 * (`corrgie`), un statut invente (`fixed`) ou un copier-coller malheureux ne doivent PAS retirer
 * un finding bloquant de la gate. Toute valeur inconnue est traitee comme NON traitee : c'est le
 * sens fail-closed, et il rend l'erreur visible (le finding reste affiche comme ouvert) au lieu
 * de la rendre silencieuse.
 */
export function statutTraite(statut) {
  return typeof statut === "string" && STATUTS.includes(statut);
}

/** Findings bloquants (P0-P2) dont le statut est absent OU non reconnu. */
export function findingsOuverts(artefact) {
  return Object.entries(artefact?.findings ?? {})
    .filter(([, f]) => SEVERITES_BLOQUANTES.includes(f.severity))
    .filter(([, f]) => !statutTraite(f.statut))
    .map(([cle, f]) => ({ cle, ...f }));
}

function compterOuverts(artefact) {
  return findingsOuverts(artefact).length;
}

/**
 * La gate. Rend le code de sortie ET son motif.
 *
 *   3 = pas de review exploitable : artefact absent, illisible, ou PERIME (du code a change
 *       depuis la review). C'est l'equivalent de "review absente/en cours" de l'ancien flux ;
 *   2 = au moins un P0-P2 sans statut : la boucle correctrice doit tourner ;
 *   0 = tout est traite.
 *
 * REGLE DES COMMITS ARTEFACT-SEULS. L'artefact est commite sur la branche, donc l'acte meme
 * d'enregistrer une review deplace le HEAD et rendrait la review perimee : la gate ne pourrait
 * JAMAIS passer. On considere donc l'artefact encore frais si les seuls fichiers modifies
 * depuis `head_sha` sont ceux de l'artefact lui-meme. Le diff est INJECTE par l'appelant
 * (`fichiersDiff`), ce qui garde cette fonction pure et eprouvable sans depot.
 *
 * `gestion` dit ou vivent les documents de gestion de la story : `{ etat, specs, narratifs }`
 * (les valeurs de `chemins.etat`, `chemins.specs` et `chemins.narratifs` de la configuration).
 * Absent, AUCUN document de gestion n'est tolere : seul l'artefact l'est.
 */
export function calculerExit(artefact, headActuel, fichiersDiff = [], cheminsArtefact = [], gestion = null) {
  if (!artefact || typeof artefact !== "object") {
    return { code: 3, motif: "artefact de review absent ou illisible" };
  }
  // L'artefact est edite A LA MAIN pendant la resolution : une edition malheureuse peut lui
  // donner une forme `findings` valide au sens JavaScript mais depourvue de sens ici (un
  // tableau `[]`, une chaine, `null`). `Object.entries` n'y trouverait alors aucun bloquant et
  // la gate rendrait 0 : une PR certifiee par une COQUILLE. On exige donc la forme reelle
  // (objet simple indexe par cle) avant tout jugement.
  const f = artefact.findings;
  const formeValide =
    f !== null && typeof f === "object" && !Array.isArray(f) && Object.getPrototypeOf(f) !== null;
  if (!formeValide) {
    return {
      code: 3,
      motif: "artefact malformé : `findings` doit être un objet indexé par clé de finding",
    };
  }
  // Chaque ENTREE est validee, pas seulement la collection. Une entree accidentellement videe
  // (`{}`), privee de `severity`, ou mise a `null` par une edition manuelle disparaitrait
  // silencieusement du predicat de blocage (ou le ferait planter) : la resolution a la main
  // pourrait alors contourner la gate sans que rien ne le signale. Une entree malformee vaut
  // donc exit 3, au meme titre qu'un artefact absent : on ne juge pas sur un document abime.
  for (const [cle, entree] of Object.entries(f)) {
    if (entree === null || typeof entree !== "object" || Array.isArray(entree)) {
      return { code: 3, motif: `artefact malformé : le finding '${cle}' n'est pas un objet` };
    }
    if (typeof entree.severity !== "string" || !/^P[0-3?]$/.test(entree.severity)) {
      return { code: 3, motif: `artefact malformé : le finding '${cle}' n'a pas de sévérité lisible` };
    }
    if (typeof entree.titre !== "string" || typeof entree.file !== "string") {
      return { code: 3, motif: `artefact malformé : le finding '${cle}' n'a pas de titre ou de fichier` };
    }
  }
  if (!artefact.head_sha) {
    return { code: 3, motif: "artefact sans head_sha : aucune review enregistrée" };
  }
  if (headActuel && artefact.head_sha !== headActuel) {
    const horsArtefact = (fichiersDiff ?? []).filter(
      (f) => !cheminsArtefact.includes(f) && !estGestionDeStory(f, artefact.branche, gestion),
    );
    if (horsArtefact.length > 0) {
      return {
        code: 3,
        motif:
          `review périmée : ${horsArtefact.length} fichier(s) modifié(s) depuis ` +
          `${String(artefact.head_sha).slice(0, 7)} (dont ${horsArtefact[0]})`,
      };
    }
    // Seul l'artefact a bouge : la review reste valable.
  }
  const ouverts = findingsOuverts(artefact);
  if (ouverts.length > 0) {
    return {
      code: 2,
      motif: `${ouverts.length} finding(s) P0-P2 sans statut`,
      ouverts,
    };
  }
  return { code: 0, motif: "tous les findings bloquants sont traités" };
}

/**
 * Documents NARRATIFS de gestion d'une story, nommes un par un. Ce sont ceux que le harness
 * ecrit lui-meme dans le dossier de la story ; aucun n'est execute ni lu par une machine du
 * projet.
 */
export const NARRATIFS_DE_STORY = [
  "README.md",
  "brief.md",
  "spec.md",
  "challenge.md",
  "plan.md",
  "tasks.md",
  "qa-rapport.md",
  "pr.md",
  "regard-amont.md",
  "regard-aval.md",
  "reports-de-valeur.md",
  "codex-challenge.json",
  "codex-plan-review.json",
  "review-pr.json",
  "review-pr.md",
];

/**
 * Un fichier est-il de la GESTION de story (et non du code sous review) ?
 *
 * Pourquoi cette tolerance existe, en plus de celle sur l'artefact lui-meme. Traiter un finding
 * impose d'ecrire ailleurs que dans l'artefact : l'etat de la story, les reports d'arbitrage de
 * valeur, la spec. Si ces ecritures perimaient la review, la condition terminale serait
 * INATTEIGNABLE : chaque traitement exigerait une nouvelle review, qui trouverait de nouveaux
 * points, dont le traitement exigerait une nouvelle review. C'est un defaut de CONCEPTION de la
 * gate, pas un defaut du code relu.
 *
 * La tolerance reste sure parce qu'elle est bornee a ce qui ne PEUT PAS changer le comportement
 * du logiciel : le fichier d'etat de CETTE story, ses documents narratifs, et les documents que
 * le projet a declares narratifs (`chemins.narratifs`, nommes un par un). Tout fichier de code,
 * de test, de configuration ou de documentation partagee reste, lui, perimant : la gate continue
 * de refuser de certifier du code qu'elle n'a pas vu.
 */
// L'identifiant de la story : celui que l'appelant a lu sur le chemin de l'artefact
// (`gestion.story`), sinon la branche privee du prefixe declare (`gestion.prefixe`), sinon ce
// qui suit la derniere barre. Couper a la barre seule est faux des que le prefixe n'en porte
// pas (« feature-001-x ») : rien ne serait alors reconnu comme document de gestion, et la gate
// deviendrait inatteignable apres le premier finding traite.
function idDeStory(branche, gestion) {
  if (typeof gestion.story === "string" && gestion.story !== "") return gestion.story;
  const b = String(branche);
  if (typeof gestion.prefixe === "string" && gestion.prefixe !== "" && b.startsWith(gestion.prefixe)) {
    return b.slice(gestion.prefixe.length);
  }
  return b.replace(/^.*\//, "");
}

function estGestionDeStory(fichier, branche, gestion) {
  if (typeof fichier !== "string" || !branche || !gestion) return false;
  if ((gestion.narratifs ?? []).includes(fichier)) return true;
  const id = idDeStory(branche, gestion);
  const sansBarre = (c) => String(c ?? "").replace(/\/+$/, "");
  if (gestion.etat && fichier === `${sansBarre(gestion.etat)}/${id}.json`) return true;
  if (!gestion.specs) return false;
  const dossier = `${sansBarre(gestion.specs)}/${id}/`;
  if (!fichier.startsWith(dossier)) return false;

  // L'exemption ne couvre PAS tout le dossier de la story. Ce dossier peut contenir des fichiers
  // CONSOMMES PAR UNE MACHINE (un audit que la CI execute, des donnees qu'un test relit).
  // Exempter le dossier entier permettrait d'affaiblir une preuve apres la review sans que la
  // gate s'en apercoive. On nomme donc les fichiers NARRATIFS de gestion, et rien d'autre : tout
  // le reste, y compris un sous-dossier, perime la review.
  const nom = fichier.slice(dossier.length);
  // Seule exception : les captures du rendu (stages QA et REGARD), qui arrivent APRES la review
  // et que personne n'execute. Un seul niveau, et des formats de rendu seulement.
  if (/^captures\/[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif|pdf|txt)$/.test(nom)) return true;
  if (nom.includes("/")) return false; // aucun autre sous-dossier (audit/, preuves/, ...)
  return NARRATIFS_DE_STORY.includes(nom) || /^(valeur|arbitrage)-[a-z0-9.-]+\.json$/.test(nom);
}

/** Libelle lisible d'un statut, pour le markdown. */
const LIBELLES = {
  corrige: "corrigé",
  refute: "réfuté",
  faux_positif: "faux positif",
  perime: "périmé",
  differe_valeur: "différé par arbitrage de valeur",
  ecarte_valeur: "écarté par arbitrage de valeur",
};

/**
 * Le niveau d'extraction tel qu'on l'affiche. `vide` veut dire : une prose exploitable, lue
 * jusqu'au bout, qui ne porte aucun finding. Affiche tel quel, le mot se lit « rien
 * d'extractible », alors que la review a bien eu lieu. La valeur stockee ne change pas.
 */
export function libelleExtraction(extraction) {
  return extraction === "vide" ? "prose sans finding" : String(extraction);
}

/**
 * Rend le markdown lisible depuis l'artefact. TOUJOURS regenere, jamais edite a la main : le
 * json est la source de verite, le md n'existe que pour etre lu dans la PR.
 */
export function genererMarkdown(artefact) {
  const findings = Object.entries(artefact.findings ?? {}).map(([cle, f]) => ({ cle, ...f }));
  const ordre = { P0: 0, P1: 1, P2: 2, P3: 3, "P?": 4 };
  findings.sort((a, b) => (ordre[a.severity] ?? 9) - (ordre[b.severity] ?? 9));
  const ouverts = findings.filter(
    (f) => SEVERITES_BLOQUANTES.includes(f.severity) && !statutTraite(f.statut),
  );

  const l = [];
  if (artefact.source === "securite") {
    l.push(`# Relecture sécurité de PR (locale) : ${artefact.branche}`);
    l.push("");
    l.push(
      "> Relecture SÉCURITÉ produite par l'option `mistral`, à côté de la review de code. Ce " +
        "fichier est GÉNÉRÉ depuis son artefact JSON : ne l'édite pas à la main.",
    );
  } else {
    l.push(`# Review de PR (locale) : ${artefact.branche}`);
    l.push("");
    l.push(
      "> Review produite par le CLI du relecteur, sur la machine. Ce fichier est GÉNÉRÉ depuis " +
        "`review-pr.json` : ne l'édite pas à la main.",
    );
  }
  l.push("");
  l.push(`- Base : \`${artefact.base}\``);
  l.push(`- Dernier commit relu : \`${String(artefact.head_sha ?? "").slice(0, 7)}\``);
  l.push(`- Date : ${artefact.date ?? "?"}`);
  l.push(`- Modèle : ${artefact.modele ?? "?"}`);
  l.push(`- Reviews jouées : ${(artefact.reviews ?? []).length}`);
  l.push(`- Rounds avec bloquants ouverts : ${artefact.rounds ?? 0}`);
  l.push(`- Findings bloquants ouverts (P0-P2 sans statut) : **${ouverts.length}**`);
  l.push("");
  if (artefact.synthese?.verdict) {
    l.push("## Synthèse");
    l.push("");
    l.push(artefact.synthese.verdict);
    l.push("");
  }
  if (findings.length === 0) {
    l.push("## Findings");
    l.push("");
    l.push("Aucun finding : la review est propre.");
    l.push("");
  } else {
    l.push("## Findings");
    l.push("");
    for (const f of findings) {
      l.push(`### [${f.severity}] ${f.titre}`);
      l.push("");
      const plage = f.lines?.[0] ? `:${f.lines[0]}${f.lines[1] && f.lines[1] !== f.lines[0] ? `-${f.lines[1]}` : ""}` : "";
      l.push(`\`${f.file}${plage}\``);
      l.push("");
      if (f.corps) {
        l.push(f.corps);
        l.push("");
      }
      const statut = f.statut ? LIBELLES[f.statut] ?? f.statut : "**non traité**";
      l.push(`**Statut** : ${statut}${f.auto ? " (automatique)" : ""}`);
      if (f.note) l.push(`**Note** : ${f.note}`);
      if ((f.survived ?? 0) > 0) l.push(`**Persistance** : ${f.survived} round(s) survécu(s)`);
      if (f.escalation) l.push(`**Escalade** : ${f.escalation}`);
      if ((f.reouvertures ?? []).length > 0) {
        l.push(`**Réouvertures** : ${f.reouvertures.length}`);
      }
      // Option jev : absents sans elle, donc le rendu de 1.1.0 ne change pas.
      for (const r of f.rattachements ?? []) {
        const etat = r.defait ? ` (défait le ${r.defait.date} : ${r.defait.note})` : "";
        l.push(`**Rattachement (option jev)** : « ${r.titre} » reconnu comme ce même défaut, score ${r.score}, modèle ${r.modele}, depuis \`${r.cle_source}\`${etat}`);
      }
      for (const sg of f.signalements ?? []) {
        l.push(`**Signalement (option jev)** : ${sg.motif}`);
      }
      l.push("");
    }
  }
  l.push("## Historique des reviews");
  l.push("");
  for (const r of artefact.reviews ?? []) {
    l.push(`- ${r.date} : \`${String(r.head_sha).slice(0, 7)}\` -> ${r.resultat} (extraction : ${libelleExtraction(r.extraction)})`);
  }
  l.push("");
  return l.join("\n");
}

/**
 * Chemin de l'artefact de RELECTURE SECURITE (option `mistral`) associe a un artefact de review
 * de code :
 *
 *   <specs>/<id>/review-pr.json     -> <specs>/<id>/review-securite.json
 *   <reviews>/<branche>.json        -> <reviews>/<branche>.securite.json
 *
 * Deux artefacts distincts plutot qu'une source de plus dans le meme : la fusion ferme
 * AUTOMATIQUEMENT un finding absent d'une re-review structuree (cas 3 de `fusionner`). Dans un
 * artefact partage, une relecture securite propre fermerait tous les findings ouverts de la review
 * de code, et inversement : le faux vert que cette chaine s'interdit. Separes, chaque producteur ne
 * ferme que ce qu'il a lui-meme relu.
 */
export function estArtefactSecurite(chemin) {
  return /(^|\/)review-securite\.json$/.test(String(chemin ?? "")) || String(chemin ?? "").endsWith(".securite.json");
}

export function cheminArtefactSecurite(cheminCode) {
  const c = String(cheminCode ?? "");
  if (/(^|\/)review-pr\.json$/.test(c)) return c.replace(/review-pr\.json$/, "review-securite.json");
  if (estArtefactSecurite(c)) return c;
  return `${c.replace(/\.json$/, "")}.securite.json`;
}

/**
 * Combine les verdicts des deux gates (code et securite). Le plus PRUDENT l'emporte : 3 (l'une des
 * deux manque, est perimee ou n'est pas commitee) avant 2 (un bloquant ouvert) avant 0. Un code
 * inconnu vaut 3. Aucune des deux ne peut donc masquer l'autre : une review de code propre ne
 * certifie pas une PR dont la relecture securite manque, et reciproquement.
 */
export function combinerVerdicts(code, securite) {
  const rang = (c) => ({ 0: 0, 2: 1, 3: 2 })[c] ?? 2;
  const pire = Math.max(rang(code.code), rang(securite.code));
  return {
    code: [0, 2, 3][pire],
    motif: `code : ${code.motif} ; sécurité : ${securite.motif}`,
    ouverts: [
      ...(code.ouverts ?? []).map((f) => ({ ...f, source: "code" })),
      ...(securite.ouverts ?? []).map((f) => ({ ...f, source: "securite" })),
    ],
  };
}
