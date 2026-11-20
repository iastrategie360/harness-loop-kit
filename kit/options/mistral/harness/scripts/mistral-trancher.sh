#!/usr/bin/env bash
# mistral-trancher.sh : la TRANCHE FINALE d'un désaccord qui dure (option mistral).
#
# Dernier étage avant l'humain dans l'échelle d'escalade, quand options.mistral.tranche_finale est
# vrai : le désaccord a survécu à l'arbitrage ET à un round de correction. Mandat : la solution la
# PLUS SIMPLE qui clôt le désaccord, sans sur-ingénierie. Sa décision est CONTRAIGNANTE : le
# superviseur en fait une tâche Tfix que le codeur applique telle quelle, et il prévient
# l'approbateur. C'est pourquoi ce script refuse tout ce qui rendrait la décision aveugle :
#
#   - un AUTRE modèle que l'arbitre (options.mistral.modeles.tranche), pour un avis distinct ;
#   - AUCUN outil : la réponse se fait sur le contexte fourni, en un coup. Ce contexte est donc
#     COMPLET ou il n'y a pas de décision : un diff tronqué, ou un prompt qui dépasserait la borne
#     d'un argument, est un refus, jamais une troncature ;
#   - jamais sur un P0 : une décision contraignante d'un modèle sur un défaut critique reste celle
#     de l'humain. Les autres bornes (plancher, périmètre interdit) sont tenues par le superviseur
#     AVANT l'appel, voir harness/options/mistral.md.
#
# Usage : mistral-trancher.sh <finding.json> [sortie.json]
#   <finding.json> : {cle, titre, detail, severite, refutation_codeur, fichier, arbitrage_precedent}
#   arbitrage_precedent : le verdict de l'arbitre (objet ou texte), pour trancher en connaissance
#   de cause.
# Sortie : par défaut <finding>.simplification.json (schéma harness/schemas/simplification.json)
# Variable : MISTRAL_TRANCHE_DIFF_MAX (60000 caractères par défaut).
# Codes : 0 décision écrite ; 1 refus ou échec (rien n'est écrit) ; 5 le relecteur a écrit ; 64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/mistral-commun.sh"
relecteur_sous_verrou "${BASH_SOURCE[0]}" "$@"

FINDING="${1:-}"
if [[ -z "$FINDING" || $# -gt 2 ]]; then
  echo "usage : mistral-trancher.sh <finding.json> [sortie.json]" >&2
  exit 64
fi
[[ -f "$FINDING" ]] || refuser "finding introuvable : $FINDING"
jq -e 'type == "object" and (.cle | type == "string") and (.titre | type == "string") and (.detail | type == "string") and (.severite | type == "string") and (.refutation_codeur | type == "string")' "$FINDING" >/dev/null 2>&1 \
  || refuser "finding invalide : il faut {cle, titre, detail, severite, refutation_codeur, fichier, arbitrage_precedent}"
jq -e '(.arbitrage_precedent | type == "object") or ((.arbitrage_precedent | type == "string") and (.arbitrage_precedent | length > 0))' "$FINDING" >/dev/null 2>&1 \
  || refuser "le finding ne porte pas arbitrage_precedent : la tranche finale suit un arbitrage, elle ne le remplace pas."
[[ "$(jq -r '.severite' "$FINDING")" != "P0" ]] \
  || refuser "un P0 ne se tranche pas par un modèle : il monte à l'humain (etat.mjs escalade <id> <clé> humain)."
SORTIE="${2:-${FINDING%.json}.simplification.json}"
mistral_preparer
# Un AUTRE modèle que l'arbitre, ou pas de tranche : le même modèle rendrait le même avis, et sa
# décision s'appliquerait sans qu'un second regard l'ait portée. Noms EFFECTIFS, surcharges comprises.
[[ "$MISTRAL_SIMPLIFY_MODEL" != "$MISTRAL_REVIEW_MODEL" ]] || refuser   "la tranche finale tournerait avec le modèle de l'arbitre ($MISTRAL_REVIEW_MODEL). options.mistral.modeles.tranche doit nommer un autre modèle."

BASE_REF="$(codex_base_ref)" || exit 1
MAX="${MISTRAL_TRANCHE_DIFF_MAX:-60000}"
# Les chemins exclus par le projet ne partent jamais : ni par le diff ciblé, ni par le repli,
# ni (pour la tranche) par le contenu complet d'un fichier. Contrôlé AVANT toute collecte.
mistral_exclusions_charger "$BASE_REF" || refuser "contrôle des chemins interdits impossible : rien n'est envoyé."
mistral_refuser_copies_interdites
LIBRES="$(mistral_fichiers_libres "$FINDING" --strict)" || exit 1
mapfile -t FICHIERS < <(printf '%s' "$LIBRES" | grep -vE '^$' || true)
# Une décision contraignante se prend sur un fichier IDENTIFIÉ, jamais sur le seul diff.
((${#FICHIERS[@]} > 0)) || refuser \
  "le finding ne nomme aucun fichier (champ fichier) : la tranche finale ne décide pas sur le seul diff. Le préciser, ou escalader vers l'humain."
DIFF="$(mistral_diff_borne "$BASE_REF" "$MAX" "${FICHIERS[@]}")" || exit 1
if ((${#FICHIERS[@]} > 0)) && [[ -z "${DIFF//[$'\n\t ']/}" ]]; then
  echo "AVERTISSEMENT : diff vide pour ${FICHIERS[*]}, repli sur le diff de la branche." >&2
  DIFF="$(mistral_diff_borne "$BASE_REF" "$MAX")" || exit 1
fi
# Fail-closed : sans outil, Mistral ne voit que ce qu'on lui donne. Un diff tronqué peut lui
# cacher le morceau qui compte, et sa décision serait appliquée telle quelle.
if printf '%s' "$DIFF" | grep -qF "[... diff tronqué à"; then
  echo "ERREUR : diff tronqué (plus de $MAX caractères) : contexte incomplet pour une décision contraignante. Refus. Réduire le finding à un fichier plus petit, ou trancher à la main (etat.mjs escalade <id> <clé> humain)." >&2
  exit 1
fi

# Le contenu ACTUEL complet du ou des fichiers du finding : trancher sur les seules lignes
# changées ignorerait le reste du fichier.
# Chaque contenu requis est collecté, ou nommé : un fichier SUPPRIMÉ par la branche l'est en
# toutes lettres ; toute autre absence (fichier inconnu, dossier, lecture impossible) est un refus,
# jamais un saut silencieux qui laisserait décider sur le diff seul.
SOURCE=""
for f in "${FICHIERS[@]}"; do
  if [[ -f "$RACINE/$f" ]]; then
    contenu="$(cat -- "$RACINE/$f")" || refuser "contenu de $f illisible : pas de décision sur un contexte incomplet."
    SOURCE+="=== CONTENU COMPLET DE $f ==="$'\n'"$contenu"$'\n\n'
  elif [[ -n "$(git -C "$RACINE" diff --no-renames --diff-filter=D --name-only -z "$BASE_REF"...HEAD -- "$f" 2>/dev/null | tr -d '\0')" ]]; then
    SOURCE+="=== $f : supprimé par la branche (son ancien contenu est dans le diff) ==="$'\n\n'
  else
    refuser "le fichier du finding « $f » n'existe pas dans le checkout et n'a pas été supprimé par la branche : contexte incomplet, pas de décision."
  fi
done

PROMPT="Tu es un ingénieur pragmatique appelé en dernier recours pour DÉBLOQUER un désaccord de review qui dure dans le projet « $(cfg .projet.nom) » ($(cfg .projet.description)). Relecteur et codeur n'ont pas convergé, même après un arbitrage. Ta seule mission : proposer la solution la PLUS SIMPLE qui clôt le sujet proprement. Refuse la sur-ingénierie, refuse de couvrir des cas qui n'arriveront pas, préfère quelques lignes claires à une abstraction. Ta décision sera appliquée telle quelle.

CONTRAT DE SORTIE (impératif) : termine ta réponse par UNIQUEMENT un bloc \`\`\`json, et RIEN après, contenant exactement {\"diagnostic\", \"solution_simple\", \"fichiers_touches\", \"anti_over_engineering\"} : la cause réelle du désaccord en trois phrases au plus, la solution concrète, la liste des chemins à modifier (relatifs à la racine du dépôt), et ce qu'il ne faut PAS faire.
$(codex_consignes)

Le point de blocage (finding, réfutation du codeur, arbitrage précédent), tel que le superviseur l'a écrit :
$(jq . "$FINDING")
${SOURCE:+
Le contenu actuel complet du ou des fichiers concernés, pour juger en contexte :
--- DÉBUT DES SOURCES ---
$SOURCE--- FIN DES SOURCES ---
}
Le diff pertinent ($BASE_REF...HEAD, limité au fichier du finding quand il est connu) :
--- DÉBUT DU DIFF ---
$DIFF
--- FIN DU DIFF ---
Rappel : termine par le bloc json du contrat."

BRUT="$MISTRAL_TRAVAIL/$(basename "${SORTIE%.json}").brut"
rm -f "$BRUT"
rc=0
mistral_appel_isole aucun "$PROMPT" "$BRUT" "$MISTRAL_SIMPLIFY_MODEL" "$MISTRAL_TRANCHE_MAX_PRICE" \
  "$MISTRAL_SIMPLIFY_INPUT_PRICE" "$MISTRAL_SIMPLIFY_OUTPUT_PRICE" "$MISTRAL_TRANCHE_MAX_TURNS" "$MISTRAL_TRANCHE_TIMEOUT" || rc=$?
if ((rc != 0)); then exit "$rc"; fi
mkdir -p "$(dirname "$SORTIE")"
mistral_extraire_json "$BRUT" "$SORTIE" "$SCHEMAS/simplification.json" || exit 1

echo "tranche finale écrite : $SORTIE (Mistral $MISTRAL_SIMPLIFY_MODEL, coût $(mistral_cout "$BRUT") USD)"
jq -r '"solution: " + .solution_simple' "$SORTIE"
