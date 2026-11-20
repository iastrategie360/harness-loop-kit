import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ICI } from "./aide.mjs";
import {
  cleFinding, parseSortieCodex, fusionner, calculerExit, genererMarkdown, findingsOuverts,
} from "../scripts/lib/review-pr-artefact.mjs";

// Témoins de la review de PR par artefact commité.
//
// Deux choses qu'une forge offre gratuitement avec ses fils de discussion doivent ici être
// fabriquées, et leur défaut serait SILENCIEUX :
//  1. l'IDENTITÉ d'un finding entre deux rounds (sans elle, on ne mesure pas la persistance) ;
//  2. la MÉMOIRE d'un traitement déjà rendu (sans elle, un arbitrage se rejoue à chaque round,
//     ou un finding traité sort de la gate sans que personne ne l'ait décidé).
// S'y ajoute le risque propre au support commité : l'artefact vit DANS la branche, donc
// l'enregistrer déplace le commit courant et pourrait périmer la review qu'il enregistre.

const fixture = (nom) => readFileSync(join(ICI, "fixtures", "review-pr", nom), "utf8");
const SHA_A = "aaaaaaa1111111111111111111111111111aaaa";
const SHA_B = "bbbbbbb2222222222222222222222222222bbbb";
const CHEMINS = ["specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md"];
const GESTION = { etat: "harness/state", specs: "specs", narratifs: ["docs/JOURNAL.md"] };

function contexte(headSha, extra = {}) {
  return {
    headSha,
    date: "2030-01-15T08:00:00Z",
    modele: "modele-de-test",
    synthese: "synthèse de test",
    extraction: "markdown",
    branche: "feat/001-jouet",
    base: "main",
    ...extra,
  };
}

const FINDING_A = { severity: "P2", file: "src/lib/truc.ts", lines: [10, 12], titre: "Corriger la garde", corps: "explication" };
const premier = (artefact) => Object.values(artefact.findings)[0];

describe("clé de finding : stable entre les rounds", () => {
  test("la clé ne dépend que du fichier et du titre", () => {
    // Les lignes bougent à chaque correctif voisin. Une clé qui en dépendrait ferait passer le
    // MÊME défaut pour un finding neuf à chaque round : la persistance resterait à zéro.
    assert.equal(cleFinding("src/lib/truc.ts", "Corriger la garde"), cleFinding("src/lib/truc.ts", "Corriger la garde"));
    const r1 = fusionner(null, [FINDING_A], contexte(SHA_A));
    const r2 = fusionner(r1, [{ ...FINDING_A, lines: [48, 50] }], contexte(SHA_B));
    assert.equal(Object.keys(r2.findings).length, 1, "le même défaut, déplacé de 38 lignes, reste UN finding");
  });

  test("la clé est insensible aux accents et à la casse", () => {
    assert.equal(cleFinding("src/a.ts", "Périmètre à Vérifier"), cleFinding("src/a.ts", "perimetre a verifier"));
  });

  test("deux titres différents dans le même fichier donnent deux clés", () => {
    assert.notEqual(cleFinding("src/a.ts", "premier défaut"), cleFinding("src/a.ts", "second défaut"));
  });
});

describe("extraction de la sortie du CLI", () => {
  test("niveau markdown : la forme rendue par le CLI en mode review est lue", () => {
    // Si le format du CLI dérive, ce témoin tombe ici plutôt qu'en silence pendant une review.
    const r = parseSortieCodex(fixture("markdown-avec-findings.md"), null, "/srv/projet");
    assert.equal(r.extraction, "markdown");
    assert.equal(r.findings.length, 2);
    assert.equal(r.findings[0].severity, "P2");
    // Le CLI rend un chemin ABSOLU : l'artefact doit porter du relatif au dépôt.
    assert.equal(r.findings[0].file, "tests/integration/jeu-de-donnees.sql");
    assert.deepEqual(r.findings[0].lines, [3772, 3773]);
    assert.match(r.findings[0].titre, /Seed a transcript/);
    assert.notEqual(r.synthese, "");
  });

  test("niveau schéma : un dernier message JSON conforme est préféré", () => {
    const json = JSON.stringify({
      findings: [{ priority: "P1", title: "Titre", body: "Corps", file: "src/a.ts", line_start: 4, line_end: 9 }],
      overall_explanation: "verdict",
    });
    const r = parseSortieCodex(json, null, "");
    assert.equal(r.extraction, "schema");
    assert.equal(r.findings[0].severity, "P1");
    assert.deepEqual(r.findings[0].lines, [4, 9]);
  });

  test("review propre : aucun finding, la prose part en synthèse", () => {
    const r = parseSortieCodex(fixture("markdown-propre.md"), null, "");
    assert.equal(r.findings.length, 0);
    assert.ok(r.synthese.length > 0);
  });

  test("une sévérité citée en pleine phrase ne crée PAS de finding fantôme", () => {
    const r = parseSortieCodex("Ce point était un [P1] dans la review précédente, il est clos.", null, "");
    assert.equal(r.findings.length, 0);
  });
});

describe("fail-closed : une sortie non lisible n'est jamais une review propre", () => {
  // Le pire défaut de cette chaîne : si le CLI change de format, le parseur rend zéro finding,
  // la fusion ferme alors tous les findings ouverts, et la gate s'ouvre sans review valable.
  // On distingue donc « propre » de « illisible » par une preuve positive.

  test("une prose anodine SANS preuve de fin de tour n'est pas exploitable", () => {
    assert.equal(parseSortieCodex(fixture("markdown-propre.md"), null, "").exploitable, false);
  });

  test("un texte qui ANNONCE des findings qu'on ne sait pas lire n'est pas exploitable", () => {
    const derive = "Synthèse.\n\nFull review comments:\n\n<<< format inconnu >>>\n";
    const r = parseSortieCodex(derive, fixture("events-propre.jsonl"), "");
    assert.equal(r.findings.length, 0);
    assert.equal(r.exploitable, false);
  });

  test("une ligne de finding sans puce est un finding, pas la suite du précédent", () => {
    const brut = "Synthèse.\n\n- [P3] Détail de nommage \u2014 src/a.py:3\n  Un détail.\n"
      + "[P1] Garde absente \u2014 src/garde.py:1-2\n  La garde laisse passer une valeur vide.\n";
    const r = parseSortieCodex(brut, null, "");
    assert.deepEqual(r.findings.map((f) => f.severity), ["P3", "P1"]);
    assert.equal(r.findings[1].file, "src/garde.py");
    assert.doesNotMatch(r.findings[0].corps, /Garde absente/);
    // Le même P1, déjà ouvert, n'est donc pas fermé par absence.
    const ouvert = { severity: "P1", file: "src/garde.py", lines: [1, 2], titre: "Garde absente", corps: "x" };
    const r1 = fusionner(null, [ouvert], contexte(SHA_A));
    const r2 = fusionner(r1, r.findings, contexte(SHA_B, { extraction: r.extraction }));
    assert.equal(r2.findings[cleFinding("src/garde.py", "Garde absente")].statut, null);
    assert.equal(calculerExit(r2, SHA_B, CHEMINS, CHEMINS).code, 2);
  });

  test("une sévérité en tête de ligne derrière une marque inconnue : toute la sortie est refusée", () => {
    const lignes = [
      "\u2022 [P1] Garde absente \u2014 src/garde.py:1",
      "| [P1] | Garde absente | src/garde.py:1 |",
      "+ [P1] Garde absente",
    ];
    for (const ligne of lignes) {
      const brut = `Synthèse.\n\n- [P3] Détail \u2014 src/a.py:3\n  Un détail.\n${ligne}\n`;
      const r = parseSortieCodex(brut, fixture("events-propre.jsonl"), "");
      assert.equal(r.exploitable, false, ligne);
      assert.equal(r.extraction, "markdown", ligne);
      assert.deepEqual(r.findings, [], ligne);
    }
  });

  test("du JSON entamé, tronqué ou enrobé de prose, n'est jamais une review sans finding", () => {
    // Le flux est complet : seule la lecture du dernier message peut refuser.
    const flux = fixture("events-propre.jsonl");
    const tronque = '{"findings":[{"priority":1,"title":"Garde manquante","file":"src/a.js"}';
    for (const brut of [tronque, '{"overall_explanation":"coupé en plei', "Voici la review :\n```json\n" + tronque + "]}\n```"]) {
      const r = parseSortieCodex(brut, flux, "");
      assert.equal(r.findings.length, 0, brut);
      assert.equal(r.exploitable, false, brut);
    }
  });

  test("une sortie vide n'est pas exploitable", () => {
    assert.equal(parseSortieCodex("", null, "").exploitable, false);
    assert.equal(parseSortieCodex("", fixture("events-propre.jsonl"), "").exploitable, false);
  });

  test("une prose d'échec rendue avec un code 0 n'est pas exploitable", () => {
    // Le CLI doit avoir dit lui-même qu'il est allé au bout. Sinon une PREMIÈRE review rendant
    // « je n'ai pas pu » produirait un artefact à zéro finding, et la gate certifierait.
    const prose = "I was unable to complete the review.";
    assert.equal(parseSortieCodex(prose, null, "").exploitable, false);
    assert.equal(parseSortieCodex(prose, '{"type":"thread.started"}\n{"type":"turn.started"}\n', "").exploitable, false);
  });

  test("une prose AVEC fin de tour et commande réussie est exploitable", () => {
    const r = parseSortieCodex(fixture("markdown-propre.md"), fixture("events-propre.jsonl"), "");
    assert.equal(r.exploitable, true);
    assert.equal(r.motif, "");
  });
});

describe("zéro finding : cru seulement si le flux prouve que le relecteur a lu le dépôt", () => {
  const ligne = (objet) => `${JSON.stringify(objet)}\n`;
  const commande = (code) => ligne({ type: "item.completed", item: { type: "command_execution", command: "git diff", exit_code: code } });
  const FIN = ligne({ type: "turn.completed" });
  const REFUS = "I could not review the changes because the repository could not be read.";

  test("un refus poli qui finit son tour sans aucune commande n'est pas une review propre", () => {
    const r = parseSortieCodex(REFUS, FIN, "");
    assert.equal(r.exploitable, false);
    assert.match(r.motif, /aucune commande reussie/);
  });

  test("des commandes toutes en échec ne prouvent rien non plus", () => {
    assert.equal(parseSortieCodex(REFUS, commande(128) + commande(1) + FIN, "").exploitable, false);
    // Une commande seulement LANCÉE (pas terminée), ou un code absent : pas une preuve.
    const lancee = ligne({ type: "item.started", item: { type: "command_execution", command: "git diff", exit_code: null } });
    assert.equal(parseSortieCodex(REFUS, lancee + FIN, "").exploitable, false);
  });

  test("une commande réussie SANS fin de tour ne suffit pas : les deux preuves sont exigées", () => {
    const r = parseSortieCodex("The changes look correct.", commande(0), "");
    assert.equal(r.exploitable, false);
    assert.match(r.motif, /fin de tour/);
  });

  test("les deux preuves réunies : la prose sans finding est une review propre", () => {
    assert.equal(parseSortieCodex("The changes look correct.", commande(1) + commande(0) + FIN, "").exploitable, true);
  });

  test("une liste structurée VIDE obéit à la même règle que la prose", () => {
    const vide = JSON.stringify({ findings: [], overall_explanation: "Rien." });
    assert.equal(parseSortieCodex(vide, FIN, "").exploitable, false);
    assert.equal(parseSortieCodex(vide, null, "").exploitable, false);
    const propre = parseSortieCodex(vide, commande(0) + FIN, "");
    assert.equal(propre.exploitable, true);
    assert.equal(propre.extraction, "schema");
    // Même règle quand la liste vide arrive par le flux d'événements.
    const parFlux = ligne({ findings: [], overall_explanation: "Rien." });
    assert.equal(parseSortieCodex("Fini.", parFlux + FIN, "").exploitable, false);
    assert.equal(parseSortieCodex("Fini.", parFlux + commande(0) + FIN, "").exploitable, true);
  });

  test("des findings lus n'attendent aucune preuve : ils bloquent d'eux-mêmes", () => {
    const json = JSON.stringify({ findings: [{ priority: "P1", title: "Titre", file: "src/a.ts" }] });
    assert.equal(parseSortieCodex(json, null, "").exploitable, true);
  });
});

describe("format structuré par défaut du relecteur", () => {
  const parDefaut = (findings) => JSON.stringify({ findings, overall_correctness: "patch is incorrect", overall_explanation: "x" });
  const lieu = (fichier, debut, fin) => ({ absolute_file_path: `/srv/projet/${fichier}`, line_range: { start: debut, end: fin } });

  test("la priorité numérique est lue : un 3 reste mineur, un 1 bloque", () => {
    const r = parseSortieCodex(
      parDefaut([
        { title: "Garde cassée", body: "c", priority: 1, code_location: lieu("src/a.py", 4, 9) },
        { title: "Nom ambigu", body: "c", priority: 3, code_location: lieu("src/a.py", 2, 2) },
        { title: "Zéro compte aussi", body: "c", priority: 0, code_location: lieu("src/b.py", 1, 1) },
      ]),
      null,
      "/srv/projet",
    );
    assert.deepEqual(r.findings.map((f) => f.severity), ["P1", "P3", "P0"]);
    assert.equal(findingsOuverts(fusionner(null, [r.findings[1]], contexte(SHA_A))).length, 0);
  });

  test("la localisation imbriquée est lue, chemin rendu relatif au dépôt", () => {
    const r = parseSortieCodex(parDefaut([{ title: "Garde cassée", body: "c", priority: 2, code_location: lieu("src/a.py", 4, 9) }]), null, "/srv/projet");
    assert.equal(r.findings[0].file, "src/a.py");
    assert.deepEqual(r.findings[0].lines, [4, 9]);
  });

  test("deux findings de même titre dans deux fichiers gardent deux identités", () => {
    const r = parseSortieCodex(
      parDefaut([
        { title: "Entrée non validée", body: "c", priority: 2, code_location: lieu("src/a.py", 1, 1) },
        { title: "Entrée non validée", body: "c", priority: 2, code_location: lieu("src/b.py", 1, 1) },
      ]),
      null,
      "/srv/projet",
    );
    const a = fusionner(null, r.findings, contexte(SHA_A));
    assert.equal(Object.keys(a.findings).length, 2);
  });

  test("sans champ de priorité, le préfixe du titre fait foi, et il sort du titre", () => {
    const r = parseSortieCodex(parDefaut([{ title: "[P2] Garde cassée", body: "c", code_location: lieu("src/a.py", 4, 9) }]), null, "/srv/projet");
    assert.equal(r.findings[0].severity, "P2");
    assert.equal(r.findings[0].titre, "Garde cassée");
    // Même clé que le même finding lu en prose : le préfixe n'entre pas dans l'identité.
    assert.equal(cleFinding(r.findings[0].file, r.findings[0].titre), cleFinding("src/a.py", "Garde cassée"));
  });

  test("une priorité hors de 0 à 3 reste illisible, donc bloquante", () => {
    for (const priorite of [4, -1, 1.5, "haute", null]) {
      const r = parseSortieCodex(parDefaut([{ title: "Titre", body: "c", priority: priorite, code_location: lieu("src/a.py", 1, 1) }]), null, "");
      assert.equal(r.findings[0].severity, "P?", String(priorite));
    }
  });
});

describe("gate : l'enregistrement de la review ne la périme pas", () => {
  test("les chemins comparés sont ceux du DÉPÔT, pas l'emplacement de lecture", () => {
    // Git rend des chemins relatifs au dépôt. Une tolérance fondée sur le chemin où le fichier
    // a été LU (un fichier temporaire, un chemin absolu) ne correspondrait jamais : toute
    // review fraîche serait déclarée périmée.
    const a = fusionner(null, [], contexte(SHA_A));
    assert.equal(calculerExit(a, SHA_B, CHEMINS, CHEMINS).code, 0);
    assert.equal(calculerExit(a, SHA_B, CHEMINS, ["/tmp/x.json", "/tmp/x.md"]).code, 3);
  });

  test("l'état de la story et ses documents de gestion ne périment pas", () => {
    // Traiter un finding oblige à écrire hors de l'artefact (état, reports). Si ces écritures
    // périmaient la review, la condition de sortie serait INATTEIGNABLE.
    const a = fusionner(null, [], contexte(SHA_A));
    const gestion = [
      "specs/001-jouet/review-pr.json",
      "specs/001-jouet/reports-de-valeur.md",
      "specs/001-jouet/qa-rapport.md",
      "specs/001-jouet/pr.md",
      "specs/001-jouet/valeur-code-2.json",
      "specs/001-jouet/captures/accueil.png",
      "specs/001-jouet/captures/sortie-cli.txt",
      "harness/state/001-jouet.json",
      "docs/JOURNAL.md",
    ];
    assert.equal(calculerExit(a, SHA_B, gestion, CHEMINS, GESTION).code, 0);
  });

  test("sans description des documents de gestion, seul l'artefact est toléré", () => {
    const a = fusionner(null, [], contexte(SHA_A));
    assert.equal(calculerExit(a, SHA_B, ["harness/state/001-jouet.json"], CHEMINS).code, 3);
  });

  test("du CODE, un TEST ou un document PARTAGÉ périment toujours", () => {
    const a = fusionner(null, [], contexte(SHA_A));
    for (const fichier of [
      "src/lib/truc.ts",
      "tests/x.test.py",
      "docs/BACKLOG.md",
      "specs/999-autre/review-pr.json",
      "harness/state/999-autre.json",
      "harness/projet.json",
    ]) {
      assert.equal(calculerExit(a, SHA_B, [fichier], CHEMINS, GESTION).code, 3, `${fichier} doit périmer la review`);
    }
  });

  test("un fichier LU PAR UNE MACHINE dans le dossier de la story périme, malgré l'exemption", () => {
    // Exempter le dossier entier permettrait d'affaiblir une preuve après la review. Seuls les
    // documents narratifs, nommés un par un et sans sous-dossier, sont exemptés.
    const a = fusionner(null, [], contexte(SHA_A));
    for (const fichier of [
      "specs/001-jouet/audit/enumeration.sql",
      "specs/001-jouet/preuves/resultat.tsv",
      "specs/001-jouet/script.sh",
      "specs/001-jouet/donnees.csv",
      "specs/001-jouet/captures/rejeu.sh",
      "specs/001-jouet/captures/lot/accueil.png",
    ]) {
      assert.equal(calculerExit(a, SHA_B, [fichier], CHEMINS, GESTION).code, 3, `${fichier} doit périmer la review`);
    }
  });
});

describe("gate : un artefact abîmé ne rend jamais un feu vert", () => {
  // L'artefact est édité à la main pendant la résolution. Une entrée vidée, privée de sévérité
  // ou mise à null sortirait du prédicat de blocage : on refuse de juger sur un document abîmé.
  const mauvaises = [
    ["entrée nulle", null],
    ["entrée vide", {}],
    ["sévérité absente", { titre: "t", file: "f" }],
    ["sévérité illisible", { severity: "grave", titre: "t", file: "f" }],
    ["titre absent", { severity: "P1", file: "f" }],
    ["entrée en tableau", []],
  ];
  for (const [libelle, entree] of mauvaises) {
    test(`${libelle} : code 3`, () => {
      assert.equal(calculerExit({ head_sha: SHA_A, findings: { "x--y": entree } }, SHA_A, [], CHEMINS).code, 3);
    });
  }

  test("artefact absent, vide, ou collection de findings malformée : code 3", () => {
    assert.equal(calculerExit(null, SHA_A, [], CHEMINS).code, 3);
    assert.equal(calculerExit({}, SHA_A, [], CHEMINS).code, 3);
    for (const mauvais of [[], "rien", 0, null]) {
      assert.equal(calculerExit({ head_sha: SHA_A, findings: mauvais }, SHA_A, [], CHEMINS).code, 3, `findings = ${JSON.stringify(mauvais)}`);
    }
  });
});

describe("statut : seule la liste documentée libère un finding", () => {
  for (const [libelle, valeur] of [["coquille", "corrgie"], ["statut inventé", "fixed"], ["chaîne vide", ""], ["valeur non textuelle", 1]]) {
    test(`${libelle} : le finding reste BLOQUANT`, () => {
      const a = fusionner(null, [FINDING_A], contexte(SHA_A));
      premier(a).statut = valeur;
      assert.equal(findingsOuverts(a).length, 1);
      assert.equal(calculerExit(a, SHA_A, [], CHEMINS).code, 2);
    });
  }

  test("chacun des statuts documentés libère le finding", () => {
    for (const s of ["corrige", "refute", "faux_positif", "perime", "differe_valeur", "ecarte_valeur"]) {
      const a = fusionner(null, [FINDING_A], contexte(SHA_A));
      premier(a).statut = s;
      assert.equal(findingsOuverts(a).length, 0, `statut ${s}`);
    }
  });
});

describe("fusion : les cinq cas", () => {
  test("cas 1 : un finding neuf arrive ouvert et sans persistance", () => {
    const a = fusionner(null, [FINDING_A], contexte(SHA_A));
    assert.equal(premier(a).statut, null);
    assert.equal(premier(a).survived, 0);
    assert.equal(a.synthese.open_p0_p2, 1);
    assert.equal(a.branche, "feat/001-jouet");
    assert.equal(a.base, "main");
  });

  test("cas 2 : re-signalé après un NOUVEAU commit, la persistance monte", () => {
    const r1 = fusionner(null, [FINDING_A], contexte(SHA_A));
    assert.equal(premier(fusionner(r1, [FINDING_A], contexte(SHA_B))).survived, 1);
  });

  test("cas 2 bis : re-review sur le MÊME commit, la persistance ne bouge pas", () => {
    // Sinon relancer deux fois la review sans rien corriger déclencherait une escalade
    // imaginaire sur un défaut jamais retouché.
    const r1 = fusionner(null, [FINDING_A], contexte(SHA_A));
    assert.equal(premier(fusionner(r1, [FINDING_A], contexte(SHA_A))).survived, 0);
  });

  test("cas 3 : disparu d'une review LUE, il passe corrigé automatiquement et reste tracé", () => {
    const r1 = fusionner(null, [FINDING_A], contexte(SHA_A));
    const autre = { ...FINDING_A, file: "src/lib/autre.ts", titre: "Autre défaut" };
    const r2 = fusionner(r1, [autre], contexte(SHA_B, { extraction: "markdown" }));
    const f = r2.findings[cleFinding(FINDING_A.file, FINDING_A.titre)];
    assert.equal(f.statut, "corrige");
    assert.equal(f.auto, true);
    assert.equal(Object.keys(r2.findings).length, 2, "l'entrée n'est jamais supprimée");
  });

  test("cas 3 bis : une sortie NON reconnue ne ferme RIEN", () => {
    // Le faux vert le plus grave : un message d'échec, une sortie tronquée ou un format qui
    // dérive rendent zéro finding. Si l'absence valait preuve, ils fermeraient tout.
    const r1 = fusionner(null, [FINDING_A], contexte(SHA_A));
    const r2 = fusionner(r1, [], contexte(SHA_B, { extraction: "vide" }));
    assert.equal(premier(r2).statut, null);
    assert.equal(calculerExit(r2, SHA_B, CHEMINS, CHEMINS).code, 2);
  });

  test("cas 4 : re-signalé après avoir été tenu pour corrigé, il se ROUVRE", () => {
    const r1 = fusionner(null, [FINDING_A], contexte(SHA_A));
    const r2 = fusionner(r1, [], contexte(SHA_B));
    const r3 = fusionner(r2, [FINDING_A], contexte("ccc3"));
    assert.equal(premier(r3).statut, null);
    assert.equal(premier(r3).reouvertures.length, 1);
    assert.equal(findingsOuverts(r3).length, 1);
  });

  test("cas 5 : un statut DÉLIBÉRÉ survit à une re-détection", () => {
    // Un arbitrage rendu ne se rejoue pas à chaque round, sinon la gate ne passerait jamais
    // sur un finding pourtant tranché.
    const r1 = fusionner(null, [FINDING_A], contexte(SHA_A));
    const cle = Object.keys(r1.findings)[0];
    r1.findings[cle].statut = "refute";
    r1.findings[cle].note = "Réfuté : la garde existe en amont, src/lib/entree.ts ligne 4.";
    const r2 = fusionner(r1, [FINDING_A], contexte(SHA_B));
    assert.equal(r2.findings[cle].statut, "refute");
    assert.equal(findingsOuverts(r2).length, 0);
  });

  test("deux findings de même clé dans une review : le plus grave fait foi, compté une fois", () => {
    const p1 = { ...FINDING_A, severity: "P1", corps: "le grave" };
    const p3 = { ...FINDING_A, severity: "P3", corps: "le mineur" };
    for (const lot of [[p1, p3], [p3, p1]]) {
      const a = fusionner(null, lot, contexte(SHA_A));
      assert.equal(premier(a).severity, "P1");
      assert.equal(calculerExit(a, SHA_A, [], CHEMINS).code, 2);
      assert.equal(premier(fusionner(a, lot, contexte(SHA_B))).survived, 1);
    }
  });

  test("un P3 ne bloque jamais la gate", () => {
    assert.equal(findingsOuverts(fusionner(null, [{ ...FINDING_A, severity: "P3" }], contexte(SHA_A))).length, 0);
  });

  test("une sévérité ILLISIBLE bloque, au lieu de disparaître en silence", () => {
    const r = parseSortieCodex(
      JSON.stringify({ findings: [{ title: "Sans priorité", body: "x", file: "src/a.ts", line_start: 1, line_end: 1 }], overall_explanation: "" }),
      null,
      "",
    );
    assert.equal(r.findings[0].severity, "P?");
    const a = fusionner(null, r.findings, contexte(SHA_A));
    assert.equal(calculerExit(a, SHA_A, [], CHEMINS).code, 2);
  });
});

describe("gate : les trois codes de sortie", () => {
  test("du code a changé depuis la review : 3 (périmée)", () => {
    const r = calculerExit(fusionner(null, [], contexte(SHA_A)), SHA_B, ["src/lib/truc.ts"], CHEMINS);
    assert.equal(r.code, 3);
    assert.match(r.motif, /périmée/);
  });

  test("un finding bloquant sans statut : 2", () => {
    const r = calculerExit(fusionner(null, [FINDING_A], contexte(SHA_A)), SHA_A, [], CHEMINS);
    assert.equal(r.code, 2);
    assert.equal(r.ouverts.length, 1);
  });

  test("tous traités : 0", () => {
    const a = fusionner(null, [FINDING_A], contexte(SHA_A));
    premier(a).statut = "corrige";
    assert.equal(calculerExit(a, SHA_A, [], CHEMINS).code, 0);
  });
});

describe("markdown généré : ce que l'approbateur lit dans la PR", () => {
  test("il porte la note d'un finding traité et le compte d'ouverts", () => {
    const a = fusionner(null, [FINDING_A], contexte(SHA_A));
    premier(a).statut = "differe_valeur";
    premier(a).note = "Différé le 2030-01-15. Ligne de backlog : garde-x";
    const md = genererMarkdown(a);
    assert.match(md, /différé par arbitrage de valeur/);
    assert.match(md, /Ligne de backlog : garde-x/);
    assert.ok(md.includes("Findings bloquants ouverts (P0-P2 sans statut) : **0**"));
  });

  test("une review en prose sans finding se lit comme telle, et elle est comptée", () => {
    const md = genererMarkdown(fusionner(null, [], contexte(SHA_A, { extraction: "vide" })));
    assert.ok(md.includes("(extraction : prose sans finding)"), md);
    assert.ok(md.includes("- Reviews jouées : 1"), md);
    assert.ok(md.includes("- Rounds avec bloquants ouverts : 0"), md);
  });

  test("un finding non traité est annoncé comme tel", () => {
    const md = genererMarkdown(fusionner(null, [FINDING_A], contexte(SHA_A)));
    assert.ok(md.includes("**non traité**"));
    assert.ok(md.includes("src/lib/truc.ts:10-12"));
  });
});

describe("réponse structurée illisible : jamais une review propre", () => {
  const FIN_DE_TOUR = '{"type":"turn.completed"}\n';

  test("un finding sans titre ni fichier ni corps rend toute la sortie non exploitable", () => {
    const r = parseSortieCodex(JSON.stringify({ findings: [{ priority: "P1" }], overall_explanation: "" }), FIN_DE_TOUR, "");
    assert.equal(r.exploitable, false);
    assert.equal(r.extraction, "schema");
    assert.deepEqual(r.findings, []);
  });

  test("un finding sans titre garde sa place : la première ligne du corps sert de titre", () => {
    const r = parseSortieCodex(JSON.stringify({ findings: [{ priority: "P1", body: "La garde est cassée\nDétail." }] }), null, "");
    assert.equal(r.exploitable, true);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].severity, "P1");
    assert.equal(r.findings[0].titre, "La garde est cassée");
    const a = fusionner(null, r.findings, contexte(SHA_A));
    assert.equal(calculerExit(a, SHA_A, [], CHEMINS).code, 2);
  });

  test("un élément qui n'est pas un objet, ou un objet JSON sans liste de findings : non exploitable", () => {
    for (const brut of ['{"findings":["P1 : cassé"]}', '{"findings":[null]}', '{"findings":"aucun"}', '{"erreur":"quota dépassé"}']) {
      assert.equal(parseSortieCodex(brut, FIN_DE_TOUR, "").exploitable, false, brut);
    }
  });

  test("flux JSONL : un finding illisible n'est pas ramené à une liste vide", () => {
    const flux = `${JSON.stringify({ findings: [{ priority: "P2" }] })}\n${FIN_DE_TOUR}`;
    const r = parseSortieCodex("Revue terminée.", flux, "");
    assert.equal(r.exploitable, false);
    assert.equal(r.extraction, "jsonl");
  });
});

describe("documents de gestion : l'identifiant de la story ne dépend pas d'une barre dans la branche", () => {
  const DOCUMENTS = ["specs/001-jouet/qa-rapport.md", "harness/state/001-jouet.json"];
  const sansBarre = () => fusionner(null, [], contexte(SHA_A, { branche: "feature-001-jouet" }));

  test("identifiant donné par l'appelant, ou préfixe déclaré : la review ne périme pas", () => {
    assert.equal(calculerExit(sansBarre(), SHA_B, DOCUMENTS, CHEMINS, { ...GESTION, story: "001-jouet" }).code, 0);
    assert.equal(calculerExit(sansBarre(), SHA_B, DOCUMENTS, CHEMINS, { ...GESTION, prefixe: "feature-" }).code, 0);
  });

  test("sans l'un ni l'autre, on ne devine pas : la review périme", () => {
    assert.equal(calculerExit(sansBarre(), SHA_B, DOCUMENTS, CHEMINS, GESTION).code, 3);
  });

  test("l'identifiant donné ne couvre pas la story voisine", () => {
    assert.equal(calculerExit(sansBarre(), SHA_B, ["specs/999-autre/qa-rapport.md"], CHEMINS, { ...GESTION, story: "001-jouet" }).code, 3);
  });
});
