import { test } from "node:test";
import assert from "node:assert/strict";
import { depotJouet } from "./aide.mjs";

const proposition = (d) => JSON.parse(d.lancer("allowlist-verifier.mjs", ["proposer"]).sortie);

// Écrit une variante de la proposition et rend le verdict du contrôle.
function verdict(d, modifier) {
  const p = proposition(d);
  modifier(p.permissions);
  d.ecrire("essai.json", JSON.stringify(p));
  return d.lancer("allowlist-verifier.mjs", ["verifier", "essai.json"]);
}

test("la proposition calculée passe son propre contrôle", (t) => {
  const d = depotJouet({ config: (c) => { c.git.branche_production = "production"; } });
  t.after(d.detruire);
  const p = proposition(d);
  assert.ok(p.permissions.allow.includes("Bash(bash harness/scripts/gate.sh:*)"));
  assert.ok(p.permissions.deny.includes("Bash(gh pr merge:*)"));
  assert.ok(p.permissions.deny.includes("Bash(git push origin production:*)"));
  assert.ok(p.permissions.deny.includes("Bash(git push origin main:*)"));
  assert.equal(p.permissions.allow.some((r) => /codex /.test(r) && !/harness\/scripts/.test(r)), false);
  const r = verdict(d, () => {});
  assert.equal(r.code, 0, r.erreur);
});

test("la proposition suit la configuration : forge, options, commandes interdites", (t) => {
  const d = depotJouet({
    config: (c) => {
      c.git.forge = "aucune";
      c.git.prefixe_branche = "story/";
      c.options.creneaux.actif = true;
      c.execution.commandes_interdites = ["docker compose down"];
    },
  });
  t.after(d.detruire);
  const { allow, deny } = proposition(d).permissions;
  assert.equal(allow.some((r) => r.startsWith("Bash(gh ")), false);
  assert.ok(allow.includes("Bash(git push origin story/*)"));
  assert.ok(allow.includes("Bash(git switch -c story/*)"));
  assert.ok(allow.includes("Bash(bash harness/scripts/creneaux.sh:*)"));
  assert.ok(deny.includes("Bash(docker compose down:*)"));
});

test("une entrée qui porte un secret est refusée, sans être réaffichée en entier", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const cas = [
    "Bash(JETON_API_KEY=abcd1234efgh5678 bash harness/scripts/gate.sh tests)",
    "Bash(git push https://robot:motdepasse123@forge.exemple.test/depot.git feat/x)",
    "Bash(gh api -H 'Authorization: Bearer abcdefgh12345678' /user)",
    "Bash(bash envoyer.sh 0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b)",
  ];
  for (const entree of cas) {
    const r = verdict(d, (p) => p.allow.push(entree));
    assert.equal(r.code, 1, entree);
    assert.match(r.erreur, /secret|jeton/);
    assert.equal(r.erreur.includes(entree), false, "l'entrée fautive n'est pas recopiée en entier");
  }
});

test("un refus nomme le rang de la règle, jamais un morceau de son texte", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  // Un secret court que les motifs ne reconnaissent pas, dans une règle refusée pour autre chose.
  let r = verdict(d, (p) => p.allow.push("Bash(curl https://exemple.test/h/tk-9f8e7d6c:*)"));
  assert.equal(r.code, 1);
  assert.match(r.erreur, /permissions\.allow\[\d+\] : curl ne s'autorise jamais d'avance/);
  assert.equal(/9f8e7d6c|exemple\.test/.test(r.erreur + r.sortie), false);
  // Un secret reconnu, placé au tout début de la règle.
  r = verdict(d, (p) => p.allow.push("Bash(JETON_API_KEY=abcd1234efgh5678 bash harness/scripts/gate.sh tests)"));
  assert.equal(r.code, 1);
  assert.match(r.erreur, /permissions\.allow\[\d+\] porte ce qui ressemble à un secret/);
  assert.equal(/abcd|JETON_API_KEY/.test(r.erreur + r.sortie), false);
  // Un fichier qui n'est pas du JSON : l'erreur de lecture ne cite pas son texte.
  d.ecrire(".claude/casse.json", '{"a": tk-9f8e7d6c}');
  for (const commande of ["verifier", "appliquer"]) {
    r = d.lancer("allowlist-verifier.mjs", [commande, ".claude/casse.json"]);
    assert.equal(r.code, 1, commande);
    assert.match(r.erreur, /JSON invalide/, commande);
    assert.equal((r.erreur + r.sortie).includes("9f8e7d6c"), false, commande);
  }
});

test("ce qui revient à tout autoriser est refusé", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const cas = {
    "Bash": /sans limite/,
    "Bash(*)": /sans limite/,
    "Bash(bash:*)": /tout autoriser/,
    "Bash(node:*)": /tout autoriser/,
    "Bash(curl:*)": /jamais d'avance/,
    "Bash(curl https://exemple.test:*)": /jamais d'avance/,
    "Bash(codex exec:*)": /relecteur/,
    "Bash(git:*)": /sans sous-commande/,
    "Bash(git push:*)": /sans destination/,
    "Bash(gh pr:*)": /sans sous-commande précise/,
    "Bash(gh pr merge:*)": /merge d'une PR/,
    "Bash(git push --force origin feat/x)": /push forcé/,
    "Bash(git reset --hard:*)": /reset --hard/,
    "Bash(git push origin main:*)": /push direct vers main/,
    "Bash(rm -rf:*)": /suppression récursive/,
  };
  for (const [entree, attendu] of Object.entries(cas)) {
    const r = verdict(d, (p) => p.allow.push(entree));
    assert.equal(r.code, 1, entree);
    assert.match(r.erreur, attendu, entree);
  }
});

test("une interdiction attendue qui manque est un refus", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  let r = verdict(d, (p) => { p.deny = p.deny.filter((x) => x !== "Bash(gh pr merge:*)"); });
  assert.equal(r.code, 1);
  assert.match(r.erreur, /gh pr merge/);
  r = verdict(d, (p) => { p.deny = p.deny.filter((x) => !x.startsWith("Read(")); });
  assert.equal(r.code, 1);
  assert.match(r.erreur, /\.env/);
});

test("fichier illisible ou sans bloc de permissions : refus ; sans argument : usage", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  d.ecrire("casse.json", "{pas du json");
  assert.equal(d.lancer("allowlist-verifier.mjs", ["verifier", "casse.json"]).code, 1);
  d.ecrire("vide.json", "{}");
  const r = d.lancer("allowlist-verifier.mjs", ["verifier", "vide.json"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /permissions/);
  assert.equal(d.lancer("allowlist-verifier.mjs", []).code, 2);
});

test("appliquer ajoute ce qui manque, garde le reste, et ne change rien à la relance", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  d.ecrire(".claude/settings.local.json", JSON.stringify({ env: { MODE: "x" }, permissions: { allow: ["Bash(ls:*)", "Bash(bash harness/scripts/gate.sh:*)"], ask: ["Bash(make:*)"] } }));
  const r = d.lancer("allowlist-verifier.mjs", ["appliquer", ".claude/settings.local.json"]);
  assert.equal(r.code, 0, r.erreur);
  const apres = d.lireJson(".claude/settings.local.json");
  assert.deepEqual(apres.env, { MODE: "x" });
  assert.deepEqual(apres.permissions.ask, ["Bash(make:*)"]);
  assert.deepEqual(apres.permissions.allow.slice(0, 2), ["Bash(ls:*)", "Bash(bash harness/scripts/gate.sh:*)"]);
  assert.equal(apres.permissions.allow.filter((x) => x === "Bash(bash harness/scripts/gate.sh:*)").length, 1);
  assert.ok(apres.permissions.deny.includes("Bash(gh pr merge:*)"));
  assert.equal(d.lancer("allowlist-verifier.mjs", ["verifier", ".claude/settings.local.json"]).code, 0);
  const texte = d.lire(".claude/settings.local.json");
  const encore = d.lancer("allowlist-verifier.mjs", ["appliquer", ".claude/settings.local.json"]);
  assert.match(encore.sortie, /0 autorisation\(s\) et 0 interdiction\(s\) ajoutée\(s\)/);
  assert.equal(d.lire(".claude/settings.local.json"), texte);
  // Fichier absent : créé. Personnel et pas ignoré par Git : c'est dit. (Le nom habituel du
  // fichier personnel est souvent ignoré par les réglages Git de la machine : on en prend un autre.)
  const visible = d.lancer("allowlist-verifier.mjs", ["appliquer", ".claude/essai.local.json"]);
  assert.equal(visible.code, 0, visible.erreur);
  assert.match(visible.sortie, /NOTE : .*n'est pas ignoré par Git/);
  d.ecrire(".gitignore", ".claude/autre.local.json\n");
  const neuf = d.lancer("allowlist-verifier.mjs", ["appliquer", ".claude/autre.local.json"]);
  assert.equal(neuf.code, 0, neuf.erreur);
  assert.doesNotMatch(neuf.sortie, /NOTE/);
  assert.ok(d.lireJson(".claude/autre.local.json").permissions.allow.length > 10);
});

test("appliquer ne touche pas un fichier qui porte déjà une entrée refusée, et ne l'affiche pas", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  const jeton = ["ghp", "AbCdEfGhIjKlMnOpQrStUvWx0123"].join("_");
  const avant = JSON.stringify({ permissions: { allow: [`Bash(curl -H "Authorization: token ${jeton}" https://exemple.test:*)`] } });
  d.ecrire(".claude/settings.json", avant);
  const r = d.lancer("allowlist-verifier.mjs", ["appliquer", ".claude/settings.json"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /n'est pas modifié/);
  assert.match(r.erreur, /secret/);
  assert.equal((r.erreur + r.sortie).includes(jeton), false);
  assert.equal(d.lire(".claude/settings.json"), avant);
  d.ecrire(".claude/casse.json", "{pas du json");
  assert.equal(d.lancer("allowlist-verifier.mjs", ["appliquer", ".claude/casse.json"]).code, 1);
  assert.equal(d.lire(".claude/casse.json"), "{pas du json");
});

// La syntaxe des règles, telle que l'outil la documente : « * » vaut n'importe quel texte, où
// qu'il soit ; « :* » en fin de règle vaut « espace puis n'importe quoi », et la commande nue
// passe aussi. C'est une lecture de la documentation, pas l'outil lui-même.
function correspond(regle, commande) {
  const contenu = /^Bash\((.*)\)$/s.exec(regle)?.[1];
  if (contenu === undefined) return false;
  const motif = contenu.replace(/:\*$/, " *");
  const nu = motif.endsWith(" *");
  const corps = (nu ? motif.slice(0, -2) : motif).split("*").map((m) => m.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${corps}${nu ? "( .*)?" : ""}$`, "s").test(commande);
}

test("la lecture de la syntaxe : deux-points, joker collé, commande nue", () => {
  assert.equal(correspond("Bash(ls:*)", "ls -la"), true);
  assert.equal(correspond("Bash(ls:*)", "ls"), true);
  assert.equal(correspond("Bash(ls:*)", "lsof"), false);
  assert.equal(correspond("Bash(git switch feat/:*)", "git switch feat/001-x"), false);
  assert.equal(correspond("Bash(git switch feat/*)", "git switch feat/001-x"), true);
});

test("les règles proposées laissent passer les gestes du superviseur, et arrêtent leurs variantes", (t) => {
  const d = depotJouet({ config: (c) => { c.git.branche_production = "production"; } });
  t.after(d.detruire);
  const { allow, deny } = proposition(d).permissions;
  const autorise = (c) => allow.some((r) => correspond(r, c)) && !deny.some((r) => correspond(r, c));
  for (const geste of [
    "git switch -c feat/001-jouet origin/main",
    "git switch feat/001-jouet",
    "git push -u origin feat/001-jouet",
    "git push origin feat/001-jouet",
    "git fetch origin",
    "node --test harness/tests/etat.test.mjs",
    "bash harness/scripts/gate.sh tests",
    "bash harness/scripts/preflight.sh",
    "node harness/scripts/etat.mjs stage 001-jouet CODE",
  ]) assert.equal(autorise(geste), true, geste);
  for (const variante of [
    "git push origin feat/001-jouet:main",
    "git push origin feat/001-jouet:production",
    "git push origin feat/001-jouet:refs/heads/main",
    "git push origin feat/001-jouet --force",
    "git push origin feat/001-jouet --force-with-lease",
    "git push origin feat/001-jouet -f",
    "git push -u origin feat/001-jouet:main",
    "git push origin feat/001-jouet main",
    "git push -u origin feat/001-jouet main",
    "git push origin feat/001-jouet production",
    "git push origin feat/001-jouet production --tags",
    "git push origin feat/001-jouet +main",
    "git push origin feat/001-jouet refs/heads/main",
    "git push origin +feat/001-jouet",
    "git push origin main",
    "git push --force origin feat/001-jouet",
    "git switch main",
    "gh pr merge 12",
  ]) assert.equal(autorise(variante), false, variante);
});

test("un push sans branche nommée, ou une interdiction de push forcé qui manque : refus", (t) => {
  const d = depotJouet();
  t.after(d.detruire);
  for (const entree of ["Bash(git push origin:*)", "Bash(git push -u origin *)"]) {
    const r = verdict(d, (p) => p.allow.push(entree));
    assert.equal(r.code, 1, entree);
    assert.match(r.erreur, /sans branche nommée/, entree);
  }
  const r = verdict(d, (p) => { p.deny = p.deny.filter((x) => x !== "Bash(git push * --force*)"); });
  assert.equal(r.code, 1);
  assert.match(r.erreur, /git push \* --force\*/);
});

test("la production nommée après une autre branche : l'interdiction est exigée", (t) => {
  const d = depotJouet({ config: (c) => { c.git.branche_production = "production"; } });
  t.after(d.detruire);
  // Les deux écritures (nue, puis suivie d'autre chose) couvrent le même début : on retire les deux.
  const r = verdict(d, (p) => { p.deny = p.deny.filter((x) => !x.startsWith("Bash(git push * production")); });
  assert.equal(r.code, 1);
  assert.match(r.erreur, /git push \* production/);
});
