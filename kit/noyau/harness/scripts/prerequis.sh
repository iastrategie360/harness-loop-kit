#!/usr/bin/env bash
# prerequis.sh <story> : les prérequis déclarés par la story (`depend_de`) sont-ils tenus ?
#
# POURQUOI : une story lancée avant que celle dont elle dépend ait atteint le stage voulu
# construit sur du sable, et on ne le découvre qu'au merge. Le contrôle est FERMÉ par défaut :
# un état introuvable ou illisible vaut « non tenu ».
#
# L'état de l'autre story est lu dans l'arbre de travail, sinon sur la branche d'intégration
# distante, rafraîchie ici (un échec de réseau n'arrête pas : on lit alors la dernière copie).
#
# Codes : 0 tous tenus (ou aucun prérequis) ; 1 au moins un non tenu ; 2 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/commun.sh"

[[ $# -eq 1 ]] || {
  echo "usage : prerequis.sh <story>" >&2
  exit 2
}

remote="$(cfg .git.remote)"
branche="$(cfg .git.branche_integration)"
if git -C "$RACINE" remote get-url "$remote" >/dev/null 2>&1; then
  if ! timeout -k 5 60 git -C "$RACINE" fetch --quiet "$remote" "$branche" 2>/dev/null; then
    echo "avertissement : impossible de rafraîchir $remote/$branche, lecture de la dernière copie connue" >&2
  fi
fi

exec node "$SCRIPTS/etat.mjs" prerequis "$1"
