// kit-poser.test.mjs : la pose des fichiers du kit, et surtout ce qu'elle refuse d'écraser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { depotJouet } from "./aide.mjs";

// Un petit kit jetable : deux fichiers de noyau, un fichier par option.
function faireKit(version = "1.0.0", fichiers = {}) {
  const kit = mkdtempSync(join(tmpdir(), "harness-kit-"));
  const contenu = {
    VERSION: `${version}\n`,
    "noyau/harness/scripts/outil.sh": "#!/usr/bin/env bash\necho outil v1\n",
    "noyau/.claude/commands/harness.md": "superviseur v1\n",
    "options/valeur/harness/options/valeur.md": "option valeur v1\n",
    "options/personas/harness/options/personas.md": "option personas v1\n",
    ...fichiers,
  };
  for (const [relatif, texte] of Object.entries(contenu)) {
    if (texte === null) continue;
    mkdirSync(dirname(join(kit, relatif)), { recursive: true });
    writeFileSync(join(kit, relatif), texte, { mode: relatif.endsWith(".sh") ? 0o755 : 0o644 });
  }
  return kit;
}

function banc(t, { version, fichiers, config } = {}) {
  const kit = faireKit(version, fichiers);
  const d = depotJouet({ config, env: { HARNESS_KIT: kit } });
  t.after(() => {
    d.detruire();
    rmSync(kit, { recursive: true, force: true });
  });
  return { d, kit };
}

test("usage, et refus sans kit ou sans configuration", (t) => {
  const { d } = banc(t);
  assert.equal(d.lancer("kit-poser.mjs", []).code, 2);
  assert.equal(d.lancer("kit-poser.mjs", ["retirer"]).code, 2);
  const sansKit = d.lancer("kit-poser.mjs", ["plan"], { env: { HARNESS_KIT: d.chemin("absent") } });
  assert.equal(sansKit.code, 1);
  assert.match(sansKit.erreur, /kit introuvable/);
  const nu = depotJouet({ config: null });
  t.after(() => nu.detruire());
  const sansConfig = nu.lancer("kit-poser.mjs", ["plan"]);
  assert.equal(sansConfig.code, 1);
  assert.match(sansConfig.erreur + sansConfig.sortie, /configuration absente/);
});

test("plan n'écrit rien, appliquer pose le noyau et seulement les options actives", (t) => {
  const { d } = banc(t, { config: (c) => { c.options.valeur.actif = true; } });
  const plan = d.lancer("kit-poser.mjs", ["plan"]);
  assert.equal(plan.code, 0, plan.erreur);
  assert.match(plan.sortie, /mode : installation, options : valeur/);
  assert.match(plan.sortie, /POSER\s+harness\/scripts\/outil\.sh/);
  assert.equal(d.existe("harness/scripts/outil.sh"), false);
  assert.equal(d.existe("harness/kit-installe.json"), false);

  const fait = d.lancer("kit-poser.mjs", ["appliquer"]);
  assert.equal(fait.code, 0, fait.erreur);
  assert.match(fait.sortie, /fait : 3 posé\(s\), 0 remplacé\(s\), 0 à côté, 0 déjà à jour, 0 orphelin\(s\)/);
  assert.equal(d.lire("harness/scripts/outil.sh"), "#!/usr/bin/env bash\necho outil v1\n");
  assert.ok(statSync(d.chemin("harness/scripts/outil.sh")).mode & 0o100, "le droit d'exécution suit");
  assert.equal(d.lire("harness/options/valeur.md"), "option valeur v1\n");
  assert.equal(d.existe("harness/options/personas.md"), false);
  const registre = d.lireJson("harness/kit-installe.json");
  assert.equal(registre.version, "1.0.0");
  assert.deepEqual(registre.options, ["valeur"]);
  assert.deepEqual(Object.keys(registre.fichiers), [".claude/commands/harness.md", "harness/options/valeur.md", "harness/scripts/outil.sh"]);
  assert.match(d.lire(".gitignore"), /^harness\/\.travail\/$/m);
  assert.match(d.lire(".gitignore"), /^harness\/\.kit\/$/m);
});

test("relancer ne change rien : ni fichier, ni registre, ni .gitignore", (t) => {
  const { d } = banc(t);
  d.ecrire(".gitignore", "node_modules/\n/harness/.kit/");
  assert.equal(d.lancer("kit-poser.mjs", ["appliquer"]).code, 0);
  assert.equal(d.lire(".gitignore").match(/harness\/\.kit\//g).length, 1, "une ligne déjà là n'est pas répétée");
  assert.match(d.lire(".gitignore"), /^harness\/\.travail\/$/m);
  d.git("add", "-A");
  d.git("commit", "-q", "-m", "pose");
  const encore = d.lancer("kit-poser.mjs", ["appliquer"], { env: { HARNESS_DATE: "2031-06-01T00:00:00Z" } });
  assert.equal(encore.code, 0);
  assert.match(encore.sortie, /mode : à jour/);
  assert.match(encore.sortie, /fait : 0 posé\(s\), 0 remplacé\(s\), 0 à côté, 2 déjà à jour/);
  assert.equal(d.git("status", "--porcelain"), "");
});

test("mise à jour : un fichier intact est remplacé, un fichier retouché ne l'est jamais", (t) => {
  const { d, kit } = banc(t);
  assert.equal(d.lancer("kit-poser.mjs", ["appliquer"]).code, 0);
  d.ecrire(".claude/commands/harness.md", "superviseur v1\nma règle locale\n");
  writeFileSync(join(kit, "VERSION"), "1.1.0\n");
  writeFileSync(join(kit, "noyau/harness/scripts/outil.sh"), "#!/usr/bin/env bash\necho outil v2\n");
  writeFileSync(join(kit, "noyau/.claude/commands/harness.md"), "superviseur v2\n");

  const plan = d.lancer("kit-poser.mjs", ["plan"]);
  assert.match(plan.sortie, /kit 1\.1\.0 \(installé : 1\.0\.0\), mode : mise à jour/);
  assert.match(plan.sortie, /REMPLACER\s+harness\/scripts\/outil\.sh/);
  assert.match(plan.sortie, /À CÔTÉ\s+\.claude\/commands\/harness\.md \(modifié sur place/);

  const fait = d.lancer("kit-poser.mjs", ["appliquer"]);
  assert.equal(fait.code, 0, fait.erreur);
  assert.equal(d.lire("harness/scripts/outil.sh"), "#!/usr/bin/env bash\necho outil v2\n");
  assert.equal(d.lire(".claude/commands/harness.md"), "superviseur v1\nma règle locale\n", "le fichier retouché est intact");
  assert.equal(d.lire(".claude/commands/harness.md.nouveau"), "superviseur v2\n");
  assert.equal(d.lireJson("harness/kit-installe.json").version, "1.1.0");

  // Tant que le fichier diffère, il reste « à côté » : la retouche n'est jamais avalée.
  assert.match(d.lancer("kit-poser.mjs", ["plan"]).sortie, /À CÔTÉ\s+\.claude\/commands\/harness\.md/);

  // Une fois la fusion faite à la main (ici : on adopte la version du kit), tout rentre dans l'ordre.
  d.ecrire(".claude/commands/harness.md", "superviseur v2\n");
  const apres = d.lancer("kit-poser.mjs", ["appliquer"]);
  assert.match(apres.sortie, /0 à côté, 2 déjà à jour/);
  assert.equal(d.existe(".claude/commands/harness.md.nouveau"), false, "le .nouveau identique est retiré");
});

test("un fichier déjà là, d'origine inconnue, n'est pas écrasé", (t) => {
  const { d } = banc(t);
  d.ecrire("harness/scripts/outil.sh", "le mien\n");
  const fait = d.lancer("kit-poser.mjs", ["appliquer"]);
  assert.equal(fait.code, 0, fait.erreur);
  assert.equal(d.lire("harness/scripts/outil.sh"), "le mien\n");
  assert.equal(d.lire("harness/scripts/outil.sh.nouveau"), "#!/usr/bin/env bash\necho outil v1\n");
  assert.equal(Object.hasOwn(d.lireJson("harness/kit-installe.json").fichiers, "harness/scripts/outil.sh"), false);
});

test("option coupée ou fichier retiré du kit : signalé, laissé en place", (t) => {
  const { d, kit } = banc(t, { config: (c) => { c.options.valeur.actif = true; } });
  assert.equal(d.lancer("kit-poser.mjs", ["appliquer"]).code, 0);
  d.reconfigurer((c) => { c.options.valeur.actif = false; });
  rmSync(join(kit, "noyau/harness/scripts/outil.sh"));
  const fait = d.lancer("kit-poser.mjs", ["appliquer"]);
  assert.equal(fait.code, 0, fait.erreur);
  assert.match(fait.sortie, /ORPHELIN\s+harness\/options\/valeur\.md/);
  assert.match(fait.sortie, /ORPHELIN\s+harness\/scripts\/outil\.sh/);
  assert.match(fait.sortie, /2 orphelin\(s\)/);
  assert.equal(d.existe("harness/options/valeur.md"), true);
  assert.equal(d.existe("harness/scripts/outil.sh"), true);
  // L'empreinte de l'orphelin survit : si l'option revient avec un fichier que le kit a changé
  // entre-temps, il est reconnu comme intact et remplacé, pas pris pour une retouche locale.
  writeFileSync(join(kit, "options/valeur/harness/options/valeur.md"), "option valeur v2\n");
  d.reconfigurer((c) => { c.options.valeur.actif = true; });
  const retour = d.lancer("kit-poser.mjs", ["plan"]);
  assert.match(retour.sortie, /REMPLACER\s+harness\/options\/valeur\.md/);
  assert.match(retour.sortie, /0 à côté/);
});

test("un kit qui porte un fichier du projet, ou deux fois le même chemin, est refusé", (t) => {
  const a = banc(t, { fichiers: { "noyau/harness/projet.json": "{}\n" } });
  const r1 = a.d.lancer("kit-poser.mjs", ["appliquer"]);
  assert.equal(r1.code, 1);
  assert.match(r1.erreur, /appartient au projet/);
  const b = banc(t, { fichiers: { "noyau/specs/001/spec.md": "x\n" } });
  assert.match(b.d.lancer("kit-poser.mjs", ["plan"]).erreur, /appartient au projet/);
  const c = banc(t, {
    fichiers: { "options/valeur/harness/scripts/outil.sh": "doublon\n" },
    config: (cfg) => { cfg.options.valeur.actif = true; },
  });
  const r3 = c.d.lancer("kit-poser.mjs", ["plan"]);
  assert.equal(r3.code, 1);
  assert.match(r3.erreur, /porté deux fois/);
  const e = banc(t, { fichiers: { "options/valeur/harness/options/valeur.md": null }, config: (cfg) => { cfg.options.creneaux.actif = true; } });
  const r4 = e.d.lancer("kit-poser.mjs", ["plan"]);
  assert.equal(r4.code, 1);
  assert.match(r4.erreur, /option « creneaux » est active mais absente du kit/);
});

test("registre illisible : refus, plutôt que de tout traiter comme neuf", (t) => {
  const { d } = banc(t);
  assert.equal(d.lancer("kit-poser.mjs", ["appliquer"]).code, 0);
  d.ecrire("harness/kit-installe.json", "{ pas du json");
  const r = d.lancer("kit-poser.mjs", ["plan"]);
  assert.equal(r.code, 1);
  assert.match(r.erreur, /kit-installe\.json illisible/);
});

test("plan --json rend le mode et le sort de chaque fichier", (t) => {
  const { d } = banc(t);
  const r = d.lancer("kit-poser.mjs", ["plan", "--json"]);
  assert.equal(r.code, 0, r.erreur);
  const plan = JSON.parse(r.sortie);
  assert.equal(plan.mode, "installation");
  assert.equal(plan.version_installee, null);
  assert.deepEqual(plan.gestes.map((g) => g.geste), ["poser", "poser"]);
  assert.deepEqual(plan.ignores_manquants, ["harness/.travail/", "harness/.kit/"]);
});
