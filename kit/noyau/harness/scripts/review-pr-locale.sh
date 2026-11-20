#!/usr/bin/env bash
# review-pr-locale.sh : la review de PR, faite sur la machine par le CLI du relecteur.
#
# C'est la review qui CERTIFIE : son résultat est un artefact commité avec la branche, que la
# gate relit (review-locale.mjs). Attendre qu'un service poste une review sur la PR, c'est
# dépendre d'un tiers qui peut se taire sans prévenir : un silence ressemble à « rien à dire ».
# Ici la review est lancée, sa sortie est vérifiée, et son absence bloque.
#
# Usage : review-pr-locale.sh <story-id>
#         review-pr-locale.sh --branche        (branche sans dossier de story)
# Sortie : <chemins.specs>/<id>/review-pr.json et .md si le dossier de la story existe,
#          sinon <chemins.reviews>/<branche assainie>.json et .md
# Codes : 0 review menée et artefact écrit (le VERDICT est rendu par review-locale.mjs) ;
#         1 pas d'artefact (échec, sortie inexploitable, base non rafraîchie, rien à relire) ;
#         5 le relecteur a écrit ; 64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/codex-common.sh"
relecteur_sous_verrou "${BASH_SOURCE[0]}" "$@"

CIBLE="${1:-}"
if [[ -z "$CIBLE" || $# -gt 1 ]]; then
  echo "usage : review-pr-locale.sh <story-id> | --branche" >&2
  exit 64
fi
codex_preparer

BRANCHE="$(git -C "$RACINE" rev-parse --abbrev-ref HEAD)"
[[ "$BRANCHE" != "HEAD" ]] || refuser "HEAD détaché : la review de PR se lance depuis la branche de la story."
BASE="$(cfg .git.branche_integration)"
[[ "$BRANCHE" != "$BASE" && "$BRANCHE" != "$(cfg .git.branche_production)" ]] \
  || refuser "tu es sur « $BRANCHE » : la review de PR se lance depuis la branche de la story."

SPECS="$(cfg .chemins.specs)"
NOM="$(printf '%s' "$BRANCHE" | tr -c 'A-Za-z0-9._-' '_')"
if [[ "$CIBLE" == "--branche" ]]; then
  ARTEFACT="$(cfg .chemins.reviews)/$NOM.json"
else
  [[ "$CIBLE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || refuser "identifiant de story invalide : $CIBLE"
  [[ -d "$RACINE/$SPECS/$CIBLE" ]] || refuser "dossier de story introuvable : $SPECS/$CIBLE (pour une branche sans story : --branche)"
  ARTEFACT="$SPECS/$CIBLE/review-pr.json"
fi
BRUT="$TRAVAIL/relecteur/review-pr-$NOM.brut"

# Une review qui certifie ne se fait pas contre une base périmée : rafraîchissement bloquant.
BASE_REF="$(codex_base_ref --bloquant)" || exit 1
if git -C "$RACINE" diff --quiet "$BASE_REF"...HEAD; then
  echo "ERREUR : aucun diff commité entre $BASE_REF et $BRANCHE. Rien à relire, donc rien à certifier." >&2
  exit 1
fi
if codex_diff_touche_exclus "$BASE_REF"; then
  refuser "le diff touche un chemin de relecteur.chemins_exclus (ci-dessus) : il partirait chez le relecteur. La review n'est pas lancée."
fi
# L'artefact certifie HEAD, et le relecteur lit l'arbre de travail : les deux doivent être le
# même objet. Un fichier suivi modifié sans être commité peut lui cacher un défaut du commit
# certifié. Seuls passent l'état (réécrit avant chaque pas) et l'artefact que ce script réécrit
# lui-même : ni l'un ni l'autre n'est du code à relire.
NON_COMMITES="$(git -C "$RACINE" status --porcelain --untracked-files=no -- . \
  ":(exclude)$(cfg .chemins.etat)" ":(exclude)$ARTEFACT" ":(exclude)${ARTEFACT%.json}.md")"
if [[ -n "$NON_COMMITES" ]]; then
  printf '%s\n' "$NON_COMMITES" | sed -n '1,20p' >&2
  refuser "des fichiers suivis sont modifiés sans être commités (ci-dessus). Le relecteur lit l'arbre de travail, l'artefact certifie le commit courant : commite d'abord, ou mets ces modifications de côté."
fi
# Un fichier jamais ajouté à Git n'arrête pas la review : un arbre de travail en porte presque
# toujours (notes, captures), et un refus pousserait à tout ajouter d'un coup. Mais le
# relecteur peut le lire alors que le commit certifié ne le contient pas : on le dit.
NON_SUIVIS="$(git -C "$RACINE" ls-files --others --exclude-standard -- . \
  ":(exclude)$(cfg .chemins.etat)" ":(exclude)$ARTEFACT" ":(exclude)${ARTEFACT%.json}.md" \
  ':(exclude)harness/.travail')"
if [[ -n "$NON_SUIVIS" ]]; then
  echo "AVERTISSEMENT : des fichiers n'ont jamais été ajoutés à Git (les premiers ci-dessous). Le relecteur peut les lire, le commit certifié ne les contient pas : si le code relu en dépend, ajoute-les, commite et relance." >&2
  printf '%s\n' "$NON_SUIVIS" | sed -n '1,10p' >&2
fi
HEAD_SHA="$(git -C "$RACINE" rev-parse HEAD)"

rc=0
codex_review "$BASE_REF" "$BRUT" "$(codex_delai pr)" || rc=$?
if ((rc != 0)); then exit "$rc"; fi

# La fusion refuse d'écrire si la sortie n'atteste pas d'une review menée au bout.
node "$SCRIPTS/review-pr-fusionner.mjs" \
  --artefact "$RACINE/$ARTEFACT" --brut "$BRUT" --jsonl "$BRUT.jsonl" \
  --head-sha "$HEAD_SHA" --branche "$BRANCHE" --base "$BASE" \
  --modele "${CODEX_MODELE:-défaut du CLI}" --racine "$RACINE" || exit 1

echo "À commiter avec la branche : $ARTEFACT et ${ARTEFACT%.json}.md"
if [[ "$CIBLE" == "--branche" ]]; then
  echo "Verdict : node harness/scripts/review-locale.mjs $ARTEFACT"
else
  echo "Verdict : node harness/scripts/review-locale.mjs $CIBLE"
fi
