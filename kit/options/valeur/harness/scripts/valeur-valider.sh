#!/usr/bin/env bash
# valeur-valider.sh : valide la réponse de l'arbitre de valeur AVANT toute application.
#
# Le verdict de l'arbitre est contraignant : un « ON_LE_NOTE » ferme un item sans correctif.
# Une réponse mal formée, incomplète ou qui parle d'un item jamais soumis ne peut donc pas
# être appliquée, même en partie. Ce script contrôle la forme (schéma) et l'ÉGALITÉ D'ENSEMBLE
# entre les clés soumises et les clés rendues. Compter ne suffit pas : trois verdicts pour
# trois items peuvent porter sur les mauvais items.
#
# Usage : CLES_ATTENDUES=$'<clé1>\n<clé2>' valeur-valider.sh <reponse.(json|md|txt)> [sortie.json]
#   <reponse> : la réponse de l'agent. Le dernier bloc ```json est extrait s'il y en a un,
#               sinon le fichier est pris tel quel.
#   CLES_ATTENDUES : les clés du lot soumis, une par ligne. Sans elle, seule la forme est
#               contrôlée, et le script le dit.
# Sortie : le JSON normalisé (par défaut : l'entrée si elle finit par .json, sinon <entrée>.json)
# Codes : 0 conforme ; 1 refus (aucun verdict : re-soumettre le lot) ; 2 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/commun.sh"

ENTREE="${1:-}"
if [[ -z "$ENTREE" ]]; then
  echo "usage : CLES_ATTENDUES=\$'<clé1>\\n<clé2>' valeur-valider.sh <reponse.(json|md|txt)> [sortie.json]" >&2
  exit 2
fi
[[ -f "$ENTREE" ]] || refuser "réponse introuvable : $ENTREE"
if [[ -n "${2:-}" ]]; then
  SORTIE="$2"
elif [[ "$ENTREE" == *.json ]]; then
  SORTIE="$ENTREE"
else
  SORTIE="$ENTREE.json"
fi
SCHEMA="$SCRIPTS/../schemas/valeur.json"
[[ -f "$SCHEMA" ]] || refuser "schéma absent : $SCHEMA (l'option valeur est-elle installée ?)"

mkdir -p "$TRAVAIL"
TMP="$(mktemp "$TRAVAIL/valeur.XXXXXX")"
trap 'rm -f "$TMP" "$TMP.ok"' EXIT

# Le DERNIER bloc ```json de la réponse : un agent qui se reprend écrit son verdict final en
# dernier. Sans bloc, le fichier entier est le candidat.
awk '
  /^```json[[:space:]]*$/ { dans = 1; bloc = ""; next }
  dans && /^```[[:space:]]*$/ { dans = 0; dernier = bloc; trouve = 1; next }
  dans { bloc = bloc $0 "\n" }
  END { if (trouve) printf "%s", dernier }
' "$ENTREE" > "$TMP"
if [[ ! -s "$TMP" ]]; then
  cp "$ENTREE" "$TMP"
fi
[[ -s "$TMP" ]] || refuser "réponse vide : $ENTREE. Aucun verdict, re-soumettre le lot."
jq -e . "$TMP" >/dev/null 2>&1 || refuser "la réponse n'est pas du JSON lisible : $ENTREE. Aucun verdict, re-soumettre le lot."

if ! node "$SCRIPTS/lib/schema-mini.mjs" "$SCHEMA" "$TMP"; then
  refuser "réponse hors schéma. Aucun verdict, re-soumettre le lot."
fi

rendues="$(jq -r '.items[].cle' "$TMP" | sort)"
doublons="$(uniq -d <<<"$rendues")"
if [[ -n "$doublons" ]]; then
  echo "clés rendues deux fois :" >&2
  sed 's/^/  /' <<<"$doublons" >&2
  refuser "un item porte deux verdicts. Re-soumettre le lot plutôt que d'appliquer un verdict partiel."
fi

if [[ -n "${CLES_ATTENDUES:-}" ]]; then
  attendues="$(grep -v '^[[:space:]]*$' <<<"$CLES_ATTENDUES" | sort -u)"
  manquantes="$(comm -23 <(printf '%s\n' "$attendues") <(printf '%s\n' "$rendues"))"
  intruses="$(comm -13 <(printf '%s\n' "$attendues") <(printf '%s\n' "$rendues"))"
  if [[ -n "$manquantes" || -n "$intruses" ]]; then
    if [[ -n "$manquantes" ]]; then
      echo "items soumis sans verdict :" >&2
      sed 's/^/  /' <<<"$manquantes" >&2
    fi
    if [[ -n "$intruses" ]]; then
      echo "verdicts sur des items jamais soumis :" >&2
      sed 's/^/  /' <<<"$intruses" >&2
    fi
    refuser "les clés rendues ne sont pas celles du lot. Re-soumettre le lot plutôt que d'appliquer un verdict partiel."
  fi
else
  echo "ATTENTION : CLES_ATTENDUES absente, seule la forme est contrôlée." >&2
fi

# Posé seulement une fois tout contrôlé : un refus ne laisse jamais de fichier normalisé.
jq . "$TMP" > "$TMP.ok"
mv "$TMP.ok" "$SORTIE"

jq -r '
  def n(v): [.items[] | select(.verdict == v)] | length;
  "VALEUR: \(.items | length) items · fait \(n("ON_LE_FAIT")) · note \(n("ON_LE_NOTE")) · jete \(n("ON_LE_JETTE")) · hors arbitrage \(n("HORS_ARBITRAGE"))"
' "$SORTIE"
echo "JSON valide : $SORTIE"
