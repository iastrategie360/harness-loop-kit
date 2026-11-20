import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { depotJouet, FAUX } from "./aide.mjs";

// La chaîne de relecture, jouée de bout en bout contre un FAUX relecteur (tests/faux/codex) :
// même surface que le CLI, sans réseau ni modèle. Le faux refuse tout appel sans lecture seule,
// donc un script qui l'oublierait rougit ici.

const SPEC = "specs/001-jouet/spec.md";
const PLAN = "specs/001-jouet/plan.md";
const ARTEFACT = ["specs", "001-jouet", "review-pr.json"];
const RELECTEUR = ["harness", ".travail", "relecteur"];

// Un dépôt avec une story en cours : branche de story, un commit de code, spec et plan.
function chantier({ config = () => {}, accord = true } = {}) {
  const d = depotJouet({
    config: (c) => { c.relecteur.accord_envoi_externe = accord; config(c); },
    env: { PATH: `${FAUX}:${process.env.PATH}` },
  });
  d.git("checkout", "-q", "-b", "feat/001-jouet");
  d.ecrire("src/garde.py", "def garde(valeur):\n    return valeur is not None\n");
  d.ecrire(SPEC, "# Spec\n\nLa garde refuse une valeur vide.\n");
  d.ecrire(PLAN, "# Plan\n\nModifier src/garde.py.\n");
  d.git("add", "-A");
  d.git("commit", "-q", "-m", "feat: garde");
  return d;
}

const mode = (m, plus = {}) => ({ env: { FAUX_CODEX_MODE: m, ...plus } });

function commiter(d, message, ...fichiers) {
  d.git("add", ...fichiers);
  d.git("commit", "-q", "-m", message);
}

describe("relectures à schéma : challenge, plan, arbitrage", () => {
  test("challenge : la sortie validée est posée à côté de la spec, en lecture seule", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const trace = d.chemin("harness", ".travail", "trace.txt");
    d.ecrire("harness/.travail/trace.txt", "");
    const r = d.lancer("codex-challenge.sh", [SPEC], { env: { FAUX_CODEX_TRACE: trace } });
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.equal(d.lireJson("specs", "001-jouet", "codex-challenge.json").verdict, "a_reviser");
    const appels = d.lire("harness", ".travail", "trace.txt");
    assert.match(appels, /\nexec\n/);
    assert.match(appels, /\n-s\nread-only\n/);
    assert.match(appels, /challenge\.json/);
    assert.equal(d.git("status", "--porcelain", "--", "README.md", "src"), "", "le dépôt n'a pas bougé");
  });

  test("plan : un critique bloquant rend 2, la contre-review reste écrite", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = d.lancer("codex-plan-review.sh", [PLAN]);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.equal(d.lireJson("specs", "001-jouet", "codex-plan-review.json").verdict, "solide");
    r = d.lancer("codex-plan-review.sh", [PLAN], mode("bloquant"));
    assert.equal(r.code, 2);
    assert.equal(d.lireJson("specs", "001-jouet", "codex-plan-review.json").critique_bloquant, true);
  });

  test("arbitrage : le verdict est écrit à côté du finding", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("harness/.travail/finding.json", JSON.stringify({
      cle: "src/garde.py--valeur-vide", titre: "La garde laisse passer une valeur vide", severite: "P2",
      fichier: "src/garde.py", detail: "Une chaîne vide passe.", refutation_codeur: "Filtré en amont.",
    }));
    const r = d.lancer("codex-arbitrer.sh", ["harness/.travail/finding.json"]);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.equal(d.lireJson("harness", ".travail", "finding.arbitration.json").verdict, "faux_positif");

    d.ecrire("harness/.travail/incomplet.json", JSON.stringify({ cle: "x", titre: "t" }));
    assert.equal(d.lancer("codex-arbitrer.sh", ["harness/.travail/incomplet.json"]).code, 1);
  });

  test("une sortie hors schéma n'est jamais posée", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const faux = d.ecrire("harness/.travail/hors-schema.json", JSON.stringify({ verdict: "peut-etre", findings: [] }));
    const r = d.lancer("codex-challenge.sh", [SPEC], { env: { FAUX_CODEX_SORTIE: faux } });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /ne respecte pas le schéma challenge\.json/);
    assert.equal(d.existe("specs", "001-jouet", "codex-challenge.json"), false);
  });
});

describe("un relecteur défaillant ne passe jamais pour une relecture propre", () => {
  test("sortie VIDE avec un code 0 : échec, rien n'est posé", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = d.lancer("codex-challenge.sh", [SPEC], mode("vide"));
    assert.equal(r.code, 1);
    assert.match(r.erreur, /sortie VIDE/);
    assert.equal(d.existe("specs", "001-jouet", "codex-challenge.json"), false);

    r = d.lancer("review-pr-locale.sh", ["001-jouet"], mode("vide"));
    assert.equal(r.code, 1);
    assert.equal(d.existe(...ARTEFACT), false);
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 3, "sans artefact, la gate reste fermée");
  });

  test("une sortie vide n'écrase pas une relecture précédente", (t) => {
    const d = chantier();
    t.after(d.detruire);
    assert.equal(d.lancer("codex-challenge.sh", [SPEC]).code, 0);
    const avant = d.lire("specs", "001-jouet", "codex-challenge.json");
    assert.equal(d.lancer("codex-challenge.sh", [SPEC], mode("vide")).code, 1);
    assert.equal(d.lire("specs", "001-jouet", "codex-challenge.json"), avant);
  });

  test("le relecteur a ÉCRIT dans le dépôt : code 5, sortie écartée, rien n'est annulé", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = d.lancer("codex-challenge.sh", [SPEC], mode("ecrit"));
    assert.equal(r.code, 5);
    assert.match(r.erreur, /a MODIFIÉ le dépôt/);
    assert.equal(d.existe("specs", "001-jouet", "codex-challenge.json"), false);
    // Le harness ne répare pas à la place de l'humain : la modification est toujours là.
    assert.match(d.lire("README.md"), /modifié par le relecteur/);

    d.git("checkout", "--", "README.md");
    r = d.lancer("review-pr-locale.sh", ["001-jouet"], mode("ecrit"));
    assert.equal(r.code, 5);
    assert.equal(d.existe(...ARTEFACT), false);
    assert.match(d.lire("README.md"), /modifié par le relecteur/);
  });

  test("une prose rendue sans fin de tour n'écrit pas d'artefact", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = d.lancer("review-pr-locale.sh", ["001-jouet"], mode("prose-sans-fin"));
    assert.equal(r.code, 1);
    assert.match(r.erreur, /NON EXPLOITABLE/);
    assert.equal(d.existe(...ARTEFACT), false);
    assert.equal(d.lancer("codex-diff-review.sh", [], mode("prose-sans-fin")).code, 1);
  });

  test("un refus qui finit son tour sans avoir lu le dépôt n'écrit pas d'artefact", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = d.lancer("review-pr-locale.sh", ["001-jouet"], mode("refus"));
    assert.equal(r.code, 1);
    assert.match(r.erreur, /NON EXPLOITABLE/);
    assert.match(r.erreur, /aucune commande reussie/);
    assert.equal(d.existe(...ARTEFACT), false);
    assert.equal(d.lancer("codex-diff-review.sh", [], mode("refus")).code, 1);
  });

  test("un échec du CLI est nommé : authentification, quota, délai", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = d.lancer("codex-challenge.sh", [SPEC], mode("echec-auth"));
    assert.equal(r.code, 1);
    assert.match(r.erreur, /codex login/);
    r = d.lancer("codex-diff-review.sh", [], mode("echec-quota"));
    assert.equal(r.code, 1);
    assert.match(r.erreur, /limite d'usage/);
    r = d.lancer("codex-plan-review.sh", [PLAN], mode("lent", { HARNESS_DELAI_RELECTEUR_S: "1" }));
    assert.equal(r.code, 1);
    assert.match(r.erreur, /dépassé le délai \(1 s\)/);
    assert.equal(d.existe("specs", "001-jouet", "codex-plan-review.json"), false);
  });
});

describe("refus avant tout envoi", () => {
  test("sans accord d'envoi externe, rien ne part", (t) => {
    const d = chantier({ accord: false });
    t.after(d.detruire);
    const trace = d.chemin("trace-hors-depot.txt");
    for (const [script, args] of [
      ["codex-challenge.sh", [SPEC]], ["codex-plan-review.sh", [PLAN]], ["codex-diff-review.sh", []], ["review-pr-locale.sh", ["001-jouet"]],
    ]) {
      const r = d.lancer(script, args, { env: { FAUX_CODEX_TRACE: trace } });
      assert.equal(r.code, 1, script);
      assert.match(r.erreur, /accord_envoi_externe/);
      assert.match(r.erreur, /Camille/, "le refus nomme la personne qui peut l'accorder");
    }
    assert.equal(d.existe("trace-hors-depot.txt"), false, "le CLI n'a jamais été appelé");
  });

  test("un relecteur non authentifié est refusé avant de lancer", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = d.lancer("codex-challenge.sh", [SPEC], mode("non-authentifie"));
    assert.equal(r.code, 1);
    assert.match(r.erreur, /pas authentifié/);
  });

  test("review du diff : l'état écrit avant le pas n'est pas une modification à signaler", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("harness/state/001-jouet.json", "{}\n");
    commiter(d, "chore: état", "harness/state/001-jouet.json");
    d.ecrire("harness/state/001-jouet.json", '{"tours": 1}\n');
    let r = d.lancer("codex-diff-review.sh", []);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.doesNotMatch(r.erreur, /avertissement/);
    assert.match(r.sortie, /extraction : prose sans finding|extraction : (markdown|jsonl|schema)/);
    d.ecrire("src/garde.py", "def garde(valeur):\n    return bool(valeur)\n");
    r = d.lancer("codex-diff-review.sh", []);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.match(r.erreur, /avertissement : des modifications ne sont pas commitées/);
  });

  test("review de PR : un fichier suivi modifié sans commit, et la review ne part pas", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const trace = d.chemin("harness", ".travail", "trace.txt");
    const suivi = { env: { FAUX_CODEX_TRACE: trace } };
    d.ecrire("harness/state/001-jouet.json", "{}\n");
    commiter(d, "chore: état", "harness/state/001-jouet.json");

    // Un correctif dans l'arbre, pas dans le commit : le relecteur le lirait, et l'artefact
    // certifierait le commit qui ne l'a pas.
    d.ecrire("src/garde.py", "def garde(valeur):\n    return bool(valeur)\n");
    d.ecrire("harness/.travail/trace.txt", "");
    let r = d.lancer("review-pr-locale.sh", ["001-jouet"], suivi);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /REFUS : des fichiers suivis sont modifiés sans être commités/);
    assert.match(r.erreur, /src\/garde\.py/);
    // Le contrôle d'authentification a pu passer : c'est la review qui ne doit pas partir.
    assert.doesNotMatch(d.lire("harness", ".travail", "trace.txt"), /\nreview\n/, "aucune review n'est partie");
    assert.equal(d.existe(...ARTEFACT), false);

    // Même refus pour une modification indexée, pas encore commitée.
    d.git("add", "src/garde.py");
    assert.equal(d.lancer("review-pr-locale.sh", ["001-jouet"], suivi).code, 1);
    assert.doesNotMatch(d.lire("harness", ".travail", "trace.txt"), /\nreview\n/);

    // Commité, la review part. L'état réécrit avant le pas ne la bloque pas.
    d.git("commit", "-q", "-m", "fix: garde");
    d.ecrire("harness/state/001-jouet.json", '{"tours": 1}\n');
    r = d.lancer("review-pr-locale.sh", ["001-jouet"], suivi);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.match(d.lire("harness", ".travail", "trace.txt"), /\nexec\nreview\n/);

    // L'artefact commité puis retouché (un statut posé) ne bloque pas non plus la suivante.
    commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
    d.ecrire("specs/001-jouet/review-pr.md", d.lire("specs", "001-jouet", "review-pr.md") + "\n");
    d.ecrire("specs/001-jouet/review-pr.json", d.lire(...ARTEFACT) + "\n");
    r = d.lancer("review-pr-locale.sh", ["001-jouet"], suivi);
    assert.equal(r.code, 0, r.erreur + r.sortie);
  });

  test("review de PR : un fichier jamais ajouté à Git est signalé, sans arrêter la review", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = d.lancer("review-pr-locale.sh", ["001-jouet"]);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.doesNotMatch(r.erreur, /jamais été ajoutés à Git/, "ni le dossier de travail ni l'artefact ne comptent");
    // L'artefact du premier passage, un état tout neuf et les journaux du relecteur dans le
    // dossier de travail ne comptent pas.
    d.ecrire("harness/state/001-jouet.json", "{}\n");
    r = d.lancer("review-pr-locale.sh", ["001-jouet"]);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.doesNotMatch(r.erreur, /jamais été ajoutés à Git/);
    d.ecrire("src/aide.py", "def aide():\n    return 1\n");
    r = d.lancer("review-pr-locale.sh", ["001-jouet"]);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.match(r.erreur, /AVERTISSEMENT : des fichiers n'ont jamais été ajoutés à Git/);
    assert.match(r.erreur, /\nsrc\/aide\.py\n/);
    assert.doesNotMatch(r.erreur, /review-pr\.(json|md)|harness\/state|\.travail/);
  });

  test("avec des chemins exclus, la review de diff porte la consigne de ne pas les ouvrir", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["secrets/"]; } });
    t.after(d.detruire);
    const trace = d.chemin("harness", ".travail", "trace.txt");
    for (const [script, args] of [["codex-diff-review.sh", []], ["review-pr-locale.sh", ["001-jouet"]]]) {
      d.ecrire("harness/.travail/trace.txt", "");
      const r = d.lancer(script, args, { env: { FAUX_CODEX_TRACE: trace } });
      assert.equal(r.code, 0, script + r.erreur + r.sortie);
      const appels = d.lire("harness", ".travail", "trace.txt");
      assert.match(appels, /\nexec\nreview\n/, script);
      assert.match(appels, /git diff main\.\.\.HEAD/, script);
      assert.match(appels, /N'ouvre AUCUN fichier sous ces chemins[^\n]*\n - secrets\//, script);
      // `--base` et un prompt ne vont pas ensemble : la consigne ne partirait pas.
      assert.doesNotMatch(appels, /\n--base\n/, script);
    }
  });

  test("un diff qui touche un chemin exclu ne part pas", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["secrets/", "*.pem"]; } });
    t.after(d.detruire);
    assert.equal(d.lancer("codex-diff-review.sh", []).code, 0, "un diff hors des chemins exclus part");
    d.ecrire("secrets/cle.txt", "valeur\n");
    commiter(d, "chore: fichier sensible", "secrets/cle.txt");
    for (const [script, args] of [["codex-diff-review.sh", []], ["review-pr-locale.sh", ["001-jouet"]]]) {
      const r = d.lancer(script, args);
      assert.equal(r.code, 1, script);
      assert.match(r.erreur, /secrets\/cle\.txt \(exclu par « secrets\/ »\)/);
    }
    assert.equal(d.existe(...ARTEFACT), false);
  });

  test("un fichier exclu DÉPLACÉ vers un chemin libre ne part pas non plus", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["secrets/"]; } });
    t.after(d.detruire);
    // Le fichier existe déjà sur la base : sur la branche, il ne fait que changer de place.
    d.git("checkout", "-q", "main");
    d.ecrire("secrets/cle.txt", "une valeur longue qui ne change pas\nsur plusieurs lignes\npour que Git y voie un renommage\n");
    commiter(d, "chore: fichier sensible", "secrets/cle.txt");
    d.git("checkout", "-q", "feat/001-jouet");
    d.git("merge", "-q", "--no-edit", "main");
    assert.equal(d.lancer("codex-diff-review.sh", []).code, 0, "rien d'exclu dans le diff de la branche");
    d.git("mv", "secrets/cle.txt", "docs-cle.txt");
    d.git("commit", "-q", "-m", "chore: déplacement");
    assert.equal(d.git("diff", "--name-only", "main...HEAD").includes("secrets/"), false, "Git ne nomme que la destination");
    for (const [script, args] of [["codex-diff-review.sh", []], ["review-pr-locale.sh", ["001-jouet"]]]) {
      const r = d.lancer(script, args);
      assert.equal(r.code, 1, script);
      assert.match(r.erreur, /secrets\/cle\.txt \(exclu par « secrets\/ »\)/);
    }
    assert.equal(d.existe(...ARTEFACT), false);
  });

  test("la consigne des chemins exclus est recopiée dans le prompt", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["donnees/clients/"]; } });
    t.after(d.detruire);
    const trace = d.chemin("harness", ".travail", "trace.txt");
    d.ecrire("harness/.travail/trace.txt", "");
    assert.equal(d.lancer("codex-challenge.sh", [SPEC], { env: { FAUX_CODEX_TRACE: trace } }).code, 0);
    const appels = d.lire("harness", ".travail", "trace.txt");
    assert.match(appels, /N'ouvre AUCUN fichier sous ces chemins/);
    assert.match(appels, / - donnees\/clients\//);
  });

  test("usage : 64, et la review de PR ne se lance pas depuis la branche d'intégration", (t) => {
    const d = chantier();
    t.after(d.detruire);
    assert.equal(d.lancer("codex-challenge.sh", []).code, 64);
    assert.equal(d.lancer("codex-plan-review.sh", []).code, 64);
    assert.equal(d.lancer("codex-arbitrer.sh", []).code, 64);
    assert.equal(d.lancer("codex-diff-review.sh", ["a.md", "b.md"]).code, 64);
    assert.equal(d.lancer("review-pr-locale.sh", []).code, 64);
    assert.equal(d.lancer("review-locale.mjs", []).code, 64);
    assert.equal(d.lancer("review-pr-locale.sh", ["999-absente"]).code, 1);
    d.git("checkout", "-q", "main");
    const r = d.lancer("review-pr-locale.sh", ["--branche"]);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /depuis la branche de la story/);
  });
});

describe("review de travail : le diff de la branche", () => {
  test("propre : 0 ; sans diff : 0 en le disant", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const trace = d.chemin("harness", ".travail", "trace.txt");
    d.ecrire("harness/.travail/trace.txt", "");
    const r = d.lancer("codex-diff-review.sh", [], { env: { FAUX_CODEX_TRACE: trace } });
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.deepEqual(d.lireJson(...RELECTEUR, "diff-review-feat_001-jouet.md.findings.json"), []);
    const appels = d.lire("harness", ".travail", "trace.txt");
    assert.match(appels, /\nexec\nreview\n/);
    assert.match(appels, /\n-c\nsandbox_mode="read-only"\n/);
    assert.match(appels, /\n--base\nmain\n/);

    d.git("checkout", "-q", "main");
    const vide = d.lancer("codex-diff-review.sh", []);
    assert.equal(vide.code, 0);
    assert.match(vide.sortie, /rien à relire/);
  });

  test("findings : 2, et le fichier rendu alimente le ledger tel quel", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = d.lancer("codex-diff-review.sh", [], mode("findings"));
    assert.equal(r.code, 2, r.erreur + r.sortie);
    assert.match(r.sortie, /1 finding\(s\) bloquant\(s\) P0 à P2, 1 mineur\(s\) écarté\(s\)/);
    const fichier = d.chemin(...RELECTEUR, "diff-review-feat_001-jouet.md.findings.json");
    const findings = d.lireJson(...RELECTEUR, "diff-review-feat_001-jouet.md.findings.json");
    assert.equal(findings.length, 1, "le P3 ne va pas au ledger");
    assert.deepEqual(Object.keys(findings[0]), ["cle", "titre", "severite", "fichier"]);
    assert.equal(findings[0].severite, "P1");
    assert.equal(findings[0].fichier, "src/garde.py");

    const etat = (args) => d.lancer("etat.mjs", args);
    assert.equal(etat(["init", "001-jouet", "--titre", "Jouet", "--regard-client", "non", "--perimetre", "src/**"]).code, 0);
    for (const args of [["stage", "001-jouet", "SPEC"], ["stage", "001-jouet", "CHALLENGE"],
      ["gate", "001-jouet", "spec", "auto", "--motif", "challenge solide"], ["stage", "001-jouet", "PLAN"], ["stage", "001-jouet", "CODE"]]) {
      assert.equal(etat(args).code, 0, args.join(" "));
    }
    const round = etat(["ledger-round", "001-jouet", "--findings", fichier]);
    assert.equal(round.code, 0, round.erreur);
    assert.deepEqual(JSON.parse(round.sortie).a_corriger, [findings[0].cle]);
  });
});

describe("review de PR : artefact commité et gate à trois codes", () => {
  test("propre : artefact écrit, gate verte, et le commit de l'artefact ne la périme pas", (t) => {
    const d = chantier();
    t.after(d.detruire);
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 3, "avant toute review : absente");

    const r = d.lancer("review-pr-locale.sh", ["001-jouet"]);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    const artefact = d.lireJson(...ARTEFACT);
    assert.equal(artefact.head_sha, d.git("rev-parse", "HEAD"));
    assert.equal(artefact.branche, "feat/001-jouet");
    assert.equal(artefact.base, "main");
    assert.match(d.lire("specs", "001-jouet", "review-pr.md"), /Aucun finding : la review est propre\./);
    assert.equal(d.existe("specs", "001-jouet", "review-pr.brut"), false, "le brut reste dans le dossier de travail");

    // Propre, mais pas encore sur la branche : la gate ne certifie pas un fichier du disque.
    let g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 3, g.sortie);
    assert.match(g.sortie, /n'est pas celui du commit/);
    assert.match(g.sortie, /commiter specs\/001-jouet\/review-pr\.json/);
    assert.doesNotMatch(g.sortie, /review-pr-locale\.sh/, "rien à relancer : il manque un commit");

    commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
    g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 0, g.sortie + g.erreur);
    assert.match(g.sortie, /review locale \[OK\]/);

    // Les documents de gestion de la story ne périment pas non plus.
    d.ecrire("specs/001-jouet/qa-rapport.md", "# QA\n\nGO\n");
    commiter(d, "docs: rapport de QA", "specs/001-jouet/qa-rapport.md");
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 0);

    // Du code, si.
    d.ecrire("src/garde.py", "def garde(valeur):\n    return bool(valeur)\n");
    commiter(d, "fix: garde", "src/garde.py");
    g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 3);
    assert.match(g.sortie, /\[ABSENTE\].*périmée.*src\/garde\.py/);
    assert.match(g.sortie, /review-pr-locale\.sh 001-jouet/);
  });

  test("du code relu, déplacé vers un document de la story, périme la review", (t) => {
    const d = chantier();
    t.after(d.detruire);
    assert.equal(d.lancer("review-pr-locale.sh", ["001-jouet"]).code, 0);
    commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 0);

    // Git, laissé à son réglage courant, ne nommerait que la destination, qui est exemptée.
    d.git("mv", "src/garde.py", "specs/001-jouet/qa-rapport.md");
    d.git("commit", "-q", "-m", "docs: rapport de QA");
    assert.equal(d.git("diff", "--name-only", "HEAD~1..HEAD"), "specs/001-jouet/qa-rapport.md");
    const g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 3, g.sortie);
    assert.match(g.sortie, /périmée.*src\/garde\.py/);
  });

  test("un document partagé ne périme pas la review SI une option active l'a déclaré", (t) => {
    const d = chantier();
    t.after(d.detruire);
    assert.equal(d.lancer("review-pr-locale.sh", ["001-jouet"]).code, 0);
    commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
    d.ecrire("specs/INDEX.md", "# Stories\n");
    d.ecrire("BACKLOG.md", "- `plus-tard` : un report.\n");
    commiter(d, "docs: index et backlog", "specs/INDEX.md", "BACKLOG.md");

    let g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 3, "options inactives : les deux fichiers périment");
    assert.match(g.sortie, /2 fichier\(s\) modifié\(s\)/);

    d.reconfigurer((c) => { c.options.note_story.actif = true; });
    g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 3, "l'index est couvert, le backlog non");
    assert.match(g.sortie, /1 fichier\(s\) modifié\(s\).*BACKLOG\.md/);

    d.reconfigurer((c) => { c.options.valeur.actif = true; c.chemins.backlog = "BACKLOG.md"; });
    g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 0, g.sortie + g.erreur);
  });

  test("findings : gate à 2 tant qu'un bloquant est sans statut, 0 une fois traité", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = d.lancer("review-pr-locale.sh", ["001-jouet"], mode("findings"));
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.match(r.sortie, /1 bloquant\(s\) P0 à P2 sans statut/);
    let g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 2);
    assert.match(g.sortie, /\[FINDINGS\]/);
    assert.match(g.sortie, /P1 src\/garde\.py:12 : La garde laisse passer une valeur vide/);

    const json = JSON.parse(d.lancer("review-locale.mjs", ["001-jouet", "--json"]).sortie);
    assert.equal(json.exit, 2);
    assert.equal(json.open_p0_p2, 1);
    assert.equal(json.a_jour, true);

    // Le correctif est commité, puis re-relu. Une réponse en PROSE ne ferme rien : l'absence
    // d'un finding dans un texte libre n'est pas une preuve qu'il est corrigé.
    d.ecrire("src/garde.py", "def garde(valeur):\n    return bool(valeur)\n");
    commiter(d, "fix: garde", "src/garde.py");
    assert.equal(d.lancer("review-pr-locale.sh", ["001-jouet"]).code, 0);
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 2);

    // Une réponse STRUCTURÉE sans ce finding le ferme, sans effacer sa trace.
    const structure = d.ecrire("harness/.travail/propre.json", JSON.stringify({ findings: [], overall_explanation: "Rien à signaler." }));
    assert.equal(d.lancer("review-pr-locale.sh", ["001-jouet"], { env: { FAUX_CODEX_SORTIE: structure } }).code, 0);
    commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
    g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 0, g.sortie);
    const findings = Object.values(d.lireJson(...ARTEFACT).findings);
    assert.equal(findings.length, 2);
    const p1 = findings.find((f) => f.severity === "P1");
    assert.equal(p1.statut, "corrige");
    assert.equal(p1.auto, true);
  });

  test("un finding se ferme aussi par un statut écrit à la main, avec sa note", (t) => {
    const d = chantier();
    t.after(d.detruire);
    assert.equal(d.lancer("review-pr-locale.sh", ["001-jouet"], mode("findings")).code, 0);
    const artefact = d.lireJson(...ARTEFACT);
    const cle = Object.keys(artefact.findings).find((k) => artefact.findings[k].severity === "P1");
    artefact.findings[cle].statut = "refute";
    artefact.findings[cle].note = "Réfuté : une valeur vide est filtrée par l'appelant.";
    d.ecrire("specs/001-jouet/review-pr.json", `${JSON.stringify(artefact, null, 2)}\n`);
    commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 0);

    // Une coquille dans le statut ne libère rien.
    artefact.findings[cle].statut = "refuté";
    d.ecrire("specs/001-jouet/review-pr.json", `${JSON.stringify(artefact, null, 2)}\n`);
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 2);
  });

  test("review-statut : pose le statut, exige la note d'une décision, refuse l'inconnu", (t) => {
    const d = chantier();
    t.after(d.detruire);
    assert.equal(d.lancer("review-pr-locale.sh", ["001-jouet"], mode("findings")).code, 0);
    const cle = Object.keys(d.lireJson(...ARTEFACT).findings).find((k) => d.lireJson(...ARTEFACT).findings[k].severity === "P1");

    let r = d.lancer("review-statut.mjs", ["001-jouet", cle, "refuté", "--note", "x"]);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /statut inconnu/);
    r = d.lancer("review-statut.mjs", ["001-jouet", cle, "refute"]);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /exige --note/);
    r = d.lancer("review-statut.mjs", ["001-jouet", "cle-absente", "corrige"]);
    assert.equal(r.code, 1);
    assert.match(r.erreur, new RegExp(cle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "le refus liste les clés connues");
    assert.equal(d.lancer("review-statut.mjs", ["001-jouet", cle]).code, 64);
    assert.equal(d.lireJson(...ARTEFACT).findings[cle].statut, null, "aucun refus n'a écrit");

    r = d.lancer("review-statut.mjs", ["001-jouet", cle, "refute", "--note", "Une valeur vide est filtrée par l'appelant.", "--escalade", "arbitre"]);
    assert.equal(r.code, 0, r.erreur);
    const f = d.lireJson(...ARTEFACT).findings[cle];
    assert.equal(f.statut, "refute");
    assert.equal(f.escalation, "arbitre");
    assert.equal(f.date_statut, "2030-01-15T10:00:00Z");
    assert.match(d.lire("specs", "001-jouet", "review-pr.md"), /filtrée par l'appelant/, "le Markdown suit le JSON");

    // Le statut est posé sur le disque, la branche porte encore le finding ouvert : pas de 0.
    commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.md");
    const g = d.lancer("review-locale.mjs", ["001-jouet"]);
    assert.equal(g.code, 3, g.sortie);
    assert.match(g.sortie, /n'est pas celui du commit/);
    assert.equal(JSON.parse(d.lancer("review-locale.mjs", ["001-jouet", "--json"]).sortie).exit, 3);
    commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.json");
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 0);

    // Rouvrir : la décision est effacée, le finding bloque de nouveau, et la raison reste lisible.
    assert.equal(d.lancer("review-statut.mjs", ["001-jouet", cle, "rouvrir"]).code, 1, "rouvrir exige une note");
    r = d.lancer("review-statut.mjs", ["001-jouet", cle, "rouvrir", "--note", "Le cas décrit vient de se produire."]);
    assert.equal(r.code, 0, r.erreur);
    const rouvert = d.lireJson(...ARTEFACT).findings[cle];
    assert.equal(rouvert.statut, null);
    assert.match(rouvert.note, /statut précédent : refute.*vient de se produire/);
    commiter(d, "docs: finding rouvert", "specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 2);
    assert.equal(d.lancer("review-statut.mjs", ["001-jouet", cle, "rouvrir", "--note", "encore"]).code, 1, "rien à rouvrir");
  });

  test("un artefact illisible n'est pas écrasé, et la gate reste fermée", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("specs/001-jouet/review-pr.json", "{ pas du json");
    const r = d.lancer("review-pr-locale.sh", ["001-jouet"]);
    assert.equal(r.code, 1);
    assert.equal(d.lire(...ARTEFACT), "{ pas du json");
    assert.equal(d.lancer("review-locale.mjs", ["001-jouet"]).code, 3);
  });

  test("--branche : une branche sans story a son artefact dans le dossier des reviews", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = d.lancer("review-pr-locale.sh", ["--branche"]);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    assert.equal(d.existe("harness", "reviews", "feat_001-jouet.json"), true);
    assert.equal(d.lancer("review-locale.mjs", ["harness/reviews/feat_001-jouet.json"]).code, 3, "pas encore commité");
    commiter(d, "docs: review de branche", "harness/reviews/feat_001-jouet.json", "harness/reviews/feat_001-jouet.md");
    assert.equal(d.lancer("review-locale.mjs", ["harness/reviews/feat_001-jouet.json"]).code, 0);
  });

  test("rien à relire : pas d'artefact, donc pas de certification", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.git("checkout", "-q", "-b", "feat/002-vide", "main");
    d.ecrire("specs/002-vide/.gitkeep", "");
    const r = d.lancer("review-pr-locale.sh", ["002-vide"]);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /rien à certifier/);
  });
});
