import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS } from "./aide.mjs";

// Le diagnostic d'un échec du relecteur ne conclut que sur une source FIABLE. Un outil qui
// nomme une cause qu'il n'a pas mesurée envoie chercher au mauvais endroit.
function classer(code, journal, stderr, fiable) {
  const bac = mkdtempSync(join(tmpdir(), "harness-diag-"));
  try {
    writeFileSync(join(bac, "sortie.log"), journal);
    writeFileSync(join(bac, "sortie.err"), stderr);
    const args = [code, join(bac, "sortie.log"), join(bac, "sortie.err")];
    if (fiable !== undefined) args.push(fiable);
    // Le diagnostic sort sur STDERR : c'est un message d'opérateur, pas une valeur de retour.
    const r = spawnSync(
      "bash",
      ["-c", 'source "$0"; CODEX_DELAI=600; codex_classify_failure "$@" 2>&1', join(SCRIPTS, "codex-common.sh"), ...args],
      { encoding: "utf8", env: { ...process.env, HARNESS_SANS_CONFIG: "1", HARNESS_RACINE: bac } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  } finally {
    rmSync(bac, { recursive: true, force: true });
  }
}

test("source NON fiable : il refuse de nommer une cause et renvoie au journal", () => {
  const sortie = classer("1", "une transcription quelconque", "401 Unauthorized", "0");
  assert.match(sortie, /Diagnostic non fiable/);
  assert.doesNotMatch(sortie, /codex login/);
});

test("source fiable : il NOMME la cause et donne le geste", () => {
  const sortie = classer("1", "transcription", "stream error: unexpected status 401 Unauthorized", "1");
  assert.match(sortie, /codex login/);
  assert.doesNotMatch(sortie, /non fiable/);
});

test("source fiable et stderr VIDE : il ne fabrique pas de cause", () => {
  const sortie = classer("1", "ligne de transcription sans erreur", "", "1");
  assert.ok(sortie.length > 0, "il doit dire quelque chose");
  assert.doesNotMatch(sortie, /codex login|limite d'usage/);
});

test("le contenu RELU n'est pas pris pour un diagnostic", () => {
  // Le journal porte un message de l'agent qui cite « 401 » et « quota » : ce sont des données
  // du code relu, pas des erreurs du CLI.
  const journal = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "le code renvoie 401 unauthorized et parle de quota" } })}\n`;
  const sortie = classer("1", journal, "", "1");
  assert.doesNotMatch(sortie, /codex login|limite d'usage/);
});

test("un événement d'erreur du flux est une source fiable", () => {
  const journal = `${JSON.stringify({ type: "error", message: "You have hit your usage limit" })}\n`;
  assert.match(classer("1", journal, "", "1"), /limite d'usage/i);
});

test("le délai prime sur tout le reste", () => {
  const sortie = classer("124", "t", "unexpected status 401 Unauthorized", "1");
  assert.match(sortie, /délai/);
  assert.doesNotMatch(sortie, /codex login/);
});

test("sans quatrième argument, la source est tenue pour fiable", () => {
  assert.doesNotMatch(classer("1", "t", "unexpected status 401 Unauthorized"), /non fiable/);
});
