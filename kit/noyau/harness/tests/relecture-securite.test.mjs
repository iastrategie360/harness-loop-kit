import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { depotJouet, FAUX, ICI, lireJson } from "./aide.mjs";
import {
  cheminArtefactSecurite, combinerVerdicts, preuvesDeLAttestation, genererMarkdown, fusionner,
} from "../scripts/lib/review-pr-artefact.mjs";

// La gate combinée du NOYAU, quand l'option mistral exige la relecture sécurité. Ces tests ne
// lancent aucun relecteur Mistral : l'artefact sécurité est écrit par la fusion elle-même
// (review-pr-fusionner.mjs --source securite), comme le fait mistral-securite.sh. Ils tiennent
// donc sans l'option posée, et prouvent ce que le noyau garantit seul :
//   - option inactive, ou clé absente d'une configuration 1.0.0 : la gate est celle de 1.0.0 ;
//   - option active : une relecture sécurité absente rend 3, un finding sécurité ouvert bloque,
//     et écrire l'un des deux artefacts ne périme pas l'autre.

const ARTEFACT = ["specs", "001-jouet", "review-pr.json"];
const SECURITE = "specs/001-jouet/review-securite.json";

function avecMistral(c, plus = {}) {
  c.options.mistral = { ...c.options.mistral, actif: true, accord_envoi_externe: true, ...plus };
}

function chantier({ config = () => {} } = {}) {
  const d = depotJouet({
    config: (c) => { c.relecteur.accord_envoi_externe = true; config(c); },
    env: { PATH: `${FAUX}:${process.env.PATH}` },
  });
  d.git("checkout", "-q", "-b", "feat/001-jouet");
  d.ecrire("src/garde.py", "def garde(valeur):\n    return valeur is not None\n");
  d.ecrire("specs/001-jouet/spec.md", "# Spec\n\nLa garde refuse une valeur vide.\n");
  d.git("add", "-A");
  d.git("commit", "-q", "-m", "feat: garde");
  return d;
}

function commiter(d, message, ...fichiers) {
  d.git("add", ...fichiers);
  d.git("commit", "-q", "-m", message);
}

// La review de code, par le faux relecteur, puis commitée.
function reviewDeCode(d) {
  const r = d.lancer("review-pr-locale.sh", ["001-jouet"]);
  assert.equal(r.code, 0, r.erreur + r.sortie);
  commiter(d, "docs: review de PR", "specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
}

// La relecture sécurité telle que mistral-securite.sh la fusionne : une sortie au schéma, et
// l'attestation des lots relus.
function relectureSecurite(d, { findings = [], attestation = { lots_total: 1, lots_relus: 1, exclus: [], fichiers: ["src/garde.py"] } } = {}) {
  const brut = d.ecrire("harness/.travail/secu/fusion.json", JSON.stringify({ findings, overall_explanation: "Relecture sécurité." }));
  const att = d.ecrire("harness/.travail/secu/attestation.json", JSON.stringify(attestation));
  return d.lancer("review-pr-fusionner.mjs", [
    "--artefact", d.chemin(SECURITE), "--brut", brut, "--head-sha", d.git("rev-parse", "HEAD"),
    "--branche", "feat/001-jouet", "--base", "main", "--modele", "mistral:essai", "--racine", d.racine,
    "--source", "securite", "--attestation", att,
  ]);
}

const P1 = { priority: "P1", title: "Commande shell construite avec une entrée", body: "x", file: "src/garde.py", line_start: 2, line_end: 2 };
const gate = (d, ...plus) => d.lancer("review-locale.mjs", ["001-jouet", ...plus]);

describe("option inactive : la gate est celle de 1.0.0", () => {
  test("la configuration d'exemple de 1.0.0, sans clé options.mistral, reste valide", (t) => {
    const ancienne = lireJson(join(ICI, "fixtures", "config", "projet-1.0.0.json"));
    assert.equal(Object.hasOwn(ancienne.options, "mistral"), false, "la fixture est bien celle de 1.0.0");
    const d = depotJouet({ config: (c) => { for (const k of Object.keys(c)) delete c[k]; Object.assign(c, ancienne); } });
    t.after(d.detruire);
    const r = d.lancer("lib/config.mjs", ["valider"]);
    assert.equal(r.code, 0, r.erreur);
    assert.equal(d.lancer("lib/config.mjs", ["options"]).sortie, "");
  });

  test("configuration 1.0.0 : review de code propre et commitée, gate à 0, sans relecture sécurité", (t) => {
    const ancienne = lireJson(join(ICI, "fixtures", "config", "projet-1.0.0.json"));
    const d = chantier({ config: (c) => { for (const k of Object.keys(c)) delete c[k]; Object.assign(c, ancienne); c.relecteur.accord_envoi_externe = true; } });
    t.after(d.detruire);
    reviewDeCode(d);
    const r = gate(d, "--json");
    assert.equal(r.code, 0, r.sortie);
    const j = JSON.parse(r.sortie);
    assert.equal(Object.hasOwn(j, "securite"), false, "la sortie JSON garde sa forme de 1.0.0");
    assert.deepEqual(Object.keys(j), ["artefact", "existe", "head_courant", "head_reviewe", "a_jour", "exit", "motif", "open_p0_p2", "rounds", "findings"]);
  });

  test("option présente mais inactive, ou sans securite_pr : la relecture sécurité n'est pas exigée", (t) => {
    for (const reglage of [(c) => {}, (c) => avecMistral(c, { securite_pr: false })]) {
      const d = chantier({ config: reglage });
      t.after(d.detruire);
      reviewDeCode(d);
      assert.equal(gate(d).code, 0);
    }
  });
});

describe("option active : la gate exige aussi la relecture sécurité", () => {
  test("relecture sécurité absente : 3, et le message dit quoi lancer", (t) => {
    const d = chantier({ config: (c) => avecMistral(c) });
    t.after(d.detruire);
    reviewDeCode(d);
    const r = gate(d);
    assert.equal(r.code, 3);
    assert.match(r.sortie, /sécurité : artefact de review absent/);
    assert.match(r.sortie, /mistral-securite\.sh 001-jouet/);
    assert.doesNotMatch(r.sortie, /review-pr-locale\.sh/, "la review de code, elle, est là");
  });

  test("code propre et sécurité propre, commitées : 0, et aucune ne périme l'autre", (t) => {
    const d = chantier({ config: (c) => avecMistral(c) });
    t.after(d.detruire);
    reviewDeCode(d);
    let r = relectureSecurite(d);
    assert.equal(r.code, 0, r.erreur);
    assert.equal(gate(d).code, 3, "pas encore commitée : la gate ne certifie pas le disque");
    commiter(d, "docs: relecture sécurité", SECURITE, SECURITE.replace(/\.json$/, ".md"));
    r = gate(d, "--json");
    assert.equal(r.code, 0, r.sortie);
    const j = JSON.parse(r.sortie);
    assert.equal(j.securite.exit, 0);
    assert.equal(j.securite.artefact, SECURITE);
    // Dans l'autre sens : une nouvelle review de code, commitée APRÈS la relecture sécurité, ne
    // périme pas cette dernière.
    reviewDeCode(d);
    assert.equal(gate(d).code, 0);
    assert.match(d.lire(SECURITE.replace(/\.json$/, ".md")), /^# Relecture sécurité de PR/);
  });

  test("un finding sécurité P1 ouvert bloque la gate, même avec une review de code propre", (t) => {
    const d = chantier({ config: (c) => avecMistral(c) });
    t.after(d.detruire);
    reviewDeCode(d);
    assert.equal(relectureSecurite(d, { findings: [P1] }).code, 0);
    commiter(d, "docs: relecture sécurité", SECURITE, SECURITE.replace(/\.json$/, ".md"));
    let r = gate(d, "--json");
    assert.equal(r.code, 2, r.sortie);
    const j = JSON.parse(r.sortie);
    assert.equal(j.findings.length, 1);
    assert.equal(j.findings[0].source, "securite");
    assert.equal(j.securite.exit, 2);

    // Le statut se pose dans l'artefact sécurité, par le même script, avec --securite.
    const cle = Object.keys(d.lireJson(...SECURITE.split("/")).findings)[0];
    r = d.lancer("review-statut.mjs", ["001-jouet", cle, "corrige", "--securite"]);
    assert.equal(r.code, 0, r.erreur);
    assert.equal(d.lireJson(...ARTEFACT).findings[cle], undefined, "l'artefact de code n'est pas touché");
    commiter(d, "docs: statut", SECURITE, SECURITE.replace(/\.json$/, ".md"));
    assert.equal(gate(d).code, 0);
  });

  test("la gate lancée sur l'artefact sécurité lui-même est refusée (64)", (t) => {
    const d = chantier({ config: (c) => avecMistral(c) });
    t.after(d.detruire);
    reviewDeCode(d);
    assert.equal(relectureSecurite(d).code, 0);
    commiter(d, "docs: relecture sécurité", SECURITE, SECURITE.replace(/\.json$/, ".md"));
    for (const cible of [SECURITE, "harness/reviews/feat_x.securite.json"]) {
      const r = d.lancer("review-locale.mjs", [cible]);
      assert.equal(r.code, 64, cible);
      assert.match(r.erreur, /est l'artefact de la relecture sécurité/);
    }
    assert.equal(d.lancer("review-locale.mjs", ["specs/001-jouet/review-pr.json"]).code, 0);
  });

  test("du code qui bouge après la relecture sécurité la périme", (t) => {
    const d = chantier({ config: (c) => avecMistral(c) });
    t.after(d.detruire);
    assert.equal(relectureSecurite(d).code, 0);
    commiter(d, "docs: relecture sécurité", SECURITE, SECURITE.replace(/\.json$/, ".md"));
    d.ecrire("src/garde.py", "def garde(valeur):\n    return bool(valeur)\n");
    commiter(d, "fix: garde", "src/garde.py");
    reviewDeCode(d);
    const r = gate(d, "--json");
    assert.equal(r.code, 3);
    assert.match(JSON.parse(r.sortie).securite.motif, /review périmée/);
  });
});

describe("la fusion d'une relecture sécurité exige son attestation", () => {
  test("sans attestation : usage ; attestation partielle : rien n'est écrit", (t) => {
    const d = chantier({ config: (c) => avecMistral(c) });
    t.after(d.detruire);
    const brut = d.ecrire("harness/.travail/secu/fusion.json", JSON.stringify({ findings: [], overall_explanation: "x" }));
    const r = d.lancer("review-pr-fusionner.mjs", [
      "--artefact", d.chemin(SECURITE), "--brut", brut, "--head-sha", "abc", "--branche", "b", "--base", "main",
      "--source", "securite",
    ]);
    assert.equal(r.code, 64);
    const partielle = relectureSecurite(d, { attestation: { lots_total: 3, lots_relus: 2, exclus: [], fichiers: ["src/garde.py"] } });
    assert.equal(partielle.code, 1);
    assert.match(partielle.erreur, /NON RECEVABLE.*2 lot\(s\) relu\(s\) sur 3/);
    assert.equal(d.existe(SECURITE), false);
  });

  test("zéro lot n'est recevable que pour un diff entièrement exclu", (t) => {
    const d = chantier({ config: (c) => avecMistral(c) });
    t.after(d.detruire);
    assert.equal(relectureSecurite(d, { attestation: { lots_total: 0, lots_relus: 0, exclus: [], fichiers: [] } }).code, 1);
    assert.equal(d.existe(SECURITE), false);
    const r = relectureSecurite(d, { attestation: { lots_total: 0, lots_relus: 0, exclus: ["docs/a.md"], fichiers: [] } });
    assert.equal(r.code, 0, r.erreur);
    assert.deepEqual(d.lireJson(...SECURITE.split("/")).findings, {});
  });
});

describe("fonctions pures de la gate combinée", () => {
  test("cheminArtefactSecurite : à côté de l'artefact de code, jamais le même fichier", () => {
    assert.equal(cheminArtefactSecurite("specs/001-x/review-pr.json"), "specs/001-x/review-securite.json");
    assert.equal(cheminArtefactSecurite("harness/reviews/feat_x.json"), "harness/reviews/feat_x.securite.json");
    assert.equal(cheminArtefactSecurite("harness/reviews/feat_x.securite.json"), "harness/reviews/feat_x.securite.json");
  });

  test("combinerVerdicts : le plus prudent l'emporte, un code inconnu vaut 3", () => {
    const v = (code) => ({ code, motif: String(code) });
    const table = [[0, 0, 0], [0, 2, 2], [2, 0, 2], [0, 3, 3], [3, 0, 3], [2, 3, 3], [3, 2, 3], [0, 7, 3]];
    for (const [a, b, attendu] of table) assert.equal(combinerVerdicts(v(a), v(b)).code, attendu, `${a} et ${b}`);
    const o = combinerVerdicts({ code: 2, motif: "", ouverts: [{ cle: "a" }] }, { code: 2, motif: "", ouverts: [{ cle: "b" }] });
    assert.deepEqual(o.ouverts.map((f) => f.source), ["code", "securite"]);
  });

  test("preuvesDeLAttestation : une relecture à laquelle manque un lot ne prouve rien", () => {
    assert.ok(preuvesDeLAttestation({ lots_total: 2, lots_relus: 2, exclus: [], fichiers: ["a"] }).preuves);
    for (const mauvaise of [null, [], {}, { lots_total: 2, lots_relus: 1, exclus: [], fichiers: [] }, { lots_total: "2", lots_relus: 2 }, { lots_total: 0, lots_relus: 0, exclus: [], fichiers: [] }]) {
      assert.equal(preuvesDeLAttestation(mauvaise).preuves, null, JSON.stringify(mauvaise));
    }
  });

  test("le rendu d'une relecture sécurité se distingue de celui de la review de code", () => {
    const contexte = { headSha: "abc1234", date: "2030-01-15T10:00:00Z", modele: "m", branche: "b", base: "main" };
    const code = fusionner(null, [], contexte);
    const secu = fusionner(null, [], { ...contexte, source: "securite" });
    assert.equal(Object.hasOwn(code, "source"), false, "l'artefact de code garde sa forme de 1.0.0");
    assert.match(genererMarkdown(code), /^# Review de PR \(locale\)/);
    assert.match(genererMarkdown(secu), /^# Relecture sécurité de PR \(locale\)/);
  });
});

describe("l'échelle d'escalade et la liste de permissions", () => {
  const F = { cle: "src/garde.py--valeur-vide", titre: "La garde laisse passer une valeur vide", severite: "P1", fichier: "src/garde.py" };

  function story(config) {
    const d = depotJouet({ config });
    d.git("checkout", "-q", "-b", "feat/001-jouet");
    const ok = (args) => {
      const r = d.lancer("etat.mjs", args);
      assert.equal(r.code, 0, r.erreur + r.sortie);
      return r;
    };
    ok(["init", "001-jouet", "--titre", "Jouet", "--regard-client", "non", "--perimetre", "src/**"]);
    const round = (findings) => {
      const f = d.ecrire("harness/.travail/findings.json", JSON.stringify(findings));
      return JSON.parse(ok(["ledger-round", "001-jouet", "--findings", f]).sortie);
    };
    return { d, ok, round };
  }

  test("tranche finale active : après l'arbitre vient la tranche, puis l'humain", (t) => {
    const { d, ok, round } = story((c) => avecMistral(c));
    t.after(d.detruire);
    round([F]);
    round([F]);
    assert.deepEqual(round([F]).a_escalader, [{ cle: F.cle, vers: "arbitre" }]);
    ok(["escalade", "001-jouet", F.cle, "arbitre", "--verdict", "finding_valide"]);
    assert.deepEqual(round([F]).a_escalader, [{ cle: F.cle, vers: "tranche" }]);
    ok(["escalade", "001-jouet", F.cle, "tranche", "--verdict", "solution simple appliquée"]);
    assert.deepEqual(round([F]).a_escalader, [{ cle: F.cle, vers: "humain" }]);
    assert.match(ok(["fil", "001-jouet"]).sortie, /./);
    assert.ok(ok(["valider", "001-jouet"]));
  });

  test("un P0 ne va jamais à la tranche, et sans l'option l'étage n'existe pas", (t) => {
    const { d, ok, round } = story((c) => avecMistral(c));
    t.after(d.detruire);
    const P0 = { ...F, severite: "P0" };
    round([P0]);
    round([P0]);
    round([P0]);
    ok(["escalade", "001-jouet", F.cle, "arbitre", "--verdict", "finding_valide"]);
    assert.deepEqual(round([P0]).a_escalader, [{ cle: F.cle, vers: "humain" }]);

    const sans = story(() => {});
    t.after(sans.d.detruire);
    sans.round([F]);
    const r = sans.d.lancer("etat.mjs", ["escalade", "001-jouet", F.cle, "tranche", "--verdict", "x"]);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /tranche finale de l'option mistral/);
  });

  test("permissions : les scripts de l'option sont proposés, vibe nu est refusé", (t) => {
    const d = depotJouet({ config: (c) => avecMistral(c) });
    t.after(d.detruire);
    const p = JSON.parse(d.lancer("allowlist-verifier.mjs", ["proposer"]).sortie);
    assert.ok(p.permissions.allow.includes("Bash(bash harness/scripts/mistral-securite.sh:*)"));
    const f = d.ecrire("harness/.travail/reglages.json", JSON.stringify({ permissions: { allow: ["Bash(vibe -p:*)"] } }));
    const r = d.lancer("allowlist-verifier.mjs", ["verifier", f]);
    assert.equal(r.code, 1);
    assert.match(r.sortie + r.erreur, /le relecteur ne s'autorise jamais directement/);
    const sans = depotJouet();
    t.after(sans.detruire);
    const q = JSON.parse(sans.lancer("allowlist-verifier.mjs", ["proposer"]).sortie);
    assert.equal(q.permissions.allow.some((r2) => /mistral/.test(r2)), false);
  });
});

test("la fixture 1.0.0 est la configuration d'exemple de 1.0.0, recopiée sans retouche", () => {
  // Témoin de la fixture elle-même : une clé de 1.1.0 glissée dedans rendrait les tests de
  // compatibilité vides de sens.
  const texte = readFileSync(join(ICI, "fixtures", "config", "projet-1.0.0.json"), "utf8");
  assert.match(texte, /"version": "1\.0\.0"/);
  assert.doesNotMatch(texte, /mistral/);
});

describe("chemins exclus du noyau : motifs et copies", () => {
  test("« **/x/** » couvre aussi x à la racine, et pas un nom qui le contient", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["**/fixtures/**"]; } });
    t.after(d.detruire);
    d.ecrire("src/prefixtures/a.py", "A = 1\n");
    commiter(d, "feat: voisin", "src/prefixtures/a.py");
    assert.equal(d.lancer("review-pr-locale.sh", ["001-jouet"]).code, 0, "un nom qui contient le motif n'est pas exclu");
    d.ecrire("fixtures/reel.json", "{}\n");
    commiter(d, "chore: fixture", "fixtures/reel.json");
    const r = d.lancer("review-pr-locale.sh", ["001-jouet"]);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /fixtures\/reel\.json \(exclu par « \*\*\/fixtures\/\*\* »\)/);
  });

  test("la copie d'un fichier exclu resté intact fait refuser la review", (t) => {
    const d = depotJouet({
      config: (c) => { c.relecteur.accord_envoi_externe = true; c.relecteur.chemins_exclus = ["secrets/"]; },
      env: { PATH: `${FAUX}:${process.env.PATH}` },
    });
    t.after(d.detruire);
    d.ecrire("secrets/cle.txt", "une valeur qui ne doit pas sortir du dépôt\n".repeat(5));
    commiter(d, "chore: exclu", "secrets/cle.txt");
    d.git("checkout", "-q", "-b", "feat/001-jouet");
    d.ecrire("specs/001-jouet/spec.md", "# Spec\n");
    d.ecrire("src/copie.txt", d.lire("secrets", "cle.txt"));
    commiter(d, "chore: copie", "specs/001-jouet/spec.md", "src/copie.txt");
    const r = d.lancer("review-pr-locale.sh", ["001-jouet"]);
    assert.equal(r.code, 1, r.erreur);
    assert.match(r.erreur, /src\/copie\.txt \(copie ou déplacement d'un fichier exclu\)/);
  });
});
