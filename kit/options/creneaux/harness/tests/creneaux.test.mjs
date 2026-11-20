import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { depotJouet, commandeProuvee } from "./aide.mjs";

// Un dépôt avec l'option active, quelques fichiers suivis, et le second arbre nettoyé en fin de test.
function depot(t, plus = () => {}) {
  const d = depotJouet({
    config: (c) => {
      c.options.creneaux.actif = true;
      plus(c);
    },
  });
  for (const f of ["src/api/users.js", "src/api/orders.js", "src/ui/page.js", "migrations/001.sql", "docs/guide.md"]) {
    d.ecrire(f, "x\n");
  }
  d.git("add", "src", "migrations", "docs");
  d.git("commit", "-q", "-m", "fichiers");
  const b = `${d.racine}-creneau-b`;
  t.after(() => {
    rmSync(b, { recursive: true, force: true });
    d.detruire();
  });
  const dansB = (script, args) => d.lancer(script, args, { env: { HARNESS_RACINE: b } });
  return { d, b, dansB };
}

const descripteur = (d, c) => d.lireJson(".git", `harness-creneau-${c}.json`);

test("créneaux : l'option inactive refuse, un usage faux rend 2", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const r = d.lancer("creneaux.sh", ["etat"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /REFUS : l'option creneaux n'est pas active/);

  const actif = depot(t).d;
  assert.equal(actif.lancer("creneaux.sh", []).code, 2);
  assert.equal(actif.lancer("creneaux.sh", ["ouvrir"]).code, 2);
  assert.equal(actif.lancer("creneaux.sh", ["fermer", "c"]).code, 2);
  assert.equal(actif.lancer("creneaux.sh", ["ouvrir", "Story_1", "a", "--perimetre", "src/**"]).code, 1);
});

test("créneaux : ouvrir a déclare, redéclarer met à jour, fermer libère", (t) => {
  const { d } = depot(t);
  let r = d.lancer("creneaux.sh", ["ouvrir", "001-api", "--perimetre", "src/api/**"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /créneau a ouvert pour 001-api/);
  let fiche = descripteur(d, "a");
  assert.equal(fiche.story, "001-api");
  assert.deepEqual(fiche.perimetre, ["src/api/**"]);
  assert.equal(fiche.branche, "feat/001-api");
  const ouvertLe = fiche.ouvert_le;

  r = d.lancer("creneaux.sh", ["ouvrir", "001-api", "--perimetre", "src/api/**", "--perimetre", "tests/api/**"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /périmètre de 001-api mis à jour \(2 glob\(s\)\)/);
  fiche = descripteur(d, "a");
  assert.deepEqual(fiche.perimetre, ["src/api/**", "tests/api/**"]);
  assert.equal(fiche.ouvert_le, ouvertLe, "la date d'ouverture ne bouge pas");

  r = d.lancer("creneaux.sh", ["ouvrir", "002-autre", "a", "--perimetre", "docs/**"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /créneau a occupé par 001-api/);

  r = d.lancer("creneaux.sh", ["etat"]);
  assert.match(r.sortie, /créneau a : 001-api .* 2 glob\(s\)/);
  assert.match(r.sortie, /créneau b : libre/);
  assert.equal(JSON.parse(d.lancer("creneaux.sh", ["etat", "--json"]).sortie).b, null);

  assert.equal(d.lancer("creneaux.sh", ["fermer", "a"]).code, 0);
  assert.equal(d.existe(".git", "harness-creneau-a.json"), false);
  assert.match(d.lancer("creneaux.sh", ["fermer", "a"]).sortie, /déjà libre/);
});

test("créneaux : sans --perimetre, le périmètre est celui de l'état de la story", (t) => {
  const { d } = depot(t);
  let r = d.lancer("creneaux.sh", ["ouvrir", "001-api"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /périmètre inconnu/);
  r = d.lancer("etat.mjs", ["init", "001-api", "--titre", "API", "--regard-client", "non", "--perimetre", "src/api/**"]);
  assert.equal(r.code, 0, r.erreur);
  r = d.lancer("creneaux.sh", ["ouvrir", "001-api"]);
  assert.equal(r.code, 0, r.erreur);
  assert.deepEqual(descripteur(d, "a").perimetre, ["src/api/**"]);
});

test("créneaux : des fichiers suivis en commun sont refusés, et nommés", (t) => {
  const { d } = depot(t);
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "001-api", "a", "--perimetre", "src/api/**"]).code, 0);
  const r = d.lancer("creneaux.sh", ["ouvrir", "002-users", "b", "--perimetre", "src/*/users.js", "--perimetre", "docs/**"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /REFUS : 1 fichier\(s\) dans les deux périmètres \(002-users et 001-api, créneau a\)/);
  assert.match(r.erreur, /- src\/api\/users\.js/);
  assert.equal(d.existe(".git", "harness-creneau-b.json"), false, "rien n'est déclaré après un refus");
  assert.equal(existsSync(`${d.racine}-creneau-b`), false, "le second arbre n'est pas créé après un refus");
});

test("créneaux : un dossier nommé sans joker vaut tout le dossier", (t) => {
  const { d } = depot(t);
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "001-api", "a", "--perimetre", "src/api"]).code, 0);
  const r = d.lancer("creneaux.sh", ["ouvrir", "002-orders", "b", "--perimetre", "src/api/orders.js"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /src\/api\/orders\.js/);
});

test("créneaux : des périmètres qui peuvent se croiser sont refusés même sans fichier commun", (t) => {
  const { d } = depot(t);
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "001-neuf", "a", "--perimetre", "lib/**"]).code, 0);
  let r = d.lancer("creneaux.sh", ["ouvrir", "002-neuf", "b", "--perimetre", "lib/outils/**"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /peuvent se croiser : « lib\/outils\/\*\* » \(002-neuf\) et « lib\/\*\* » \(001-neuf, créneau a\)/);

  r = d.lancer("creneaux.sh", ["ouvrir", "002-neuf", "b", "--perimetre", "**/*.md"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /périmètre trop large .* « \*\*\/\*\.md » \(002-neuf\)/);

  r = d.lancer("creneaux.sh", ["ouvrir", "001-neuf", "b", "--perimetre", "docs/**"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /001-neuf est déjà déclarée dans le créneau a/);
});

test("créneaux : seul, un périmètre large passe ; il bloque ensuite l'autre créneau", (t) => {
  const { d } = depot(t);
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "001-large", "a", "--perimetre", "**"]).code, 0);
  const r = d.lancer("creneaux.sh", ["ouvrir", "002-fin", "b", "--perimetre", "docs/**"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /« \*\* » \(001-large, créneau a\) commence par un joker/);
});

test("créneaux : une ressource exclusive ne se partage pas, même sur deux fichiers différents", (t) => {
  const { d } = depot(t, (c) => { c.options.creneaux.ressources_exclusives = ["migrations/"]; });
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "001-a", "a", "--perimetre", "src/api/**", "--perimetre", "migrations/002.sql"]).code, 0);
  let r = d.lancer("creneaux.sh", ["ouvrir", "002-b", "b", "--perimetre", "src/ui/**", "--perimetre", "migrations/003.sql"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /ressource exclusive revendiquée des deux côtés : « migrations\/ »/);
  r = d.lancer("creneaux.sh", ["ouvrir", "002-b", "b", "--perimetre", "src/ui/**"]);
  assert.equal(r.code, 0, r.erreur);
});

test("créneaux : ouvrir b crée le second arbre, sa branche et ses liens ; chaque arbre a son port", (t) => {
  const { d, b, dansB } = depot(t, (c) => {
    c.execution.type = "web";
    c.execution.port = 4100;
    c.options.creneaux.ports = { a: null, b: 4101 };
    c.options.creneaux.liens = ["deps/", "absent", "../dehors"];
  });
  mkdirSync(join(d.racine, "deps"));
  writeFileSync(join(d.racine, "deps", "lib.txt"), "installé\n");

  let r = d.lancer("creneaux.sh", ["ouvrir", "002-ui", "b", "--perimetre", "src/ui/**"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /créneau b ouvert pour 002-ui : .*-creneau-b \(branche feat\/002-ui, port 4101\)/);
  assert.match(r.sortie, /lien posé : deps/);
  assert.match(r.sortie, /lien ignoré : absent est absent de l'arbre principal/);
  assert.match(r.sortie, /lien ignoré : « \.\.\/dehors »/);
  assert.equal(d.git("-C", b, "rev-parse", "--abbrev-ref", "HEAD"), "feat/002-ui");
  assert.ok(lstatSync(join(b, "deps")).isSymbolicLink());
  assert.equal(d.git("-C", b, "status", "--porcelain"), "", "le lien ne salit pas le second arbre");
  assert.equal(descripteur(d, "b").chemin, b);

  assert.equal(d.lancer("creneaux.sh", ["port"]).sortie.trim(), "4100");
  assert.equal(d.lancer("creneaux.sh", ["port", "b"]).sortie.trim(), "4101");
  assert.equal(dansB("creneaux.sh", ["port"]).sortie.trim(), "4101");
  assert.equal(d.lancer("banc.sh", ["port"]).sortie.trim(), "4100");
  assert.equal(dansB("banc.sh", ["port"]).sortie.trim(), "4101", "le banc du second arbre prend le port du créneau b");
  assert.equal(d.lancer("banc.sh", ["port"], { env: { HARNESS_PORT: "4199" } }).sortie.trim(), "4199");

  // Depuis le second arbre, sans nommer le créneau : la story retrouve le sien.
  r = dansB("creneaux.sh", ["ouvrir", "002-ui", "--perimetre", "src/ui/**", "--perimetre", "tests/ui/**"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /créneau b : périmètre de 002-ui mis à jour/);
});

test("créneaux : sans port propre au créneau b, ou avec un port interdit, l'ouverture est refusée", (t) => {
  const { d } = depot(t, (c) => {
    c.execution.type = "web";
    c.execution.port = 4100;
    c.execution.ports_interdits = [4102];
  });
  let r = d.lancer("creneaux.sh", ["ouvrir", "002-ui", "b", "--perimetre", "src/ui/**"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /options\.creneaux\.ports\.b n'est pas renseigné/);

  d.reconfigurer((c) => { c.options.creneaux.ports.b = 4100; });
  r = d.lancer("creneaux.sh", ["ouvrir", "002-ui", "b", "--perimetre", "src/ui/**"]);
  assert.match(r.erreur, /les deux créneaux ont le même port \(4100\)/);

  d.reconfigurer((c) => { c.options.creneaux.ports.b = 4102; });
  r = d.lancer("creneaux.sh", ["ouvrir", "002-ui", "b", "--perimetre", "src/ui/**"]);
  assert.match(r.erreur, /le port 4102 du créneau b est dans execution\.ports_interdits/);
  assert.equal(existsSync(`${d.racine}-creneau-b`), false);
});

test("créneaux : fermer b refuse le travail non rendu, puis retire l'arbre sans toucher à la cible des liens", (t) => {
  const { d, b, dansB } = depot(t, (c) => { c.options.creneaux.liens = ["deps"]; });
  mkdirSync(join(d.racine, "deps"));
  writeFileSync(join(d.racine, "deps", "lib.txt"), "installé\n");
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "002-ui", "b", "--perimetre", "src/ui/**"]).code, 0);

  let r = dansB("creneaux.sh", ["fermer", "b"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /se ferme depuis l'arbre principal/);

  writeFileSync(join(b, "src", "ui", "page.js"), "modifié\n");
  r = d.lancer("creneaux.sh", ["fermer", "b"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /travail non commité/);
  assert.match(r.erreur, /src\/ui\/page\.js/);

  d.git("-C", b, "commit", "-q", "-am", "travail");
  r = d.lancer("creneaux.sh", ["fermer", "b"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /commits absents de main/);
  assert.ok(existsSync(b), "un refus ne retire rien");

  d.git("merge", "-q", "feat/002-ui");
  r = d.lancer("creneaux.sh", ["fermer", "b"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /créneau b fermé \(002-ui\)/);
  assert.equal(existsSync(b), false);
  assert.equal(d.existe(".git", "harness-creneau-b.json"), false);
  assert.equal(d.lire("deps", "lib.txt"), "installé\n", "la cible du lien est intacte");
  assert.equal(d.git("rev-parse", "--verify", "--quiet", "feat/002-ui").length, 40, "la branche est conservée");
});

test("créneaux : un vrai dossier à la place d'un lien bloque la fermeture", (t) => {
  const { d, b } = depot(t);
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "002-ui", "b", "--perimetre", "src/ui/**"]).code, 0);
  d.reconfigurer((c) => { c.options.creneaux.liens = ["deps"]; });
  mkdirSync(join(b, "deps"));
  writeFileSync(join(b, "deps", "lib.txt"), "installé à la main\n");
  d.ecrire(".git/info/exclude", "/deps\n");
  const r = d.lancer("creneaux.sh", ["fermer", "b"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /vrai fichier ou dossier et non un lien : deps/);
  assert.ok(existsSync(join(b, "deps", "lib.txt")));
});

test("créneaux : verifier refuse un fichier touché hors du périmètre déclaré", (t) => {
  const { d, b, dansB } = depot(t, (c) => { c.options.note_story.actif = true; });
  assert.match(d.lancer("creneaux.sh", ["verifier"]).sortie, /libre, rien à vérifier/);
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "002-ui", "b", "--perimetre", "src/ui"]).code, 0);
  assert.match(dansB("creneaux.sh", ["verifier"]).sortie, /aucun fichier touché/);

  // Dans le périmètre, ou document de la story : rien à redire.
  writeFileSync(join(b, "src", "ui", "page.js"), "modifié\n");
  writeFileSync(join(b, "src", "ui", "neuf.js"), "pas encore suivi\n");
  mkdirSync(join(b, "specs", "002-ui"), { recursive: true });
  writeFileSync(join(b, "specs", "002-ui", "spec.md"), "# spec\n");
  writeFileSync(join(b, "specs", "INDEX.md"), "# Stories\n");
  mkdirSync(join(b, "harness", "state"), { recursive: true });
  writeFileSync(join(b, "harness", "state", "002-ui.json"), "{}\n");
  let r = dansB("creneaux.sh", ["verifier"]);
  assert.equal(r.code, 0, r.erreur);
  assert.match(r.sortie, /5 fichier\(s\) touché\(s\), tous dans le périmètre déclaré/);

  // Hors périmètre, commité ou non : refus, et les fichiers sont nommés.
  writeFileSync(join(b, "src", "api", "users.js"), "débordement\n");
  d.git("-C", b, "commit", "-q", "-am", "débordement");
  writeFileSync(join(b, "specs", "001-autre.md"), "la story d'un autre\n");
  r = d.lancer("creneaux.sh", ["verifier", "b"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /REFUS : 2 fichier\(s\) touché\(s\) hors du périmètre déclaré de 002-ui \(créneau b\)/);
  assert.match(r.erreur, /- src\/api\/users\.js/);
  assert.match(r.erreur, /- specs\/001-autre\.md/);

  // Une fois déclarés, la vérification passe.
  r = dansB("creneaux.sh", ["ouvrir", "002-ui", "--perimetre", "src/ui", "--perimetre", "src/api/users.js", "--perimetre", "specs/001-autre.md"]);
  assert.equal(r.code, 0, r.erreur);
  assert.equal(dansB("creneaux.sh", ["verifier"]).code, 0);
});

test("créneaux : verifier voit l'origine d'un fichier déplacé dans le périmètre", (t) => {
  const { d, b } = depot(t);
  assert.equal(d.lancer("creneaux.sh", ["ouvrir", "002-ui", "b", "--perimetre", "src/ui"]).code, 0);
  d.git("-C", b, "mv", "src/api/orders.js", "src/ui/orders.js");
  d.git("-C", b, "commit", "-q", "-m", "déplacement");
  const r = d.lancer("creneaux.sh", ["verifier", "b"]);
  assert.equal(r.code, 1, r.sortie);
  assert.match(r.erreur, /REFUS : 1 fichier\(s\) touché\(s\) hors du périmètre déclaré de 002-ui/);
  assert.match(r.erreur, /- src\/api\/orders\.js/);
});

test("créneaux : une déclaration illisible est un refus, jamais un créneau libre", (t) => {
  const { d } = depot(t);
  d.ecrire(".git/harness-creneau-a.json", "{ pas du json");
  for (const args of [["etat"], ["ouvrir", "002-ui", "b", "--perimetre", "src/ui/**"], ["fermer", "a"]]) {
    const r = d.lancer("creneaux.sh", args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.erreur, /déclaration du créneau a illisible/);
  }
  d.ecrire(".git/harness-creneau-a.json", '{"story": "001-a"}');
  assert.equal(d.lancer("creneaux.sh", ["etat"]).code, 1);
});

test("créneaux : le banc du premier arbre garde son port quand aucun créneau n'est déclaré", (t) => {
  const { d } = depot(t, (c) => {
    c.execution.type = "web";
    c.execution.port = 4100;
    c.commandes.demarrer = commandeProuvee("true");
  });
  assert.equal(d.lancer("banc.sh", ["port"]).sortie.trim(), "4100");
  d.reconfigurer((c) => { c.options.creneaux.ports.a = 4105; });
  assert.equal(d.lancer("banc.sh", ["port"]).sortie.trim(), "4105");
});
