#!/usr/bin/env node
// schema-mini.mjs : validation JSON Schema réduite, sans aucune dépendance.
//
// POURQUOI : le harness décide sur des fichiers JSON (état d'une story, configuration,
// verdict d'un relecteur). Une valeur hors énumération acceptée en silence devient une
// décision fausse. On valide donc toujours, et on ne dépend d'aucun paquet à installer
// pour le faire : un projet sans JavaScript doit pouvoir poser le harness tel quel.
//
// Sous-ensemble couvert : type, enum, const, required, properties, patternProperties,
// additionalProperties, propertyNames, items, minItems, maxItems, uniqueItems, minLength,
// maxLength, pattern, minimum, maximum, allOf, anyOf, oneOf, not, if/then/else, et $ref
// local (« #/... »).
//
// FERMÉ PAR DÉFAUT : un mot-clé inconnu dans un schéma est une ERREUR, jamais un mot-clé
// ignoré. Sans cette règle, une contrainte écrite avec un mot non couvert passerait pour
// vérifiée alors qu'elle ne l'est pas.
//
// Usage en ligne de commande :
//   node schema-mini.mjs <schema.json> <instance.json>     exit 0 valide, 1 invalide, 2 usage
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ANNOTATIONS = new Set([
  "$schema", "$id", "$comment", "title", "description", "default", "examples",
  "definitions", "$defs",
]);
const MOTS_CLES = new Set([
  "type", "enum", "const", "required", "properties", "patternProperties",
  "additionalProperties", "propertyNames", "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "allOf", "anyOf", "oneOf",
  "not", "if", "then", "else", "$ref",
]);

export class ErreurSchema extends Error {}

function estObjet(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function typeConvient(type, v) {
  switch (type) {
    case "null": return v === null;
    case "array": return Array.isArray(v);
    case "object": return estObjet(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    default: throw new ErreurSchema(`type inconnu dans le schéma : « ${type} »`);
  }
}

function egal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => egal(x, b[i]));
  if (typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && egal(a[k], b[k]));
  }
  return false;
}

function resoudreRef(ref, racine) {
  if (typeof ref !== "string" || !ref.startsWith("#")) {
    throw new ErreurSchema(`$ref non local refusé : « ${ref} » (seuls les « #/... » sont couverts)`);
  }
  let noeud = racine;
  for (const brut of ref.slice(1).split("/").filter(Boolean)) {
    const cle = brut.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!estObjet(noeud) || !Object.hasOwn(noeud, cle)) {
      throw new ErreurSchema(`$ref introuvable : « ${ref} »`);
    }
    noeud = noeud[cle];
  }
  return noeud;
}

// Longueur en points de code : un caractère accentué ou un émoji compte pour un.
function longueur(s) {
  return [...s].length;
}

function verifier(schema, v, chemin, racine, erreurs) {
  if (schema === true) return;
  if (schema === false) {
    erreurs.push({ chemin, message: "aucune valeur n'est admise ici" });
    return;
  }
  if (!estObjet(schema)) throw new ErreurSchema(`schéma invalide en ${chemin || "/"} : objet ou booléen attendu`);

  for (const mot of Object.keys(schema)) {
    if (!MOTS_CLES.has(mot) && !ANNOTATIONS.has(mot)) {
      throw new ErreurSchema(`mot-clé de schéma non couvert : « ${mot} » (en ${chemin || "/"})`);
    }
  }

  if (Object.hasOwn(schema, "$ref")) verifier(resoudreRef(schema.$ref, racine), v, chemin, racine, erreurs);

  if (Object.hasOwn(schema, "type")) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeConvient(t, v))) {
      erreurs.push({ chemin, message: `type attendu : ${types.join(" ou ")}` });
      return; // les contraintes suivantes n'ont pas de sens sur un mauvais type
    }
  }
  if (Object.hasOwn(schema, "const") && !egal(schema.const, v)) {
    erreurs.push({ chemin, message: `valeur attendue : ${JSON.stringify(schema.const)}` });
  }
  if (Object.hasOwn(schema, "enum") && !schema.enum.some((e) => egal(e, v))) {
    erreurs.push({ chemin, message: `valeur hors liste (admises : ${schema.enum.map((e) => JSON.stringify(e)).join(", ")})` });
  }

  if (typeof v === "string") {
    if (Object.hasOwn(schema, "minLength") && longueur(v) < schema.minLength) {
      erreurs.push({ chemin, message: `trop court (minimum ${schema.minLength} caractères)` });
    }
    if (Object.hasOwn(schema, "maxLength") && longueur(v) > schema.maxLength) {
      erreurs.push({ chemin, message: `trop long (maximum ${schema.maxLength} caractères)` });
    }
    if (Object.hasOwn(schema, "pattern") && !new RegExp(schema.pattern, "u").test(v)) {
      erreurs.push({ chemin, message: `ne respecte pas le motif ${schema.pattern}` });
    }
  }

  if (typeof v === "number") {
    if (Object.hasOwn(schema, "minimum") && v < schema.minimum) {
      erreurs.push({ chemin, message: `inférieur au minimum ${schema.minimum}` });
    }
    if (Object.hasOwn(schema, "maximum") && v > schema.maximum) {
      erreurs.push({ chemin, message: `supérieur au maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(v)) {
    if (Object.hasOwn(schema, "minItems") && v.length < schema.minItems) {
      erreurs.push({ chemin, message: `au moins ${schema.minItems} élément(s) attendu(s)` });
    }
    if (Object.hasOwn(schema, "maxItems") && v.length > schema.maxItems) {
      erreurs.push({ chemin, message: `au plus ${schema.maxItems} élément(s) attendu(s)` });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < v.length; i++) {
        if (v.slice(0, i).some((x) => egal(x, v[i]))) {
          erreurs.push({ chemin: `${chemin}/${i}`, message: "élément en double" });
        }
      }
    }
    if (Object.hasOwn(schema, "items")) {
      v.forEach((x, i) => verifier(schema.items, x, `${chemin}/${i}`, racine, erreurs));
    }
  }

  if (estObjet(v)) {
    for (const cle of schema.required ?? []) {
      if (!Object.hasOwn(v, cle)) erreurs.push({ chemin: `${chemin}/${cle}`, message: "champ requis absent" });
    }
    const proprietes = schema.properties ?? {};
    const motifs = Object.entries(schema.patternProperties ?? {}).map(([m, s]) => [new RegExp(m, "u"), s]);
    for (const [cle, valeur] of Object.entries(v)) {
      let couverte = false;
      if (Object.hasOwn(proprietes, cle)) {
        couverte = true;
        verifier(proprietes[cle], valeur, `${chemin}/${cle}`, racine, erreurs);
      }
      for (const [re, s] of motifs) {
        if (re.test(cle)) {
          couverte = true;
          verifier(s, valeur, `${chemin}/${cle}`, racine, erreurs);
        }
      }
      if (!couverte && Object.hasOwn(schema, "additionalProperties")) {
        if (schema.additionalProperties === false) {
          erreurs.push({ chemin: `${chemin}/${cle}`, message: "champ inconnu (clés fermées)" });
        } else {
          verifier(schema.additionalProperties, valeur, `${chemin}/${cle}`, racine, erreurs);
        }
      }
      if (Object.hasOwn(schema, "propertyNames")) {
        verifier(schema.propertyNames, cle, `${chemin}/${cle}`, racine, erreurs);
      }
    }
  }

  for (const sous of schema.allOf ?? []) verifier(sous, v, chemin, racine, erreurs);

  if (Object.hasOwn(schema, "anyOf")) {
    const ok = schema.anyOf.some((s) => valider(s, v, { racine }).length === 0);
    if (!ok) erreurs.push({ chemin, message: "ne correspond à aucune des formes admises (anyOf)" });
  }
  if (Object.hasOwn(schema, "oneOf")) {
    const n = schema.oneOf.filter((s) => valider(s, v, { racine }).length === 0).length;
    if (n !== 1) erreurs.push({ chemin, message: `doit correspondre à une seule forme (oneOf), ${n} trouvée(s)` });
  }
  if (Object.hasOwn(schema, "not") && valider(schema.not, v, { racine }).length === 0) {
    erreurs.push({ chemin, message: "correspond à une forme interdite (not)" });
  }
  if (Object.hasOwn(schema, "if")) {
    const branche = valider(schema.if, v, { racine }).length === 0 ? schema.then : schema.else;
    if (branche !== undefined) verifier(branche, v, chemin, racine, erreurs);
  }
}

// valider(schema, instance) : rend la liste des erreurs [{chemin, message}], vide si valide.
// Lève ErreurSchema si le SCHÉMA lui-même est défectueux ou utilise un mot non couvert.
export function valider(schema, instance, { racine = schema } = {}) {
  const erreurs = [];
  verifier(schema, instance, "", racine, erreurs);
  return erreurs;
}

// auditer(schema) : parcourt le schéma EN ENTIER et lève ErreurSchema au premier mot-clé non
// couvert. `valider` ne visite que les branches que l'instance atteint : sans cet audit, un
// mot inconnu caché dans une branche rare ne se verrait que le jour où elle sert.
export function auditer(schema, chemin = "") {
  if (typeof schema === "boolean") return;
  if (!estObjet(schema)) throw new ErreurSchema(`schéma invalide en ${chemin || "/"} : objet ou booléen attendu`);
  for (const mot of Object.keys(schema)) {
    if (!MOTS_CLES.has(mot) && !ANNOTATIONS.has(mot)) {
      throw new ErreurSchema(`mot-clé de schéma non couvert : « ${mot} » (en ${chemin || "/"})`);
    }
  }
  for (const mot of ["properties", "patternProperties", "$defs", "definitions"]) {
    for (const [cle, sous] of Object.entries(schema[mot] ?? {})) auditer(sous, `${chemin}/${mot}/${cle}`);
  }
  for (const mot of ["additionalProperties", "propertyNames", "items", "not", "if", "then", "else"]) {
    if (Object.hasOwn(schema, mot)) auditer(schema[mot], `${chemin}/${mot}`);
  }
  for (const mot of ["allOf", "anyOf", "oneOf"]) {
    (schema[mot] ?? []).forEach((sous, i) => auditer(sous, `${chemin}/${mot}/${i}`));
  }
  if (Object.hasOwn(schema, "$ref") && (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#"))) {
    throw new ErreurSchema(`$ref non local refusé : « ${schema.$ref} »`);
  }
}

export function formater(erreurs) {
  return erreurs.map((e) => `  ${e.chemin || "/"} : ${e.message}`).join("\n");
}

// validerFichier : lit les deux fichiers, rend {ok, erreurs, instance}. Un JSON illisible est
// une erreur de validation, pas une exception : l'appelant veut un refus, pas une trace.
export function validerFichier(cheminSchema, cheminInstance) {
  const schema = JSON.parse(readFileSync(cheminSchema, "utf8"));
  let instance;
  try {
    const brut = readFileSync(cheminInstance, "utf8");
    if (brut.trim() === "") return { ok: false, erreurs: [{ chemin: "", message: "fichier vide" }] };
    instance = JSON.parse(brut);
  } catch (e) {
    return { ok: false, erreurs: [{ chemin: "", message: `JSON illisible : ${e.message}` }] };
  }
  const erreurs = valider(schema, instance);
  return { ok: erreurs.length === 0, erreurs, instance };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cheminSchema, cheminInstance] = process.argv.slice(2);
  if (!cheminSchema || !cheminInstance) {
    console.error("usage : node schema-mini.mjs <schema.json> <instance.json>");
    process.exit(2);
  }
  try {
    const { ok, erreurs } = validerFichier(cheminSchema, cheminInstance);
    if (!ok) {
      console.error(`INVALIDE : ${cheminInstance}\n${formater(erreurs)}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`ERREUR : ${e.message}`);
    process.exit(2);
  }
}
