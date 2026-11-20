#!/usr/bin/env bash
# verifier-kit.sh : contrôle l'archive du kit elle-même, avant de la poser ou de la diffuser.
#
# Usage :
#   bash verifier-kit.sh                contrôle tout
#   bash verifier-kit.sh --sans-tests   saute la suite de tests (les autres contrôles restent)
#   bash verifier-kit.sh --manifeste    réécrit MANIFESTE.json d'après les fichiers présents
#
# Il n'écrit rien dans l'archive (sauf --manifeste) : l'assemblage et les tests se jouent dans
# un dossier temporaire, supprimé à la fin.
#
# Codes : 0 archive saine ; 1 au moins un contrôle rouge ; 2 usage ou outil manquant.
set -uo pipefail

ici="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ici" || exit 2

mode="tout"
case "${1:-}" in
  "") ;;
  --sans-tests) mode="sans-tests" ;;
  --manifeste) mode="manifeste" ;;
  *)
    echo "usage : bash verifier-kit.sh [--sans-tests | --manifeste]" >&2
    exit 2
    ;;
esac

for outil in bash node jq sha256sum find sort grep; do
  command -v "$outil" >/dev/null 2>&1 || {
    echo "outil manquant : $outil" >&2
    exit 2
  }
done

# La liste des fichiers de l'archive, triée, sans le manifeste lui-même. Aucun balayage ne
# descend dans `.git` : un kit rangé sous Git reste la même archive, et les fichiers internes
# de Git changent à chaque geste.
lister() {
  find . -name .git -prune -o -type f ! -name MANIFESTE.json ! -name '*.nouveau' -print \
    | sed 's|^\./||' | LC_ALL=C sort
}

if [[ "$mode" == "manifeste" ]]; then
  tmp="$(mktemp)"
  {
    echo "{"
    echo "  \"kit\": \"harness-loop-kit\","
    echo "  \"version\": \"$(tr -d '[:space:]' < VERSION)\","
    echo "  \"fichiers\": {"
    premier=1
    while IFS= read -r f; do
      [[ $premier -eq 1 ]] || echo ","
      premier=0
      printf '    %s: "%s"' "$(jq -Rn --arg f "$f" '$f')" "$(sha256sum "$f" | cut -d' ' -f1)"
    done < <(lister)
    echo
    echo "  }"
    echo "}"
  } > "$tmp"
  jq -e . "$tmp" > /dev/null || {
    echo "manifeste mal formé, rien n'est écrit" >&2
    rm -f "$tmp"
    exit 1
  }
  mv "$tmp" MANIFESTE.json
  echo "MANIFESTE.json écrit : $(jq '.fichiers | length' MANIFESTE.json) fichiers"
  exit 0
fi

rouges=0
verts=0
ok() {
  verts=$((verts + 1))
  echo "OK      $1"
}
rouge() {
  rouges=$((rouges + 1))
  echo "ROUGE   $1"
}
# detail : les lignes fautives, indentées, bornées pour rester lisibles.
detail() {
  sed 's/^/          /' <<< "$1" | head -n 15
}

echo "== Structure"
manque=""
for piece in LISEZMOI.md VERSION poser.sh verifier-kit.sh \
  docs/METHODE.md docs/LECONS.md docs/QUESTIONNAIRE.md \
  kit/noyau/.claude/commands/harness.md kit/noyau/.claude/commands/harness-status.md \
  kit/noyau/.claude/commands/harness-install.md \
  kit/noyau/.claude/agents/harness-ba.md kit/noyau/.claude/agents/harness-archi.md \
  kit/noyau/.claude/agents/harness-codeur.md kit/noyau/.claude/agents/harness-qa.md \
  kit/noyau/harness/HARNESS.md kit/noyau/harness/PROJET.md.modele \
  kit/noyau/harness/projet.exemple.json kit/noyau/harness/schemas/projet.schema.json \
  kit/noyau/harness/schemas/etat.schema.json kit/noyau/harness/scripts/etat.mjs \
  kit/noyau/harness/scripts/gate.sh kit/noyau/harness/scripts/kit-poser.mjs \
  kit/noyau/harness/scripts/lib/config.mjs kit/noyau/harness/scripts/lib/schema-mini.mjs \
  kit/options/valeur/harness/options/valeur.md kit/options/personas/harness/options/personas.md \
  kit/options/note_story/harness/options/note_story.md \
  kit/options/creneaux/harness/options/creneaux.md \
  kit/options/mistral/harness/options/mistral.md kit/options/mistral/harness/scripts/mistral-commun.sh \
  kit/options/mistral/harness/scripts/mistral-securite.sh kit/options/mistral/harness/scripts/mistral-arbitrer.sh \
  kit/options/mistral/harness/scripts/mistral-trancher.sh kit/options/mistral/harness/scripts/mistral-preflight.sh \
  kit/options/mistral/harness/scripts/decouper-diff.mjs kit/options/mistral/harness/scripts/lib/decoupe-diff.mjs \
  kit/options/mistral/harness/scripts/lib/profil-vibe.mjs kit/options/mistral/harness/vibe/agents/relecteur.toml \
  kit/options/mistral/harness/vibe/agents/sans-outils.toml \
  kit/options/mistral/harness/schemas/simplification.json kit/options/mistral/harness/tests/mistral.test.mjs \
  kit/options/mistral/harness/tests/faux/vibe; do
  [[ -f "$piece" ]] || manque+="$piece"$'\n'
done
if [[ -z "$manque" ]]; then ok "les pièces attendues sont là"; else
  rouge "pièces manquantes"
  detail "$manque"
fi

if [[ -f MANIFESTE.json ]]; then
  ecarts=""
  while IFS= read -r f; do
    attendu="$(jq -r --arg f "$f" '.fichiers[$f] // ""' MANIFESTE.json)"
    if [[ -z "$attendu" ]]; then
      ecarts+="hors manifeste : $f"$'\n'
    elif [[ "$(sha256sum "$f" | cut -d' ' -f1)" != "$attendu" ]]; then
      ecarts+="modifié : $f"$'\n'
    fi
  done < <(lister)
  while IFS= read -r f; do
    [[ -f "$f" ]] || ecarts+="absent : $f"$'\n'
  done < <(jq -r '.fichiers | keys[]' MANIFESTE.json)
  if [[ "$(jq -r .version MANIFESTE.json)" != "$(tr -d '[:space:]' < VERSION)" ]]; then
    ecarts+="la version du manifeste n'est pas celle de VERSION"$'\n'
  fi
  if [[ -z "$ecarts" ]]; then ok "les fichiers sont ceux du manifeste"; else
    rouge "l'archive ne correspond pas à son manifeste"
    detail "$ecarts"
  fi
else
  rouge "MANIFESTE.json est absent (le produire : bash verifier-kit.sh --manifeste)"
fi

echo "== Syntaxe"
fautes=""
while IFS= read -r f; do
  bash -n "$f" 2> /dev/null || fautes+="bash : $f"$'\n'
done < <(find . -name .git -prune -o -type f -name '*.sh' -print)
while IFS= read -r f; do
  node --check "$f" 2> /dev/null || fautes+="node : $f"$'\n'
done < <(find . -name .git -prune -o -type f -name '*.mjs' -print)
while IFS= read -r f; do
  jq -e . "$f" > /dev/null 2>&1 || fautes+="json : $f"$'\n'
done < <(find . -name .git -prune -o -type f -name '*.json' -print)
if [[ -z "$fautes" ]]; then ok "scripts bash, modules Node et fichiers JSON se lisent"; else
  rouge "fichiers illisibles"
  detail "$fautes"
fi

echo "== Schémas"
# Un schéma ouvert laisse passer une clé inventée : chaque objet des deux schémas du projet
# doit refuser les propriétés inconnues.
ouverts="$(jq -r --arg f projet '
  [paths(type == "object" and (.type? == "object") and (has("properties")) and (.additionalProperties? != false))]
  | map("\($f) : " + (map(tostring) | join("."))) | .[]' kit/noyau/harness/schemas/projet.schema.json 2> /dev/null)"
if [[ -z "$ouverts" ]]; then ok "le schéma de configuration refuse toute clé inconnue"; else
  rouge "objets ouverts dans le schéma de configuration"
  detail "$ouverts"
fi
verdict="$(node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { auditer, validerFichier, formater } from "./kit/noyau/harness/scripts/lib/schema-mini.mjs";
const dossiers = ["kit/noyau/harness/schemas", ...readdirSync("kit/options").map((o) => `kit/options/${o}/harness/schemas`)];
let n = 0;
for (const d of dossiers.filter(existsSync)) {
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    auditer(JSON.parse(readFileSync(`${d}/${f}`, "utf8")));
    n += 1;
  }
}
const r = validerFichier("kit/noyau/harness/schemas/projet.schema.json", "kit/noyau/harness/projet.exemple.json");
if (!r.ok) { console.log(formater(r.erreurs)); process.exit(1); }
console.log(n);
' 2>&1)" && ok "$verdict schémas couverts par le validateur, configuration d'exemple valide" || {
  rouge "schéma non couvert, ou configuration d'exemple invalide"
  detail "$verdict"
}

echo "== Pièges connus"
# 1. Le relecteur ne s'appelle qu'à un endroit, et en lecture seule.
ailleurs="$(grep -rnE '(^|[^[:alnum:]_.-])codex( -C [^ ]+)? exec\b' --include='*.sh' --include='*.mjs' kit \
  | grep -v '^kit/noyau/harness/scripts/codex-common.sh:' | grep -v '/harness/tests/' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//|\*)' || true)"
if [[ -z "$ailleurs" ]]; then ok "le relecteur n'est appelé que depuis codex-common.sh"; else
  rouge "appel du relecteur hors de codex-common.sh"
  detail "$ailleurs"
fi
appels="$(grep -cE '^[[:space:]]*timeout .*codex( -C [^ ]+)? exec\b' kit/noyau/harness/scripts/codex-common.sh)"
gardes="$(grep -cE 'args=\((-s read-only|"\$\{CODEX_LECTURE_SEULE\[@\]\}")' kit/noyau/harness/scripts/codex-common.sh)"
if [[ "$appels" -ge 1 && "$gardes" -ge "$appels" ]] && grep -q 'sandbox_mode' kit/noyau/harness/scripts/codex-common.sh; then
  ok "chaque appel du relecteur ($appels) part en lecture seule"
else
  rouge "appels du relecteur : $appels, arguments de lecture seule : $gardes"
fi

# 1 bis. Le CLI de Mistral (option mistral) ne s'appelle que depuis le fichier commun de l'option,
# et chaque appel nomme ses outils : sans --enabled-tools, une session programmatique ouvre tout.
COMMUN_MISTRAL=kit/options/mistral/harness/scripts/mistral-commun.sh
ailleurs="$(grep -rnE '(^|[^[:alnum:]_.-])vibe -p\b' --include='*.sh' --include='*.mjs' kit \
  | grep -v "^$COMMUN_MISTRAL:" | grep -v '/harness/tests/' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//|\*)' || true)"
if [[ -z "$ailleurs" ]]; then ok "le CLI de Mistral n'est appelé que depuis mistral-commun.sh"; else
  rouge "appel du CLI de Mistral hors de mistral-commun.sh"
  detail "$ailleurs"
fi
# Chaque appel, suites de ligne comprises, porte --enabled-tools et rien qui lève les permissions.
bilan_vibe="$(awk '
  function clore() { if (bloc != "") { n++; if (bloc !~ /--enabled-tools/ || bloc ~ /auto-approve|accept-edits|--trust|--add-dir|bypass/) mauvais++ } bloc = ""; suite = 0 }
  {
    if (suite) { bloc = bloc " " $0; if ($0 !~ /\\$/) clore(); next }
    if ($0 ~ /^[[:space:]]*#/) next
    if ($0 ~ /(^|[^[:alnum:]_.-])vibe -p( |$)/) { bloc = $0; if ($0 ~ /\\$/) suite = 1; else clore() }
  }
  END { clore(); printf "%d %d\n", n, mauvais }
' "$COMMUN_MISTRAL" 2> /dev/null)"
read -r appels_vibe mauvais_vibe <<< "${bilan_vibe:-0 0}"
if [[ "${appels_vibe:-0}" -ge 1 && "${mauvais_vibe:-1}" -eq 0 ]]; then
  ok "chaque appel du CLI de Mistral ($appels_vibe) borne ses outils par --enabled-tools"
else
  rouge "appels du CLI de Mistral : ${appels_vibe:-0}, dont ${mauvais_vibe:-?} sans --enabled-tools ou avec une permission levée"
fi

# 2. Aucune vérification lancée dans un pipe : le code rendu serait celui de la dernière commande.
pipes="$(grep -rnE '(gate|banc|preflight|prerequis|review-pr-locale|codex-[a-z-]+|mistral-[a-z-]+)\.sh[^|`#]*[^|]\|[^|]' \
  --include='*.sh' kit poser.sh | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|echo "usage)' || true)"
if [[ -z "$pipes" ]]; then ok "aucun script de vérification n'est lancé dans un pipe"; else
  rouge "script de vérification lancé dans un pipe"
  detail "$pipes"
fi

# 3. Aucune commande destructrice hors des listes qui l'interdisent.
destructeurs="$(grep -rnE 'git (reset --hard|clean -[a-z]*f|push (-f|--force))' --include='*.sh' kit poser.sh \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
if [[ -z "$destructeurs" ]]; then ok "aucun script ne lance de commande Git destructrice"; else
  rouge "commande Git destructrice dans un script"
  detail "$destructeurs"
fi

# 4. Une suppression récursive sur une variable vide efface tout : elle doit être gardée.
nus="$(grep -rnE 'rm -r?f?r? +("?\$[A-Za-z_]|"?\$\{[A-Za-z_]+\})' --include='*.sh' kit poser.sh verifier-kit.sh \
  | grep -E 'rm -(rf|fr|r) ' | grep -vE '\$\{[A-Za-z_]+:\?' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
if [[ -z "$nus" ]]; then ok "toute suppression récursive sur une variable est gardée"; else
  rouge "suppression récursive sur une variable non gardée"
  detail "$nus"
fi

# 5. « node --test <dossier> » échoue sous Node 22 : la suite se lance par la liste de ses fichiers.
dossiers="$(grep -rnE 'node --test [A-Za-z0-9_./-]*tests/?([^A-Za-z0-9_./*:-]|$)' kit docs LISEZMOI.md poser.sh || true)"
if [[ -z "$dossiers" ]]; then ok "la suite de tests n'est jamais lancée sur un dossier"; else
  rouge "suite de tests lancée sur un dossier"
  detail "$dossiers"
fi

echo "== Source unique des seuils"
# Les seuils de la boucle vivent dans projet.json. Un nombre recopié dans la procédure
# devient faux le jour où la configuration change.
recopies="$(grep -rnE '\b[0-9]+ (tours|échecs|rounds|passes)\b|(max_tours|echecs_consecutifs|seuil_escalade_rounds|seuil_survie)\b.{0,25}\b[0-9]+\b' \
  kit/noyau/.claude kit/noyau/harness/HARNESS.md kit/options/*/harness/options kit/options/*/.claude 2> /dev/null || true)"
if [[ -z "$recopies" ]]; then ok "aucun seuil de boucle n'est recopié dans la procédure"; else
  rouge "seuil de boucle recopié hors de la configuration"
  detail "$recopies"
fi

echo "== Secrets et données"
# Des faux secrets vivent exprès dans le test de la liste de permissions : c'est l'exception.
secrets="$(grep -rnE --exclude-dir=.git '(sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})' . \
  | grep -v '^\./kit/noyau/harness/tests/allowlist.test.mjs:' | grep -v '^\./verifier-kit.sh:' || true)"
if [[ -z "$secrets" ]]; then ok "aucun motif de secret"; else
  rouge "motif de secret trouvé"
  detail "$(cut -c1-80 <<< "$secrets")"
fi
intrus="$(find . -name .git -prune -o \( -name '.env*' -o -name 'settings.local.json' -o -name 'settings.json' -o -path '*/state/*.json' -o -name '*.log' \) -print | head -n 20)"
if [[ -z "$intrus" ]]; then ok "ni fichier d'environnement, ni réglages, ni état de story, ni journal"; else
  rouge "fichiers qui n'ont rien à faire dans l'archive"
  detail "$intrus"
fi
adresses="$(grep -rnoE --exclude-dir=.git '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' . \
  | grep -vE '@[A-Za-z0-9.-]*\.(invalid|test|example)$' | grep -v '^\./verifier-kit.sh:' || true)"
if [[ -z "$adresses" ]]; then ok "aucune adresse électronique réelle"; else
  rouge "adresse électronique dans l'archive"
  detail "$adresses"
fi

echo "== Écriture"
# Une fixture reproduit exprès une sortie de relecteur avec ses tirets : c'est l'exception.
tirets="$(grep -rnP --exclude-dir=.git '[\x{2014}\x{2013}]' . | grep -v '/fixtures/review-pr/markdown-avec-findings.md:' || true)"
if [[ -z "$tirets" ]]; then ok "aucun tiret long"; else
  rouge "tiret long"
  detail "$(cut -c1-120 <<< "$tirets")"
fi

echo "== Tests"
if [[ "$mode" == "sans-tests" ]]; then
  echo "NOTE    suite de tests sautée (--sans-tests)"
else
  travail="$(mktemp -d)"
  trap 'rm -rf "${travail:?}"' EXIT
  mkdir -p "$travail/projet" "$travail/tmp"
  cp -R kit/noyau/. "$travail/projet/"
  for option in kit/options/*/; do
    cp -R "$option." "$travail/projet/"
  done
  journal="$travail/tests.log"
  code=0
  # Sans pipe : c'est le code de node qui décide.
  # La commande est celle que donne l'installateur, lancée comme lui depuis la racine du projet.
  (cd "$travail/projet" && TMPDIR="$travail/tmp" node --test harness/tests/*.test.mjs) > "$journal" 2>&1 || code=$?
  passes="$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$journal" | tail -n 1)"
  echecs="$(sed -n 's/^# fail \([0-9]*\)$/\1/p' "$journal" | tail -n 1)"
  total="$(sed -n 's/^# tests \([0-9]*\)$/\1/p' "$journal" | tail -n 1)"
  if [[ "$code" -eq 0 && "${echecs:-1}" == "0" && -n "${total:-}" && "$total" -gt 0 && "$passes" == "$total" ]]; then
    ok "suite du noyau et des options : $passes tests sur $total"
  else
    rouge "suite de tests (code $code, ${passes:-?} verts, ${echecs:-?} rouges sur ${total:-?})"
    detail "$(grep -E '^ *not ok' "$journal" || tail -n 15 "$journal")"
  fi
fi

echo
if [[ "$rouges" -eq 0 ]]; then
  echo "verdict : archive saine ($verts contrôles verts)"
  exit 0
fi
echo "verdict : $rouges contrôle(s) rouge(s), $verts vert(s)"
exit 1
