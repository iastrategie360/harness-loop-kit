#!/usr/bin/env bash
# mistral-preflight.sh : les relecteurs de l'option mistral peuvent-ils partir sur cette machine ?
#
# POURQUOI : un CLI absent, trop ancien ou sans clé se découvre sinon au milieu d'une passe, au
# moment de certifier une PR. L'installateur lance ce script au lieu de croire la réponse
# « vibe est installé » : il PROUVE la commande.
#
# Sans argument, il contrôle tout ce qui se contrôle sans rien envoyer : option active, accord
# d'envoi, CLI et version, présence de la clé (jamais sa valeur), profil de lecture seule, valeurs
# de configuration. Avec --appel, il fait en plus UN appel réel, sans outil, plafonné à quelques
# centimes, et vérifie la réponse : c'est la seule preuve que la clé et le réseau marchent.
#
# Usage : mistral-preflight.sh [--appel]
# Codes : 0 prêt ; 1 il manque quelque chose (le motif est donné) ; 5 le relecteur a écrit ;
#         64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/mistral-commun.sh"

appel=0
case "${1:-}" in
  "") ;;
  --appel) appel=1 ;;
  *)
    echo "usage : mistral-preflight.sh [--appel]" >&2
    exit 64
    ;;
esac
# L'appel réel prend le verrou des relecteurs, comme les autres : jamais deux en même temps.
if ((appel)); then relecteur_sous_verrou "${BASH_SOURCE[0]}" "$@"; fi

mistral_preparer
if [[ "$(cfg '.options.mistral.arbitre and .options.mistral.tranche_finale')" == "true" && "$MISTRAL_SIMPLIFY_MODEL" == "$MISTRAL_REVIEW_MODEL" ]]; then
  refuser "la tranche finale est active, mais son modèle est celui de l'arbitre ($MISTRAL_REVIEW_MODEL) : options.mistral.modeles.tranche doit nommer un autre modèle."
fi
echo "  OK      option mistral active, accord d'envoi donné"
echo "  OK      vibe $MISTRAL_VIBE_VERSION (minimum $MISTRAL_VIBE_MIN), ripgrep présent"
echo "  OK      clé Mistral présente (valeur jamais affichée)"
echo "  OK      profil de lecture seule conforme : $MISTRAL_PROFIL"
echo "  OK      profil effectif, chemins exclus du projet compris : $MISTRAL_PROFIL_EFFECTIF"
echo "  OK      modèles : relecture $MISTRAL_REVIEW_MODEL, tranche $MISTRAL_SIMPLIFY_MODEL"
echo "  OK      budget d'une relecture : $MISTRAL_BUDGET_REVUE USD au plus, $MISTRAL_MAX_PRICE USD par session"

if ((appel)); then
  BRUT="$MISTRAL_TRAVAIL/preflight.brut"
  rm -f "$BRUT"
  rc=0
  # Un appel minimal, sans outil, au modèle de la relecture : le prompt ne contient rien du projet.
  mistral_appel_isole aucun "Réponds par le seul mot PRET, en majuscules, sans rien d'autre." "$BRUT" \
    "$MISTRAL_REVIEW_MODEL" 0.05 "$MISTRAL_INPUT_PRICE" "$MISTRAL_OUTPUT_PRICE" 2 120 || rc=$?
  if ((rc != 0)); then exit "$rc"; fi
  if ! grep -q "PRET" "$BRUT"; then
    echo "ERREUR : Mistral a répondu, mais pas ce qui était demandé. Réponse : $BRUT" >&2
    exit 1
  fi
  echo "  OK      appel réel : Mistral répond ($(mistral_cout "$BRUT") USD)"
fi
echo "mistral-preflight : prêt."
