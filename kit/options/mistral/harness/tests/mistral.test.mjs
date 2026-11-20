import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, cpSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { depotJouet, FAUX, HARNESS, SCRIPTS, lireJson } from "./aide.mjs";
import { controlerProfil, controlerProfilEffectif, lireProfil, listeInterdite, equivalentsGrep, profilEffectif, refusMotif, interditsParmi, controlerProfilSansOutils } from "../scripts/lib/profil-vibe.mjs";
import { spawnSync } from "node:child_process";
import { decouperDiff, octets, estExclu, cheminEnTete } from "../scripts/lib/decoupe-diff.mjs";

// Les témoins de l'option mistral, joués contre un FAUX CLI (tests/faux/vibe) : même surface que
// `vibe`, sans réseau, sans coût. Le faux refuse tout appel qui ne borne pas ses outils, donc un
// script qui l'oublierait rougit ici. Ce qui est gardé, et pourquoi :
//   1. LA COUVERTURE : le découpage en lots ne perd rien, sinon le relecteur conclurait « propre »
//      sur un préfixe du diff ;
//   2. LA LECTURE SEULE : profil fermé, denylists identiques, préflight qui refuse un profil
//      élargi, sortie écartée (code 5) quand le dépôt bouge ;
//   3. LE REFUS AVANT D'ENVOYER : sans accord, sans clé, budget dépassé, modèle mal nommé ;
//   4. JAMAIS DE VERT PARTIEL : un lot sans réponse, et aucun artefact n'est écrit ;
//   5. LA DÉCISION CONTRAIGNANTE : la tranche finale refuse un contexte tronqué.

const PROFIL = join(HARNESS, "vibe", "agents", "relecteur.toml");
const SECURITE = ["specs", "001-jouet", "review-securite.json"];

// Un dépôt avec une story en cours, l'option active et l'accord donné. Trois fichiers assez gros
// pour faire plusieurs lots sous une borne basse.
function chantier({ config = () => {}, accord = true, env = {} } = {}) {
  const bac = mkdtempSync(join(tmpdir(), "mistral-bac-"));
  const home = join(bac, "home");
  const trace = join(bac, "trace");
  mkdirSync(home, { recursive: true });
  // Les variables MISTRAL_*, VIBE_* et FAUX_* de la session qui lance les tests sont vidées : une
  // surcharge laissée dans le shell (un budget, un modèle) fausserait le témoin.
  const vides = Object.fromEntries(Object.keys(process.env).filter((k) => /^(MISTRAL_|VIBE_|FAUX_)/.test(k)).map((k) => [k, ""]));
  const d = depotJouet({
    config: (c) => {
      c.relecteur.accord_envoi_externe = true;
      c.options.mistral.actif = true;
      c.options.mistral.accord_envoi_externe = accord;
      config(c);
    },
  });
  const bacEnv = {
    ...vides, PATH: `${FAUX}:${process.env.PATH}`, HOME: home, VIBE_HOME: join(home, ".vibe"),
    MISTRAL_API_KEY: "cle-de-test-sans-valeur", FAUX_VIBE_TRACE: trace, MISTRAL_LOT_MAX_BYTES: "12000",
    MISTRAL_PARALLELE: "2", ...env,
  };
  d.git("checkout", "-q", "-b", "feat/001-jouet");
  for (const f of ["src/garde.py", "src/b.py", "src/c.py"]) {
    d.ecrire(f, `${Array.from({ length: 400 }, (_, i) => `V${i} = "${f}-${i}"`).join("\n")}\n`);
  }
  d.ecrire("specs/001-jouet/spec.md", "# Spec\n");
  d.git("add", "-A");
  d.git("commit", "-q", "-m", "feat: travail");
  const detruire = d.detruire;
  return {
    ...d,
    home,
    trace,
    // Lance un script du kit avec l'environnement du bac à sable.
    bacEnv,
    run(script, args = [], plus = {}) {
      return d.lancer(script, args, { env: { ...bacEnv, ...plus } });
    },
    appels() {
      if (!existsSync(trace)) return [];
      return readdirSync(trace).filter((n) => n.startsWith("appel-")).sort().map((n) => ({
        args: readFileSync(join(trace, n, "args"), "utf8").trim().split("\n"),
        env: readFileSync(join(trace, n, "env"), "utf8"),
        prompt: readFileSync(join(trace, n, "prompt"), "utf8"),
        profil: existsSync(join(trace, n, "profil")) ? readFileSync(join(trace, n, "profil"), "utf8") : null,
      }));
    },
    index() {
      return lireJson(d.chemin("harness", ".travail", "mistral", "securite-feat_001-jouet", "lots", "index.json"));
    },
    detruire() {
      detruire();
      rmSync(bac, { recursive: true, force: true });
    },
  };
}

const securite = (d, plus = {}) => d.run("mistral-securite.sh", ["001-jouet"], plus);

describe("le profil du relecteur : lecture seule par construction", () => {
  test("le profil livré est conforme, et ses deux denylists sont identiques", () => {
    const texte = readFileSync(PROFIL, "utf8");
    assert.deepEqual(controlerProfil(texte), []);
    const p = lireProfil(texte);
    const lecture = p.get("tools.read_file").get("denylist");
    assert.ok(lecture.length > 50, "la liste a bien été lue");
    assert.equal(p.get("tools.grep").get("denylist"), lecture);
    assert.match(texte, /^enabled_tools = \["read_file", "grep"\]$/m);
    assert.doesNotMatch(texte, /active_model|bypass_tool_permissions\s*=\s*true/);
  });

  test("un profil élargi est refusé : outil de plus, denylist différente, contournement, modèle", () => {
    const base = readFileSync(PROFIL, "utf8");
    const cas = {
      "outil de plus": base.replace('enabled_tools = ["read_file", "grep"]', 'enabled_tools = ["read_file", "grep", "bash"]'),
      // Une seule entrée de moins côté grep, hors du minimum exigé : seule l'égalité la voit.
      "denylist de grep plus courte": base.replace(/(\[tools\.grep\][\s\S]*?)  "\*\.p12",\n/, "$1"),
      "contournement des permissions": base.replace("safety = \"safe\"", "safety = \"safe\"\nbypass_tool_permissions = true"),
      "modèle choisi par le profil": base.replace("safety = \"safe\"", "safety = \"safe\"\nactive_model = \"autre\""),
      "section d'un outil d'écriture": `${base}\n[tools.write_file]\npermission = "always"\n`,
      "secrets absents des deux listes": base.replaceAll('  "*/.env",\n', ""),
      "contexte du dépôt rouvert": base.replace(/^include_project_context = false$/m, "include_project_context = true"),
      "détail du système rouvert": base.replace(/^include_prompt_detail = false$/m, ""),
      "prompt système personnel": base.replace(/^system_prompt_id = "cli"$/m, 'system_prompt_id = "perso"'),
      "clé inconnue": base.replace("safety = \"safe\"", "safety = \"safe\"\nskill_paths = [\"/tmp\"]"),
    };
    for (const [nom, texte] of Object.entries(cas)) {
      assert.notEqual(texte, base, `${nom} : la mutation a bien eu lieu`);
      assert.ok(controlerProfil(texte).length > 0, nom);
    }
  });

  test("le préflight refuse un profil élargi AVANT tout appel", (t) => {
    const d = chantier();
    t.after(d.detruire);
    // Une copie de l'outillage dans le dépôt jetable, dont on élargit le profil : le kit partagé
    // par les autres tests n'est pas touché.
    const copie = d.chemin("outillage");
    for (const dossier of ["scripts", "schemas", "vibe"]) cpSync(join(HARNESS, dossier), join(copie, dossier), { recursive: true });
    const profil = join(copie, "vibe", "agents", "relecteur.toml");
    writeFileSync(profil, readFileSync(profil, "utf8").replace('"grep"]', '"grep", "bash"]'));
    const lancer = (args) => d.run(relative(SCRIPTS, join(copie, "scripts", "mistral-preflight.sh")), args, { FAUX_VIBE_MODE: "pret" });
    let r = lancer(["--appel"]);
    assert.equal(r.code, 1, r.sortie);
    assert.match(r.erreur, /enabled_tools doit valoir exactement/);
    assert.deepEqual(d.appels(), [], "aucun appel n'est parti");
    // Le profil du kit, lui, passe, et l'appel réel répond.
    r = d.run("mistral-preflight.sh", ["--appel"], { FAUX_VIBE_MODE: "pret" });
    assert.equal(r.code, 0, r.erreur);
    assert.match(r.sortie, /appel réel : Mistral répond/);
    assert.deepEqual(d.appels()[0].args.filter((a) => a.startsWith("--enabled") || a.startsWith("re:")), ["--enabled-tools", "re:^$"]);
  });

  test("sans ripgrep dans le PATH : refus de toute session, avant tout appel", (t) => {
    const d = chantier();
    t.after(d.detruire);
    // Un PATH qui garde tous les outils de la machine, sauf rg : un dossier de liens.
    const bin = d.chemin("harness", ".travail", "bin-sans-rg");
    mkdirSync(bin, { recursive: true });
    for (const dossier of [FAUX, ...(process.env.PATH ?? "").split(":")]) {
      if (!dossier || !existsSync(dossier)) continue;
      for (const nom of readdirSync(dossier)) {
        if (nom === "rg" || existsSync(join(bin, nom))) continue;
        try { symlinkSync(join(dossier, nom), join(bin, nom)); } catch { /* nom illisible : sans effet */ }
      }
    }
    assert.equal(existsSync(join(bin, "rg")), false);
    d.ecrire("harness/.travail/f.json", JSON.stringify({ cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", fichier: "src/garde.py", arbitrage_precedent: "x" }));
    for (const [script, args] of [["mistral-preflight.sh", []], ["mistral-securite.sh", ["001-jouet"]], ["mistral-arbitrer.sh", ["harness/.travail/f.json"]], ["mistral-trancher.sh", ["harness/.travail/f.json"]]]) {
      const r = d.run(script, args, { PATH: bin, FAUX_VIBE_MODE: "verdict" });
      assert.equal(r.code, 1, `${script} : ${r.erreur}`);
      assert.match(r.erreur, /ripgrep \(rg\) introuvable/, script);
    }
    assert.deepEqual(d.appels(), []);
    assert.equal(d.run("mistral-preflight.sh", []).code, 0, "avec rg, le préflight passe");
  });

  test("le préflight refuse un vibe trop ancien, et sans appel réel il n'envoie rien", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = d.run("mistral-preflight.sh", [], { FAUX_VIBE_VERSION: "vibe 2.12.9" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /trop ancien/);
    r = d.run("mistral-preflight.sh", []);
    assert.equal(r.code, 0, r.erreur);
    assert.match(r.sortie, /clé Mistral présente \(valeur jamais affichée\)/);
    assert.doesNotMatch(r.sortie + r.erreur, /cle-de-test-sans-valeur/, "la clé ne s'affiche jamais");
    assert.deepEqual(d.appels(), []);
  });
});

describe("rien n'entre d'office dans le prompt système", () => {
  test("les trois scripts et l'appel du préflight chargent un profil qui coupe tout le contexte", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("harness/.travail/f.json", JSON.stringify({ cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", fichier: "src/garde.py", arbitrage_precedent: "x" }));
    assert.equal(securite(d).code, 0);
    assert.equal(d.run("mistral-arbitrer.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "verdict" }).code, 0);
    assert.equal(d.run("mistral-trancher.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "simple" }).code, 0);
    assert.equal(d.run("mistral-preflight.sh", ["--appel"], { FAUX_VIBE_MODE: "pret" }).code, 0);
    const vus = d.appels();
    assert.ok(vus.length >= 4);
    const agents = new Set();
    for (const v of vus) {
      agents.add(v.args[v.args.indexOf("--agent") + 1]);
      assert.ok(v.profil, "un profil est chargé à chaque appel");
      assert.match(v.profil, /^include_project_context = false$/m);
      assert.match(v.profil, /^include_prompt_detail = false$/m);
      assert.match(v.profil, /^system_prompt_id = "cli"$/m);
      assert.match(v.env, /^VIBE_INCLUDE_PROJECT_CONTEXT=false$/m);
      assert.match(v.env, /^VIBE_INCLUDE_PROMPT_DETAIL=false$/m);
    }
    assert.deepEqual([...agents].sort(), ["relecteur", "sans-outils"]);
  });

  test("le profil sans outil livré est conforme, et un profil qui rouvre est refusé", () => {
    const base = readFileSync(join(HARNESS, "vibe", "agents", "sans-outils.toml"), "utf8");
    assert.deepEqual(controlerProfilSansOutils(base), []);
    for (const [nom, texte] of Object.entries({
      "liste vide (tous les outils)": base.replace('enabled_tools = ["re:^$"]', "enabled_tools = []"),
      "un outil": base.replace('enabled_tools = ["re:^$"]', 'enabled_tools = ["read_file"]'),
      "contexte rouvert": base.replace(/^include_project_context = false$/m, "include_project_context = true"),
      "section d'outil": `${base}\n[tools.bash]\npermission = "always"\n`,
    })) {
      assert.notEqual(texte, base, nom);
      assert.ok(controlerProfilSansOutils(texte).length > 0, nom);
    }
  });
});

describe("refus avant tout envoi", () => {
  test("sans l'accord d'envoi propre à Mistral : refus net, même avec l'accord du relecteur de code", (t) => {
    const d = chantier({ accord: false });
    t.after(d.detruire);
    d.ecrire("x.json", JSON.stringify({ cle: "c", titre: "t", detail: "d", severite: "P2", refutation_codeur: "r", fichier: "src/garde.py" }));
    for (const [script, args] of [["mistral-securite.sh", ["001-jouet"]], ["mistral-preflight.sh", []], ["mistral-arbitrer.sh", ["x.json"]]]) {
      const r = d.run(script, args);
      assert.equal(r.code, 1, script);
      assert.match(r.erreur, /options\.mistral\.accord_envoi_externe est à false/, script);
    }
    assert.deepEqual(d.appels(), []);
    assert.equal(d.existe(...SECURITE), false);
  });

  test("option inactive : refus", (t) => {
    const d = chantier({ config: (c) => { c.options.mistral.actif = false; } });
    t.after(d.detruire);
    const r = securite(d);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /l'option mistral n'est pas active/);
  });

  test("sans clé : refus, et le message ne montre rien d'autre que le chemin attendu", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = securite(d, { MISTRAL_API_KEY: "" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /clé Mistral absente/);
    assert.deepEqual(d.appels(), []);
  });

  test("un nom de modèle qui casserait le JSON est refusé avant tout appel", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = securite(d, { MISTRAL_REVIEW_MODEL: 'x","provider":"autre' });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /nom de modèle Mistral invalide/);
    assert.deepEqual(d.appels(), []);
  });

  test("budget global dépassé : refus AVANT le premier appel", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = securite(d, { MISTRAL_BUDGET_REVUE: "0.5" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /au-dessus du budget de relecture \(0\.5 USD\)\. Aucun appel n'est parti/);
    assert.ok(d.index().lots.length > 1, "le refus porte bien sur plusieurs lots");
    assert.deepEqual(d.appels(), []);
    assert.equal(d.existe(...SECURITE), false);
  });
});

describe("la relecture sécurité de PR", () => {
  test("un appel par lot, chaque lot entier dans son prompt, modèle et prix de la configuration, ~/.vibe intact", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = securite(d);
    assert.equal(r.code, 0, r.erreur + r.sortie);
    const idx = d.index();
    const vus = d.appels();
    assert.ok(idx.lots.length > 1);
    assert.equal(vus.length, idx.lots.length);
    for (const lot of idx.lots) {
      const contenu = readFileSync(lot.chemin, "utf8");
      assert.equal(vus.filter((v) => v.prompt.includes(contenu)).length, 1, lot.chemin);
    }
    for (const v of vus) {
      assert.match(v.env, /^VIBE_ACTIVE_MODEL=mistral-large-4$/m);
      assert.match(v.env, /VIBE_MODELS=\[\{"name":"mistral-large-4".*"input_price":1\.36,"output_price":4\.18/);
      assert.match(v.env, /VIBE_AGENT_PATHS=\[".*\/harness\/\.travail\/mistral\/vibe-agents"\]/);
      const a = v.args.join(" ");
      assert.match(a, /--agent relecteur --enabled-tools read_file --enabled-tools grep/);
      assert.match(a, /--max-price 0\.5/);
      assert.match(v.prompt, /projet « Mon projet »/);
      assert.match(v.prompt, /Isolation entre clients/);
    }
    assert.equal(existsSync(join(d.home, ".vibe")), false, "rien n'est écrit dans ~/.vibe");
    const art = d.lireJson(...SECURITE);
    assert.equal(art.source, "securite");
    assert.equal(art.modele, "mistral:mistral-large-4");
    assert.match(art.synthese.verdict, new RegExp(`coût ${(0.0125 * idx.lots.length).toFixed(4).replace(/0+$/, "")} USD`));
    assert.match(d.lire("specs", "001-jouet", "review-securite.md"), /^# Relecture sécurité de PR/);
  });

  test("gate combinée : code propre et sécurité propre donnent 0, un finding sécurité P1 bloque", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const commiter = (...f) => { d.git("add", ...f); d.git("commit", "-q", "-m", "docs: relectures"); };
    let r = d.run("review-pr-locale.sh", ["001-jouet"]);
    assert.equal(r.code, 0, r.erreur);
    commiter("specs/001-jouet/review-pr.json", "specs/001-jouet/review-pr.md");
    assert.equal(d.run("review-locale.mjs", ["001-jouet"]).code, 3, "sans relecture sécurité, la gate reste fermée");
    assert.equal(securite(d).code, 0);
    commiter("specs/001-jouet/review-securite.json", "specs/001-jouet/review-securite.md");
    r = d.run("review-locale.mjs", ["001-jouet"]);
    assert.equal(r.code, 0, r.sortie);
    // Une relecture qui trouve une faille : la gate ne rend plus 0.
    r = securite(d, { FAUX_VIBE_MODE: "p1" });
    assert.equal(r.code, 0, r.erreur);
    commiter("specs/001-jouet/review-securite.json", "specs/001-jouet/review-securite.md");
    r = d.run("review-locale.mjs", ["001-jouet", "--json"]);
    assert.equal(r.code, 2, r.sortie);
    assert.equal(JSON.parse(r.sortie).findings[0].source, "securite");
  });

  test("diff entièrement exclu : un artefact explicite à zéro finding, sans aucun appel", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.git("checkout", "-q", "-b", "feat/002-doc", "main");
    d.ecrire("docs/guide.md", "# Guide\n");
    d.ecrire("specs/002-doc/spec.md", "# Spec\n");
    d.git("add", "-A");
    d.git("commit", "-q", "-m", "docs: guide");
    const r = d.run("mistral-securite.sh", ["002-doc"]);
    assert.equal(r.code, 0, r.erreur);
    assert.deepEqual(d.appels(), [], "rien à relire, rien d'envoyé");
    const art = d.lireJson("specs", "002-doc", "review-securite.json");
    assert.deepEqual(art.findings, {});
    assert.match(art.synthese.verdict, /tous les fichiers du diff sont exclus par nature\. Exclus : docs\/guide\.md, specs\/002-doc\/spec\.md/);
  });

  test("un fichier relu DÉPLACÉ vers un chemin exclu reste relu sous son ancien nom", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.git("checkout", "-q", "-b", "feat/003-depl", "main");
    d.ecrire("src/a.py", "def a():\n    return 1\n");
    d.git("add", "src/a.py");
    d.git("commit", "-q", "-m", "feat: a");
    d.git("checkout", "-q", "main");
    d.git("merge", "-q", "--no-edit", "feat/003-depl");
    d.git("checkout", "-q", "feat/003-depl");
    mkdirSync(d.chemin("docs"), { recursive: true });
    d.git("mv", "src/a.py", "docs/a.md");
    d.ecrire("specs/003-depl/spec.md", "# Spec\n");
    d.git("add", "-A");
    d.git("commit", "-q", "-m", "docs: a devient une note");
    const r = d.run("mistral-securite.sh", ["003-depl"]);
    assert.equal(r.code, 0, r.erreur);
    const idx = lireJson(d.chemin("harness", ".travail", "mistral", "securite-feat_003-depl", "lots", "index.json"));
    assert.ok(idx.lots.length >= 1, "au moins un lot : la suppression de src/a.py");
    const texte = idx.lots.map((l) => readFileSync(l.chemin, "utf8")).join("");
    assert.match(texte, /diff --git a\/src\/a\.py b\/src\/a\.py\ndeleted file mode/);
    assert.ok(d.appels().some((v) => v.prompt.includes("deleted file mode")));
  });

  test("un seul lot en échec : relecture non aboutie, aucun artefact (code 1)", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = securite(d, { FAUX_VIBE_MODE: "echec-lot-2", MISTRAL_ESSAIS: "1" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /lot 2 sur \d+ sans réponse exploitable/);
    assert.match(r.erreur, /AUCUN artefact écrit/);
    assert.equal(d.existe(...SECURITE), false);
  });

  test("un lot à la réponse hors schéma : aucun artefact, et la reprise le relance", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = securite(d, { FAUX_VIBE_MODE: "lot2-casse" });
    assert.equal(r.code, 1);
    assert.equal(d.existe(...SECURITE), false);
    const premiers = d.appels().length;
    r = securite(d, { MISTRAL_REPRISE: "1" });
    assert.equal(r.code, 0, r.erreur);
    assert.equal(d.appels().length - premiers, 1, "seul le lot fautif repart");
  });

  test("reprise : seuls les lots sans réponse repartent, et un dépôt changé invalide tout", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = securite(d, { FAUX_VIBE_MODE: "echec-lot-2", MISTRAL_ESSAIS: "1" });
    assert.equal(r.code, 1);
    const premiers = d.appels().length;
    r = securite(d, { MISTRAL_REPRISE: "1" });
    assert.equal(r.code, 0, r.erreur);
    assert.equal(d.appels().length - premiers, 1);
    assert.match(r.erreur, /repris/);
    d.ecrire("src/d.py", "D = 1\n");
    d.git("add", "src/d.py");
    d.git("commit", "-q", "-m", "feat: d");
    const avant = d.appels().length;
    r = securite(d, { MISTRAL_REPRISE: "1" });
    assert.equal(r.code, 0, r.erreur);
    assert.match(r.erreur, /reprise REFUSÉE/);
    assert.ok(d.appels().length - avant >= premiers);
  });

  test("le relecteur ÉCRIT dans le dépôt : code 5, sortie écartée, rien n'est annulé", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const r = securite(d, { FAUX_VIBE_MODE: "ecrit" });
    assert.equal(r.code, 5, r.erreur);
    assert.match(r.erreur, /a MODIFIÉ le dépôt/);
    assert.equal(d.existe(...SECURITE), false);
    // Comme pour le relecteur de code : le harness ne répare pas à la place de l'humain.
    assert.match(d.lire("README.md"), /modifié par le relecteur/);
  });

  test("après un code 5, aucune réponse n'est reprise, même sur un checkout restauré", (t) => {
    const d = chantier();
    t.after(d.detruire);
    let r = securite(d, { FAUX_VIBE_MODE: "ecrit" });
    assert.equal(r.code, 5, r.erreur);
    const total = d.index().lots.length;
    for (const lot of d.index().lots) assert.equal(existsSync(`${lot.chemin}.ok`), false, lot.chemin);
    d.git("checkout", "--", "README.md");
    const avant = d.appels().length;
    r = securite(d, { MISTRAL_REPRISE: "1" });
    assert.equal(r.code, 0, r.erreur);
    assert.doesNotMatch(r.erreur, /repris/);
    assert.equal(d.appels().length - avant, total, "tous les lots repartent");
  });

  test("un hoquet réseau a droit à un nouvel essai ; un plafond de coût jamais", (t) => {
    let d = chantier();
    t.after(() => d.detruire());
    let r = securite(d, { FAUX_VIBE_MODE: "reseau-puis-ok", MISTRAL_PARALLELE: "1" });
    assert.equal(r.code, 0, r.erreur);
    assert.match(r.erreur, /nouvel essai/);
    assert.equal(d.appels().length, d.index().lots.length + 1, "un seul appel de plus");
    const premier = d;
    d = chantier();
    t.after(() => d.detruire());
    r = securite(d, { FAUX_VIBE_MODE: "plafond" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /plafond de session atteint/);
    assert.equal(d.appels().length, d.index().lots.length, "un appel par lot, aucun nouvel essai");
    premier.detruire();
  });

  test("un diff qui touche un chemin exclu par le projet ne part pas", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["secrets/"]; } });
    t.after(d.detruire);
    d.ecrire("secrets/cle.txt", "valeur\n");
    d.git("add", "secrets/cle.txt");
    d.git("commit", "-q", "-m", "chore: sensible");
    const r = securite(d);
    assert.equal(r.code, 1);
    // Un seul contrôle, celui de la liste interdite, nomme le fichier.
    assert.match(r.erreur, /^ {2}secrets\/cle\.txt$/m);
    assert.match(r.erreur, /le diff touche un fichier de secrets ou un chemin exclu/);
    assert.deepEqual(d.appels(), []);
  });
});

describe("l'arbitre et la tranche finale", () => {
  const finding = (plus = {}) => JSON.stringify({
    cle: "src/garde.py--valeur-vide", titre: "La garde laisse passer une valeur vide", severite: "P2",
    fichier: "src/garde.py:12", detail: "Une chaîne vide passe.", refutation_codeur: "Filtré en amont.", ...plus,
  });

  test("arbitre : le verdict est écrit au schéma du noyau, en lecture seule", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("harness/.travail/f.json", finding());
    const r = d.run("mistral-arbitrer.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "verdict" });
    assert.equal(r.code, 0, r.erreur);
    assert.equal(d.lireJson("harness", ".travail", "f.arbitration.json").verdict, "faux_positif");
    const [appel] = d.appels();
    assert.match(appel.args.join(" "), /--agent relecteur --enabled-tools read_file --enabled-tools grep/);
    assert.match(appel.prompt, /diff --git a\/src\/garde\.py/, "le diff est limité au fichier, sans le suffixe de ligne");
    assert.doesNotMatch(appel.prompt, /src\/b\.py/);
    d.ecrire("harness/.travail/g.json", JSON.stringify({ cle: "x", titre: "t" }));
    assert.equal(d.run("mistral-arbitrer.sh", ["harness/.travail/g.json"]).code, 1);
  });

  test("tranche : autre modèle, AUCUN outil, source complète, décision au schéma", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("harness/.travail/f.json", finding({ arbitrage_precedent: { verdict: "finding_valide", correctif_suggere: "refuser le vide" } }));
    const r = d.run("mistral-trancher.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "simple" });
    assert.equal(r.code, 0, r.erreur);
    assert.deepEqual(d.lireJson("harness", ".travail", "f.simplification.json").fichiers_touches, ["src/garde.py"]);
    const [appel] = d.appels();
    assert.match(appel.env, /^VIBE_ACTIVE_MODEL=mistral-medium-3\.5$/m);
    assert.deepEqual(appel.args.filter((a, i) => appel.args[i - 1] === "--agent"), ["sans-outils"], "le profil dédié, pas celui du relecteur");
    assert.deepEqual(appel.args.filter((a, i) => appel.args[i - 1] === "--enabled-tools"), ["re:^$"]);
    assert.match(appel.prompt, /=== CONTENU COMPLET DE src\/garde\.py ===\nV0 = /);
  });

  test("tranche : un diff tronqué est un refus, avant tout appel", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("harness/.travail/f.json", finding({ arbitrage_precedent: "finding_valide" }));
    const r = d.run("mistral-trancher.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "simple", MISTRAL_TRANCHE_DIFF_MAX: "100" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /diff tronqué .* contexte incomplet pour une décision contraignante/);
    assert.deepEqual(d.appels(), []);
    assert.equal(d.existe("harness", ".travail", "f.simplification.json"), false);
  });

  test("tranche : jamais sur un P0, jamais sans arbitrage précédent, jamais sur un prompt trop gros", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("harness/.travail/p0.json", finding({ severite: "P0", arbitrage_precedent: "finding_valide" }));
    let r = d.run("mistral-trancher.sh", ["harness/.travail/p0.json"], { FAUX_VIBE_MODE: "simple" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /un P0 ne se tranche pas/);
    d.ecrire("harness/.travail/nu.json", finding());
    r = d.run("mistral-trancher.sh", ["harness/.travail/nu.json"], { FAUX_VIBE_MODE: "simple" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /arbitrage_precedent/);
    d.ecrire("harness/.travail/gros.json", finding({ arbitrage_precedent: "finding_valide" }));
    r = d.run("mistral-trancher.sh", ["harness/.travail/gros.json"], { FAUX_VIBE_MODE: "simple", MISTRAL_PROMPT_MAX_OCTETS: "2000" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /refus plutôt que troncature/);
    assert.deepEqual(d.appels(), []);
  });
});

describe("les chemins exclus par le projet ne partent jamais chez l'arbitre ni chez la tranche", () => {
  const finding = (plus = {}) => JSON.stringify({
    cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", arbitrage_precedent: "finding_valide", ...plus,
  });
  // Une branche qui touche un fichier exclu, et, sur demande, un déplacement d'un exclu vers un
  // chemin libre (cas où l'arbitre et la tranche refusent l'appel entier).
  function avecSecret({ deplacement = false } = {}) {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["secrets/"]; } });
    // L'exclu à déplacer existe déjà sur la branche d'intégration : c'est là que Git voit un
    // déplacement (un fichier créé puis déplacé dans la même branche n'est qu'un ajout).
    d.git("checkout", "-q", "main");
    d.ecrire("secrets/autre.txt", "CONTENU-SECRET-B\n");
    d.git("add", "secrets/autre.txt");
    d.git("commit", "-q", "-m", "chore: exclu ancien");
    d.git("checkout", "-q", "feat/001-jouet");
    d.git("merge", "-q", "--no-edit", "main");
    d.ecrire("secrets/cle.txt", "CONTENU-SECRET-A\n");
    d.git("add", "-A");
    d.git("commit", "-q", "-m", "chore: sensible");
    if (deplacement) {
      d.git("mv", "secrets/autre.txt", "src/copie.txt");
      d.git("commit", "-q", "-m", "chore: déplacement");
    }
    return d;
  }
  const scripts = [["mistral-arbitrer.sh", "verdict"], ["mistral-trancher.sh", "simple"]];

  test("un finding qui ne porte que sur un chemin exclu : refus, aucun appel", (t) => {
    const d = avecSecret();
    t.after(d.detruire);
    for (const fichier of ["secrets/cle.txt"]) {
      d.ecrire("harness/.travail/f.json", finding({ fichier }));
      for (const [script, mode] of scripts) {
        const r = d.run(script, ["harness/.travail/f.json"], { FAUX_VIBE_MODE: mode });
        assert.equal(r.code, 1, `${script} ${fichier}`);
        assert.match(r.erreur, /ne porte que sur des chemins exclus/, `${script} ${fichier}`);
      }
    }
    assert.deepEqual(d.appels(), []);
  });

  test("un fichier permis ET un exclu : la tranche refuse, l'arbitre garde le permis", (t) => {
    const d = avecSecret();
    t.after(d.detruire);
    d.ecrire("harness/.travail/f.json", finding({ fichier: "src/garde.py", fichiers_touches: ["secrets/cle.txt"] }));
    let r = d.run("mistral-trancher.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "simple" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /un fichier requis par le finding est exclu/);
    assert.deepEqual(d.appels(), []);
    r = d.run("mistral-arbitrer.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "verdict" });
    assert.equal(r.code, 0, r.erreur);
    assert.doesNotMatch(d.appels()[0].prompt, /CONTENU-SECRET/);
  });

  test("la COPIE d'un exclu laissé intact est interdite comme l'exclu (--find-copies-harder)", (t) => {
    const d = avecSecret();
    t.after(d.detruire);
    // Un exclu présent sur la branche d'intégration et que la branche ne modifie pas : sans
    // --find-copies-harder, Git ne le regarde pas comme source, et la copie passe pour un ajout.
    d.git("checkout", "-q", "main");
    d.ecrire("secrets/intact.txt", "CONTENU-SECRET-C intact\n".repeat(4));
    d.git("add", "secrets/intact.txt");
    d.git("commit", "-q", "-m", "chore: exclu intact");
    d.git("checkout", "-q", "feat/001-jouet");
    d.git("merge", "-q", "--no-edit", "main");
    d.ecrire("src/copie-intacte.txt", d.lire("secrets", "intact.txt"));
    d.git("add", "src/copie-intacte.txt");
    d.git("commit", "-q", "-m", "chore: copie");
    // La copie interdite fait refuser l'appel entier, quel que soit le fichier du finding.
    for (const fichier of ["src/copie-intacte.txt", "README.md"]) {
      d.ecrire("harness/.travail/f.json", finding({ fichier }));
      for (const [script, mode] of scripts) {
        const r = d.run(script, ["harness/.travail/f.json"], { FAUX_VIBE_MODE: mode });
        assert.equal(r.code, 1, `${script} ${fichier} : ${r.erreur}`);
        assert.match(r.erreur, /^ {2}src\/copie-intacte\.txt$/m);
        assert.match(r.erreur, /porte une copie ou un déplacement/);
      }
    }
    assert.deepEqual(d.appels(), []);
  });

  test("un DÉPLACEMENT d'un exclu sur la branche : l'arbitre et la tranche refusent l'appel entier", (t) => {
    const d = avecSecret({ deplacement: true });
    t.after(d.detruire);
    for (const fichier of ["README.md", "src/garde.py", "src/copie.txt"]) {
      d.ecrire("harness/.travail/f.json", finding({ fichier }));
      for (const [script, mode] of scripts) {
        const r = d.run(script, ["harness/.travail/f.json"], { FAUX_VIBE_MODE: mode });
        assert.equal(r.code, 1, `${script} ${fichier}`);
        assert.match(r.erreur, /porte une copie ou un déplacement/, `${script} ${fichier}`);
      }
    }
    assert.deepEqual(d.appels(), []);
  });

  test("le repli sur le diff de la branche et le contenu complet n'emportent aucun exclu", (t) => {
    const d = avecSecret();
    t.after(d.detruire);
    // Un fichier du finding sans diff : repli sur le diff de la branche, qui touche les exclus.
    d.ecrire("harness/.travail/f.json", finding({ fichier: "README.md" }));
    d.ecrire("harness/.travail/g.json", finding({ fichier: "src/garde.py" }));
    for (const [script, mode] of scripts) {
      for (const f of ["f", "g"]) {
        const r = d.run(script, [`harness/.travail/${f}.json`], { FAUX_VIBE_MODE: mode });
        assert.equal(r.code, 0, `${script} ${f} : ${r.erreur}`);
      }
    }
    const vus = d.appels();
    assert.equal(vus.length, 4);
    for (const v of vus) {
      assert.doesNotMatch(v.prompt, /CONTENU-SECRET|diff --git a\/secrets/);
    }
    assert.ok(vus.some((v) => /diff --git a\/src\/garde\.py/.test(v.prompt)), "le reste du diff part bien");
  });
});

describe("les chemins d'un finding sont canonisés avant tout contrôle", () => {
  const finding = (fichier) => JSON.stringify({
    cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", arbitrage_precedent: "finding_valide", fichier,
  });
  const scripts = [["mistral-arbitrer.sh", "verdict"], ["mistral-trancher.sh", "simple"]];

  test("« ./ », « .. » et un lien vers un exclu ne contournent pas l'exclusion", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["secrets/"]; } });
    t.after(d.detruire);
    d.ecrire("secrets/cle.txt", "CONTENU-SECRET\n");
    symlinkSync("../secrets/cle.txt", d.chemin("src", "lien.txt"));
    d.git("add", "-A");
    d.git("commit", "-q", "-m", "chore: sensible et lien");
    for (const fichier of ["./secrets/cle.txt", "src/../secrets/cle.txt", "secrets//cle.txt", "src/lien.txt", `${d.racine}/secrets/cle.txt`]) {
      d.ecrire("harness/.travail/f.json", finding(fichier));
      for (const [script, mode] of scripts) {
        const r = d.run(script, ["harness/.travail/f.json"], { FAUX_VIBE_MODE: mode });
        assert.equal(r.code, 1, `${script} ${fichier} : ${r.erreur}`);
        assert.match(r.erreur, /ne porte que sur des chemins exclus/, `${script} ${fichier}`);
      }
    }
    assert.deepEqual(d.appels(), []);
  });

  test("un chemin qui sort du checkout est refusé, lien compris", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const dehors = join(d.home, "dehors.txt");
    writeFileSync(dehors, "HORS-DEPOT\n");
    symlinkSync(dehors, d.chemin("src", "fuite.txt"));
    d.git("add", "-A");
    d.git("commit", "-q", "-m", "chore: lien sortant");
    for (const fichier of ["../dehors.txt", "src/../../x.txt", "/etc/hostname", "src/fuite.txt"]) {
      d.ecrire("harness/.travail/f.json", finding(fichier));
      for (const [script, mode] of scripts) {
        const r = d.run(script, ["harness/.travail/f.json"], { FAUX_VIBE_MODE: mode });
        assert.equal(r.code, 1, `${script} ${fichier}`);
        assert.match(r.erreur, /sort du checkout/, `${script} ${fichier}`);
      }
    }
    assert.deepEqual(d.appels(), []);
  });
});

describe("la tranche finale exige le contenu de chaque fichier du finding", () => {
  const finding = (plus) => JSON.stringify({
    cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", arbitrage_precedent: "finding_valide", ...plus,
  });

  test("sans fichier, ou avec un fichier inconnu : refus avant tout appel", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("harness/.travail/a.json", finding({}));
    let r = d.run("mistral-trancher.sh", ["harness/.travail/a.json"], { FAUX_VIBE_MODE: "simple" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /ne nomme aucun fichier/);
    d.ecrire("harness/.travail/b.json", finding({ fichier: "src/garde.py", fichiers_touches: ["src/inconnu.py"] }));
    r = d.run("mistral-trancher.sh", ["harness/.travail/b.json"], { FAUX_VIBE_MODE: "simple" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /« src\/inconnu\.py » n'existe pas dans le checkout/);
    assert.deepEqual(d.appels(), []);
  });

  test("un fichier supprimé par la branche est nommé comme tel dans le prompt", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.git("rm", "-q", "README.md");
    d.git("commit", "-q", "-m", "chore: retire le README");
    d.ecrire("harness/.travail/c.json", finding({ fichier: "README.md" }));
    const r = d.run("mistral-trancher.sh", ["harness/.travail/c.json"], { FAUX_VIBE_MODE: "simple" });
    assert.equal(r.code, 0, r.erreur);
    assert.match(d.appels()[0].prompt, /=== README\.md : supprimé par la branche/);
  });
});

describe("les chemins exclus du projet sont des interdits des outils, pas une consigne", () => {
  test("le profil chargé par vibe porte « private/** » dans les DEUX denylists et le parcours de grep", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["private/**"]; } });
    t.after(d.detruire);
    d.ecrire("harness/.travail/f.json", JSON.stringify({ cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", fichier: "src/garde.py" }));
    const r = d.run("mistral-arbitrer.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "verdict" });
    assert.equal(r.code, 0, r.erreur);
    const [appel] = d.appels();
    assert.match(appel.env, /VIBE_AGENT_PATHS=\[".*\/harness\/\.travail\/mistral\/vibe-agents"\]/, "vibe charge le profil effectif, pas le livré");
    assert.ok(appel.profil, "le profil effectif a été chargé");
    const p = lireProfil(appel.profil);
    const racine = realpathSync(d.racine);
    for (const outil of ["tools.read_file", "tools.grep"]) {
      const liste = JSON.parse(p.get(outil).get("denylist").replace(/,\s*\]$/, "]"));
      for (const e of [`${racine}/private`, `${racine}/private/*`, `${racine}/private/**`]) assert.ok(liste.includes(e), `${outil} : ${e}`);
    }
    assert.match(p.get("tools.grep").get("exclude_patterns"), /"private\/\*\*"/);
    assert.deepEqual(controlerProfil(appel.profil), [], "le profil effectif reste conforme");
    assert.deepEqual(controlerProfilEffectif(appel.profil, racine, ["private/**"]), []);
    assert.ok(controlerProfilEffectif(readFileSync(PROFIL, "utf8"), racine, ["private/**"]).length > 0, "le livré seul ne passe pas");
  });

  test("un finding qui nomme plus de vingt fichiers est refusé, jamais tronqué", (t) => {
    const d = chantier();
    t.after(d.detruire);
    const fichiers = Array.from({ length: 21 }, (_, i) => `src/f${i}.py`);
    d.ecrire("harness/.travail/f.json", JSON.stringify({ cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", fichier: "src/garde.py", fichiers_touches: fichiers.slice(1), arbitrage_precedent: "x" }));
    for (const [script, mode] of [["mistral-arbitrer.sh", "verdict"], ["mistral-trancher.sh", "simple"]]) {
      const r = d.run(script, ["harness/.travail/f.json"], { FAUX_VIBE_MODE: mode });
      assert.equal(r.code, 1, script);
      assert.match(r.erreur, /nomme 21 fichiers, plus que 20/);
    }
    assert.deepEqual(d.appels(), []);
  });
});

describe("les fichiers de secrets ne partent jamais, même sans chemins exclus", () => {
  const finding = (fichier) => JSON.stringify({
    cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", arbitrage_precedent: "finding_valide", fichier,
  });
  function avecSecrets() {
    const d = chantier();
    d.ecrire(".env", "CLE=SECRET-ENV-9Q\n");
    d.ecrire("config/cle.pem", "-----SECRET-PEM-9Q-----\n");
    symlinkSync("../.env", d.chemin("src", "lien-env"));
    return d;
  }

  test(".env, une clé privée, un lien vers .env : refus de l'arbitre et de la tranche, aucun appel", (t) => {
    const d = avecSecrets();
    t.after(d.detruire);
    d.git("add", "-A");
    d.git("commit", "-q", "-m", "chore: secrets");
    for (const fichier of [".env", "config/cle.pem", "src/lien-env"]) {
      d.ecrire("harness/.travail/f.json", finding(fichier));
      for (const [script, mode] of [["mistral-arbitrer.sh", "verdict"], ["mistral-trancher.sh", "simple"]]) {
        const r = d.run(script, ["harness/.travail/f.json"], { FAUX_VIBE_MODE: mode });
        assert.equal(r.code, 1, `${script} ${fichier} : ${r.erreur}`);
        assert.match(r.erreur, /fichier de secrets/, `${script} ${fichier}`);
      }
    }
    assert.deepEqual(d.appels(), []);
  });

  test("des noms non ASCII (« déploiement/.env », « clé.pem ») ne sortent pas cités et sont refusés", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire("déploiement/.env", "CLE=SECRET-ACCENT-9Q\n");
    d.ecrire("clé.pem", "-----SECRET-ACCENT-PEM-----\n");
    d.git("add", "-A");
    d.git("commit", "-q", "-m", "chore: secrets accentués");
    let r = securite(d);
    assert.equal(r.code, 1, r.erreur);
    assert.match(r.erreur, /le diff touche un fichier de secrets/);
    assert.match(r.erreur, /déploiement\/\.env/);
    for (const fichier of ["déploiement/.env", "clé.pem"]) {
      d.ecrire("harness/.travail/f.json", finding(fichier));
      r = d.run("mistral-arbitrer.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "verdict" });
      assert.equal(r.code, 1, fichier);
      assert.match(r.erreur, /fichier de secrets/, fichier);
    }
    // Le repli sur le diff de la branche ne les emporte pas non plus.
    d.ecrire("harness/.travail/g.json", finding("README.md"));
    r = d.run("mistral-arbitrer.sh", ["harness/.travail/g.json"], { FAUX_VIBE_MODE: "verdict" });
    assert.equal(r.code, 0, r.erreur);
    assert.equal(d.appels().length, 1);
    assert.doesNotMatch(d.appels()[0].prompt, /SECRET-ACCENT/);
  });

  test("un diff qui touche .env : retiré du contexte de l'arbitre, et la relecture sécurité refuse", (t) => {
    const d = avecSecrets();
    t.after(d.detruire);
    d.git("add", "-A");
    d.git("commit", "-q", "-m", "chore: secrets");
    d.ecrire("harness/.travail/f.json", finding("README.md"));
    let r = d.run("mistral-arbitrer.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "verdict" });
    assert.equal(r.code, 0, r.erreur);
    assert.doesNotMatch(d.appels()[0].prompt, /SECRET-ENV|SECRET-PEM|diff --git a\/\.env/);
    r = securite(d);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /le diff touche un fichier de secrets/);
    assert.equal(d.appels().length, 1, "la relecture sécurité n'a rien envoyé");
  });
});

describe("une seule liste interdite, d'où dérivent tous les contrôles", () => {
  test("invariant : chaque entrée interdite est dans les deux denylists ET a son équivalent dans le parcours de grep", (t) => {
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["private/**", "**/fixtures/**"]; } });
    t.after(d.detruire);
    d.ecrire("harness/.travail/f.json", JSON.stringify({ cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", fichier: "src/garde.py" }));
    assert.equal(d.run("mistral-arbitrer.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "verdict" }).code, 0);
    const charge = d.appels()[0].profil;
    const racine = realpathSync(d.racine);
    const livre = readFileSync(PROFIL, "utf8");
    const interdits = listeInterdite(livre, racine, ["private/**", "**/fixtures/**"]);
    const p = lireProfil(charge);
    const liste = (s, cle) => JSON.parse(p.get(s).get(cle).replace(/,\s*\]$/, "]"));
    const parcours = liste("tools.grep", "exclude_patterns");
    for (const e of interdits) {
      assert.ok(liste("tools.read_file", "denylist").includes(e), `read_file : ${e}`);
      assert.ok(liste("tools.grep", "denylist").includes(e), `grep : ${e}`);
      for (const g of equivalentsGrep(e, racine)) assert.ok(parcours.includes(g), `${e} -> ${g}`);
    }
    for (const attendu of ["**/.claude/settings.json", "**/.claude/settings.local.json", "**/.env", ".git/**", "private/**"]) {
      assert.ok(parcours.includes(attendu), attendu);
    }
    // Le livré ne porte plus d'exclusion de sécurité écrite à la main : seulement la performance.
    const propres = JSON.parse(lireProfil(livre).get("tools.grep").get("exclude_patterns").replace(/,\s*\]$/, "]"));
    for (const e of interdits) for (const g of equivalentsGrep(e, racine)) assert.equal(propres.includes(g), false, `livré : ${g}`);
  });

  test("ripgrep, avec le parcours du profil effectif, ne lit ni .env ni .claude/settings.json", { skip: spawnSync("rg", ["--version"]).status !== 0 && "ripgrep absent" }, (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.ecrire(".env", "MARQUE-RG\n");
    d.ecrire(".claude/settings.json", "{\"x\": \"MARQUE-RG\"}\n");
    d.ecrire("src/ok.py", "# MARQUE-RG\n");
    const texte = profilEffectif(readFileSync(PROFIL, "utf8"), realpathSync(d.racine), []);
    const globs = JSON.parse(lireProfil(texte).get("tools.grep").get("exclude_patterns").replace(/,\s*\]$/, "]")).flatMap((g) => ["--glob", `!${g}`]);
    for (const dossier of [".", ".claude", "src"]) {
      const r = spawnSync("rg", ["--no-ignore", "-l", ...globs, "-e", "MARQUE-RG", dossier], { cwd: d.racine, encoding: "utf8" });
      assert.doesNotMatch(r.stdout, /\.env|settings\.json/, dossier);
    }
    assert.match(spawnSync("rg", ["--no-ignore", "-l", ...globs, "-e", "MARQUE-RG", "."], { cwd: d.racine, encoding: "utf8" }).stdout, /src\/ok\.py/);
  });

  test("la copie d'un .env suivi et inchangé : refus de la relecture sécurité et de l'arbitre", (t) => {
    const d = chantier();
    t.after(d.detruire);
    d.git("checkout", "-q", "main");
    d.ecrire(".env", "CLE=SECRET-COPIE-ENV\n".repeat(4));
    d.git("add", ".env");
    d.git("commit", "-q", "-m", "chore: env suivi");
    d.git("checkout", "-q", "feat/001-jouet");
    d.git("merge", "-q", "--no-edit", "main");
    d.ecrire("src/reglages.txt", d.lire(".env"));
    d.git("add", "src/reglages.txt");
    d.git("commit", "-q", "-m", "chore: copie");
    let r = securite(d);
    assert.equal(r.code, 1, r.erreur);
    assert.match(r.erreur, /^ {2}src\/reglages\.txt$/m);
    for (const fichier of ["src/reglages.txt", "README.md"]) {
      d.ecrire("harness/.travail/f.json", JSON.stringify({ cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", fichier, arbitrage_precedent: "x" }));
      for (const [script, mode] of [["mistral-arbitrer.sh", "verdict"], ["mistral-trancher.sh", "simple"]]) {
        r = d.run(script, ["harness/.travail/f.json"], { FAUX_VIBE_MODE: mode });
        assert.equal(r.code, 1, `${script} ${fichier}`);
        assert.match(r.erreur, /porte une copie ou un déplacement/, `${script} ${fichier}`);
      }
    }
    assert.deepEqual(d.appels(), []);
  });
});

describe("les motifs de chemins exclus ont un seul sens pour vibe et pour ripgrep", () => {
  test("un joker mêlé à du texte dans un segment est refusé, avec la façon de le réécrire", (t) => {
    for (const ok of ["private/**", "**/fixtures/**", "secrets/", "a/*", "*.pem", "docs/notes.md"]) assert.equal(refusMotif(ok), null, ok);
    for (const ko of ["private*.json", "kit*.mjs", "docs/*.md", "a/b?.txt", "x/[ab]", "src/*.py/x", "a/*/b", "a/**/b", "*", "**"]) {
      assert.match(String(refusMotif(ko)), /mêle un joker à du texte, ou le place au milieu/, ko);
    }
    const d = chantier({ config: (c) => { c.relecteur.chemins_exclus = ["private*.json"]; } });
    t.after(d.detruire);
    const r = d.run("mistral-preflight.sh", []);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /« private\*\.json » .* réécris-le en segments entiers/);
    assert.equal(securite(d).code, 1);
    assert.deepEqual(d.appels(), []);
  });

  test("sur les motifs permis, la liste interdite (fnmatch) et le parcours de ripgrep coïncident", { skip: spawnSync("rg", ["--version"]).status !== 0 && "ripgrep absent" }, (t) => {
    const d = chantier();
    t.after(d.detruire);
    const motifs = ["*.pem", "private/**", "a/*", "**/fixtures/**", "secrets/"];
    const fichiers = ["x.pem", "d/y.pem", "d/e/z.pem", "pem.txt", "private/p.txt", "private/q/r.txt", "privateer.txt",
      "a/m.txt", "a/n/b.txt", "ab/c", "fixtures/f.txt", "src/fixtures/g.txt", "src/prefixtures/h.txt", "secrets/s.txt", "src/ok.txt"];
    for (const f of fichiers) d.ecrire(f, "MARQUE-COINCIDE\n");
    const racine = realpathSync(d.racine);
    const livre = readFileSync(PROFIL, "utf8");
    const selonVibe = new Set(interditsParmi(livre, racine, motifs, fichiers));
    const globs = JSON.parse(lireProfil(profilEffectif(livre, racine, motifs)).get("tools.grep").get("exclude_patterns").replace(/,\s*\]$/, "]"))
      .flatMap((g) => ["--glob", `!${g}`]);
    const vus = new Set(spawnSync("rg", ["--no-ignore", "--hidden", "-l", ...globs, "-e", "MARQUE-COINCIDE", "."], { cwd: d.racine, encoding: "utf8" })
      .stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, "")));
    for (const f of fichiers) assert.equal(vus.has(f), !selonVibe.has(f), `${f} : vibe ${selonVibe.has(f) ? "interdit" : "permis"}, ripgrep ${vus.has(f) ? "le lit" : "le saute"}`);
  });
});

describe("la tranche finale exige un autre modèle que l'arbitre", () => {
  test("même modèle, par la configuration ou par surcharge : refus avant tout appel", (t) => {
    const d = chantier({ config: (c) => { c.options.mistral.modeles.tranche = c.options.mistral.modeles.relecture; } });
    t.after(d.detruire);
    d.ecrire("harness/.travail/f.json", JSON.stringify({
      cle: "k", titre: "t", severite: "P2", detail: "d", refutation_codeur: "r", fichier: "src/garde.py", arbitrage_precedent: "finding_valide",
    }));
    let r = d.run("mistral-trancher.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "simple" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /tournerait avec le modèle de l'arbitre \(mistral-large-4\)/);
    r = d.run("mistral-preflight.sh", []);
    assert.equal(r.code, 1);
    assert.match(r.erreur, /son modèle est celui de l'arbitre/);
    // Surcharge d'environnement qui recrée l'égalité sur une configuration saine.
    const e = chantier();
    t.after(e.detruire);
    e.ecrire("harness/.travail/f.json", d.lire("harness", ".travail", "f.json"));
    r = e.run("mistral-trancher.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "simple", MISTRAL_SIMPLIFY_MODEL: "mistral-large-4" });
    assert.equal(r.code, 1);
    assert.match(r.erreur, /modèle de l'arbitre/);
    r = e.run("mistral-trancher.sh", ["harness/.travail/f.json"], { FAUX_VIBE_MODE: "simple", MISTRAL_REVIEW_MODEL: "mistral-medium-3.5" });
    assert.equal(r.code, 1);
    assert.deepEqual(d.appels(), []);
    assert.deepEqual(e.appels(), []);
    // La tranche coupée, le préflight accepte deux modèles égaux (rien ne les compare).
    const f = chantier({ config: (c) => { c.options.mistral.tranche_finale = false; c.options.mistral.modeles.tranche = c.options.mistral.modeles.relecture; } });
    t.after(f.detruire);
    assert.equal(f.run("mistral-preflight.sh", []).code, 0);
  });
});

describe("le découpage du diff ne perd rien", () => {
  const bloc = (f, lignes) => `diff --git a/${f} b/${f}\nindex 1..2 100644\n--- a/${f}\n+++ b/${f}\n@@ -1,0 +1,${lignes.length} @@\n${lignes.map((l) => `+${l}\n`).join("")}`;
  const GROS = bloc("src/gros.py", Array.from({ length: 900 }, (_, i) => `x${i} = "é${"a".repeat(40)}"`));
  const MINIFIE = bloc("web/app.min.js", [`var a="${"é".repeat(9000)}${"z".repeat(9000)}";`]);
  const PETIT = bloc("src/petit.py", ["a = 1"]);
  const LOCK = bloc("package-lock.json", ['"x": 1']);

  test("la concaténation des lots rend exactement le diff retenu, aucun lot ne dépasse la borne", () => {
    const max = 8000;
    const { lots, exclus, fichiers } = decouperDiff(PETIT + GROS + LOCK + MINIFIE, { max, exclusions: ["package-lock.json"] });
    assert.equal(lots.map((l) => l.corps).join(""), PETIT + GROS + MINIFIE);
    assert.deepEqual(exclus, ["package-lock.json"]);
    assert.deepEqual(fichiers, ["src/petit.py", "src/gros.py", "web/app.min.js"]);
    for (const l of lots) assert.ok(octets(l.texte) <= max, `lot ${l.index}`);
    assert.ok(lots.length > 3);
  });

  test("motifs d'exclusion : « **/ » est un préfixe de dossiers, « * » ne traverse pas « / »", () => {
    const motifs = ["**/test/**", "**/generated/**", "vendor/**"];
    for (const f of ["src/contest/auth.js", "src/not-generated/auth.js", "src/vendor/x.js", "src/test.js"]) {
      assert.equal(estExclu(f, motifs), false, `${f} reste relu`);
    }
    for (const f of ["test/x.js", "a/test/x.js", "generated/y.js", "a/b/generated/c/y.js", "vendor/x.js"]) {
      assert.equal(estExclu(f, motifs), true, `${f} est exclu`);
    }
    assert.equal(estExclu("a/b.md", ["*.md"]), false);
    assert.equal(estExclu("README.md", ["**/*.md"]), true);
  });

  test("motifs d'exclusion, chemins cités par Git, borne absurde", () => {
    assert.equal(estExclu("docs/a/b.md", ["**/*.md"]), true);
    assert.equal(estExclu("migrations/0001.sql", ["**/*.md"]), false);
    assert.equal(cheminEnTete('diff --git "a/src/\\303\\251.py" "b/src/\\303\\251.py"'), "src/é.py");
    assert.throws(() => decouperDiff(PETIT, { max: 10 }), /borne/);
    assert.deepEqual(decouperDiff("", { max: 9000 }).lots, []);
  });
});
