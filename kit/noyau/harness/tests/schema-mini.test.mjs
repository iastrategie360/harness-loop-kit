import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valider, auditer, validerFichier, ErreurSchema } from "../scripts/lib/schema-mini.mjs";
import { SCHEMAS, HARNESS, lireJson } from "./aide.mjs";

test("une instance conforme ne rend aucune erreur", () => {
  const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "integer", minimum: 1 } } };
  assert.deepEqual(valider(schema, { a: 3 }), []);
});

test("clés fermées, champ requis, type et bornes sont signalés avec leur chemin", () => {
  const schema = {
    type: "object", additionalProperties: false, required: ["a", "b"],
    properties: { a: { type: "integer", minimum: 1 }, b: { type: "string" } },
  };
  const erreurs = valider(schema, { a: 0, c: true });
  assert.deepEqual(erreurs.map((e) => e.chemin).sort(), ["/a", "/b", "/c"]);
});

test("une valeur hors énumération est refusée, null compris", () => {
  assert.equal(valider({ enum: ["x", null] }, null).length, 0);
  assert.equal(valider({ enum: ["x"] }, null).length, 1);
  assert.equal(valider({ enum: ["x"] }, "y").length, 1);
});

test("un mot-clé non couvert est une erreur de schéma, jamais un mot ignoré", () => {
  assert.throws(() => valider({ type: "string", format: "date" }, "2030-01-01"), ErreurSchema);
  assert.throws(() => valider({ type: "object", minProperties: 1 }, {}), ErreurSchema);
});

test("auditer trouve un mot non couvert même dans une branche que l'instance n'atteint pas", () => {
  const schema = { type: "object", properties: { rare: { type: "array", items: { type: "string", format: "uri" } } } };
  assert.deepEqual(valider(schema, {}), []); // la validation seule ne le voit pas
  assert.throws(() => auditer(schema), /format/);
});

test("un $ref local est suivi, un $ref distant est refusé", () => {
  const schema = { $defs: { nom: { type: "string", minLength: 2 } }, type: "object", properties: { n: { $ref: "#/$defs/nom" } } };
  assert.equal(valider(schema, { n: "ab" }).length, 0);
  assert.equal(valider(schema, { n: "a" }).length, 1);
  assert.throws(() => valider({ $ref: "https://exemple.invalid/s.json" }, 1), ErreurSchema);
  assert.throws(() => valider({ $ref: "#/$defs/absent" }, 1), ErreurSchema);
});

test("if / then / else : la branche suit la condition", () => {
  const schema = {
    type: "object",
    if: { properties: { mode: { const: "strict" } }, required: ["mode"] },
    then: { required: ["motif"] },
    else: { not: { required: ["motif"] } },
  };
  assert.equal(valider(schema, { mode: "strict", motif: "x" }).length, 0);
  assert.equal(valider(schema, { mode: "strict" }).length, 1);
  assert.equal(valider(schema, { mode: "souple" }).length, 0);
  assert.equal(valider(schema, { mode: "souple", motif: "x" }).length, 1);
});

test("oneOf exige une seule forme", () => {
  const schema = { oneOf: [{ required: ["a"] }, { required: ["b"] }] };
  assert.equal(valider(schema, { a: 1 }).length, 0);
  assert.equal(valider(schema, { a: 1, b: 1 }).length, 1);
  assert.equal(valider(schema, {}).length, 1);
});

test("les longueurs se comptent en caractères, pas en unités de code", () => {
  assert.equal(valider({ type: "string", maxLength: 3 }, "été").length, 0);
  assert.equal(valider({ type: "string", minLength: 2 }, "\u{1F600}").length, 1);
});

test("un motif Unicode interdit les tirets longs", () => {
  const schema = { type: "string", pattern: "^[^\\u2014\\u2013]*$" };
  assert.equal(valider(schema, "un texte simple").length, 0);
  assert.equal(valider(schema, "un texte \u2014 coupé").length, 1);
});

test("un entier n'est pas un nombre à virgule, et NaN n'est pas un nombre", () => {
  assert.equal(valider({ type: "integer" }, 1.5).length, 1);
  assert.equal(valider({ type: "number" }, Number.NaN).length, 1);
});

test("validerFichier : un fichier vide ou illisible est invalide, sans exception", () => {
  const dossier = mkdtempSync(join(tmpdir(), "harness-schema-"));
  const schema = join(dossier, "s.json");
  writeFileSync(schema, JSON.stringify({ type: "object" }));
  const vide = join(dossier, "vide.json");
  writeFileSync(vide, "  \n");
  const casse = join(dossier, "casse.json");
  writeFileSync(casse, "{ pas du json");
  assert.equal(validerFichier(schema, vide).ok, false);
  assert.equal(validerFichier(schema, casse).ok, false);
  assert.equal(validerFichier(schema, join(dossier, "absent.json")).ok, false);
});

test("tous les schémas du kit restent dans le sous-ensemble couvert", () => {
  const fichiers = readdirSync(SCHEMAS).filter((f) => f.endsWith(".json"));
  assert.ok(fichiers.length >= 6, "les schémas du noyau sont présents");
  for (const f of fichiers) {
    assert.doesNotThrow(() => auditer(lireJson(join(SCHEMAS, f))), `schéma ${f}`);
  }
});

test("la configuration d'exemple est valide", () => {
  const r = validerFichier(join(SCHEMAS, "projet.schema.json"), join(HARNESS, "projet.exemple.json"));
  assert.deepEqual(r.erreurs, []);
});
