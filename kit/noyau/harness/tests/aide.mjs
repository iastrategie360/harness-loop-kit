// aide.mjs : outils communs aux tests du harness.
//
// Chaque test travaille dans un dépôt Git JETABLE, créé dans le dossier temporaire du système.
// Les scripts testés sont ceux du dossier voisin `../scripts` : on teste le kit en place.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ICI = dirname(fileURLToPath(import.meta.url));
export const HARNESS = join(ICI, "..");
export const SCRIPTS = join(HARNESS, "scripts");
export const SCHEMAS = join(HARNESS, "schemas");
export const FAUX = join(ICI, "faux");
export const DATE_FIXE = "2030-01-15T10:00:00Z";

export function lireJson(chemin) {
  return JSON.parse(readFileSync(chemin, "utf8"));
}

export function configExemple() {
  return lireJson(join(HARNESS, "projet.exemple.json"));
}

function git(racine, ...args) {
  const r = spawnSync("git", ["-C", racine, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} : ${r.stderr}`);
  return r.stdout.trim();
}

// depotJouet({ config }) : crée un dépôt avec un commit, une branche `main` et un
// harness/projet.json. `config` reçoit la configuration d'exemple et la modifie en place.
// Passer `config: null` pour un dépôt SANS configuration.
export function depotJouet({ config = () => {}, env = {} } = {}) {
  const racine = mkdtempSync(join(tmpdir(), "harness-test-"));
  git(racine, "init", "-q", "-b", "main");
  git(racine, "config", "user.email", "test@example.invalid");
  git(racine, "config", "user.name", "Test");
  git(racine, "config", "commit.gpgsign", "false");
  mkdirSync(join(racine, "harness"), { recursive: true });
  writeFileSync(join(racine, "README.md"), "# Jouet\n");
  if (config !== null) {
    const c = configExemple();
    config(c);
    writeFileSync(join(racine, "harness", "projet.json"), `${JSON.stringify(c, null, 2)}\n`);
  }
  git(racine, "add", "-A");
  git(racine, "commit", "-q", "-m", "init");

  const environnement = {
    ...process.env,
    HARNESS_RACINE: racine,
    HARNESS_DATE: DATE_FIXE,
    HARNESS_CONFIG_VALIDEE: "",
    ...env,
  };

  // lancer("etat.mjs", ["init", ...]) ou lancer("gate.sh", [...]) : rend {code, sortie, erreur}.
  function lancer(script, args = [], { env: plus = {}, entree } = {}) {
    const chemin = join(SCRIPTS, script);
    const [programme, premiers] = script.endsWith(".mjs") ? [process.execPath, [chemin]] : ["bash", [chemin]];
    const r = spawnSync(programme, [...premiers, ...args], {
      cwd: racine, encoding: "utf8", env: { ...environnement, ...plus }, input: entree,
    });
    return { code: r.status, sortie: r.stdout ?? "", erreur: r.stderr ?? "" };
  }

  return {
    racine,
    env: environnement,
    lancer,
    git: (...args) => git(racine, ...args),
    chemin: (...parts) => join(racine, ...parts),
    lire: (...parts) => readFileSync(join(racine, ...parts), "utf8"),
    lireJson: (...parts) => lireJson(join(racine, ...parts)),
    ecrire(relatif, contenu) {
      const cible = join(racine, relatif);
      mkdirSync(dirname(cible), { recursive: true });
      writeFileSync(cible, contenu);
      return cible;
    },
    existe: (...parts) => existsSync(join(racine, ...parts)),
    config: () => lireJson(join(racine, "harness", "projet.json")),
    reconfigurer(fn) {
      const c = lireJson(join(racine, "harness", "projet.json"));
      fn(c);
      writeFileSync(join(racine, "harness", "projet.json"), `${JSON.stringify(c, null, 2)}\n`);
    },
    detruire: () => rmSync(racine, { recursive: true, force: true }),
  };
}

// Une commande prouvée, prête à poser dans la configuration d'un test.
export function commandeProuvee(cmd, plus = {}) {
  return { cmd, prouvee_le: "2030-01-01", exit: 0, duree_s: 1, base_rouge: false, ...plus };
}
