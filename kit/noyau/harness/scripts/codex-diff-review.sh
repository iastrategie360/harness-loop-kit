#!/usr/bin/env bash
# codex-diff-review.sh : review du diff de la branche par le relecteur, PENDANT le stage CODE.
#
# C'est la review de travail (régime de rigueur complète) : elle alimente la boucle de
# correction, pas la certification de la PR. Sa sortie n'est pas commitée. Elle rend aussi les
# findings bloquants dans un fichier prêt pour « etat.mjs ledger-round », qui tient la mémoire
# des rounds (clé stable : fichier + titre, jamais la ligne).
#
# Usage : codex-diff-review.sh [sortie.md]
# Sortie : par défaut harness/.travail/relecteur/diff-review-<branche>.md
#          et <sortie>.findings.json : [{cle, titre, severite, fichier}] (P0 à P2 seulement)
# Codes : 0 aucun finding bloquant (ou aucun diff) ; 1 échec (rien d'exploitable) ;
#         2 il reste au moins un finding P0 à P2 ; 5 le relecteur a écrit ; 64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/codex-common.sh"

if (($# > 1)) || [[ "${1:-}" == -* ]]; then
  echo "usage : codex-diff-review.sh [sortie.md]" >&2
  exit 64
fi
codex_preparer

BRANCHE="$(git -C "$RACINE" rev-parse --abbrev-ref HEAD)"
NOM="$(printf '%s' "$BRANCHE" | tr -c 'A-Za-z0-9._-' '_')"
SORTIE="${1:-$TRAVAIL/relecteur/diff-review-$NOM.md}"
BRUT="$TRAVAIL/relecteur/diff-review-$NOM.brut"

BASE_REF="$(codex_base_ref)" || exit 1
if git -C "$RACINE" diff --quiet "$BASE_REF"...HEAD; then
  echo "aucun diff commité entre $BASE_REF et $BRANCHE : rien à relire"
  exit 0
fi
if codex_diff_touche_exclus "$BASE_REF"; then
  refuser "le diff touche un chemin de relecteur.chemins_exclus (ci-dessus) : il partirait chez le relecteur. La review n'est pas lancée."
fi
# Le dossier d'état est écarté du contrôle : `etat.mjs tour` l'écrit avant chaque pas, il est
# donc toujours modifié ici, et un avertissement qui sonne à chaque fois ne dit plus rien.
ETAT_REL="$(cfg '.chemins.etat')"
if [[ -n "$(git -C "$RACINE" status --porcelain --untracked-files=no -- . ":(exclude)$ETAT_REL")" ]]; then
  echo "avertissement : des modifications ne sont pas commitées. La review porte sur ce qui est commité." >&2
fi

rc=0
codex_review "$BASE_REF" "$BRUT" "$(codex_delai diff)" || rc=$?
if ((rc != 0)); then exit "$rc"; fi

mkdir -p "$(dirname "$SORTIE")"
cp "$BRUT" "$SORTIE"
echo "review du diff écrite : $SORTIE"
rc=0
node "$SCRIPTS/review-extraire.mjs" --brut "$BRUT" --jsonl "$BRUT.jsonl" --racine "$RACINE" --sortie "$SORTIE.findings.json" || rc=$?
exit "$rc"
