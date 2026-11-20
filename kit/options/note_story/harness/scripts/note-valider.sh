#!/usr/bin/env bash
# note-valider.sh : la note d'une story est-elle complète et à jour ?
#
# C'est la précondition de la gate de merge quand l'option note_story est active : une story
# qui part au merge sans sa note n'en aura jamais, personne ne revient l'écrire après.
# Le script liste TOUTES les causes de refus en un passage, pas seulement la première.
#
# Usage : note-valider.sh <story-id>
# Codes : 0 conforme ; 1 refus (chaque cause est nommée) ; 2 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/commun.sh"

ID="${1:-}"
if [[ -z "$ID" ]]; then
  echo "usage : note-valider.sh <story-id>" >&2
  exit 2
fi

# Lu par etat.mjs, qui rend « true » ou « false » en toutes lettres (et refuse un état absent).
REGARD="$(node "$SCRIPTS/etat.mjs" lire "$ID" regard_client)" || refuser "état de « $ID » illisible : la note ne peut pas être contrôlée."

SPECS="$(cfg '.chemins.specs')"
DOSSIER="$RACINE/$SPECS/$ID"
NOTE="$DOSSIER/README.md"
INDEX="$(cfg '.options.note_story.index')"

causes=()

if [[ ! -f "$NOTE" ]]; then
  causes+=("la note est absente : $SPECS/$ID/README.md (la créer : node harness/scripts/note-index.mjs note $ID)")
else
  if ! sortie="$(node "$SCRIPTS/note-index.mjs" note "$ID" --verifier 2>&1)"; then
    causes+=("l'en-tête ou la liste des documents ne suit plus l'état ($sortie). Relancer : node harness/scripts/note-index.mjs note $ID")
  fi
  restes="$(grep -c "À COMPLÉTER" "$NOTE" || true)"
  if [[ "$restes" != "0" ]]; then
    causes+=("$restes passage(s) « À COMPLÉTER » restent dans la note")
  fi
fi

attendus=(brief.md spec.md plan.md tasks.md qa-rapport.md)
if [[ "$REGARD" == "true" ]]; then
  attendus+=(regard-aval.md)
fi
for doc in "${attendus[@]}"; do
  if [[ ! -s "$DOSSIER/$doc" ]]; then
    causes+=("document attendu absent ou vide : $SPECS/$ID/$doc")
  fi
done

if ! sortie="$(node "$SCRIPTS/note-index.mjs" index --verifier 2>&1)"; then
  causes+=("l'index des stories n'est pas à jour ($sortie). Relancer : node harness/scripts/note-index.mjs index")
elif ! grep -qF -- "\`$ID\`" "$RACINE/$INDEX"; then
  causes+=("la story n'est pas dans l'index $INDEX")
fi

if (( ${#causes[@]} > 0 )); then
  echo "REFUS : note de « $ID » non conforme, ${#causes[@]} cause(s) :" >&2
  for c in "${causes[@]}"; do
    echo "  - $c" >&2
  done
  exit 1
fi
echo "note conforme : $SPECS/$ID/README.md"
