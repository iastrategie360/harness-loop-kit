#!/usr/bin/env bash
# mistral-arbitrer.sh : arbitrage d'UN désaccord tenace par Mistral (option mistral).
#
# Remplace codex-arbitrer.sh à l'étage « arbitre » de l'échelle d'escalade quand
# options.mistral.arbitre est vrai. Même contrat d'entrée, même schéma de sortie
# (harness/schemas/arbitration.json) : le superviseur applique le verdict de la même façon. La
# différence est le juge : un modèle d'un AUTRE fournisseur que le relecteur qui a signalé le
# défaut, donc sans ses angles morts.
#
# Sa portée est bornée par le superviseur, pas ici : son « faux_positif » ne ferme seul qu'un P2 ;
# un P0 ou un P1 qu'il dit faux monte toujours à l'humain.
#
# Contexte fourni : le finding, la réfutation du codeur, le diff LIMITÉ au fichier du finding
# (borné, avec un avis de troncature : l'arbitre peut lire le fichier entier avec ses outils), et
# le dépôt en lecture seule (read_file, grep). L'arbitre ne décide pas seul : une troncature du
# diff ne rend donc pas son avis dangereux, contrairement à celui de la tranche finale.
#
# Usage : mistral-arbitrer.sh <finding.json> [sortie.json]
#   <finding.json> : {cle, titre, detail, severite, refutation_codeur, fichier}
# Sortie : par défaut <finding>.arbitration.json
# Variable : MISTRAL_ARBITRE_DIFF_MAX (60000 caractères par défaut).
# Codes : 0 verdict écrit ; 1 échec (rien n'est écrit) ; 5 le relecteur a écrit ; 64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/mistral-commun.sh"
relecteur_sous_verrou "${BASH_SOURCE[0]}" "$@"

FINDING="${1:-}"
if [[ -z "$FINDING" || $# -gt 2 ]]; then
  echo "usage : mistral-arbitrer.sh <finding.json> [sortie.json]" >&2
  exit 64
fi
[[ -f "$FINDING" ]] || refuser "finding introuvable : $FINDING"
jq -e 'type == "object" and (.cle | type == "string") and (.titre | type == "string") and (.detail | type == "string") and (.severite | type == "string") and (.refutation_codeur | type == "string")' "$FINDING" >/dev/null 2>&1 \
  || refuser "finding invalide : il faut {cle, titre, detail, severite, refutation_codeur, fichier}"
SORTIE="${2:-${FINDING%.json}.arbitration.json}"
mistral_preparer

BASE_REF="$(codex_base_ref)" || exit 1
MAX="${MISTRAL_ARBITRE_DIFF_MAX:-60000}"
# Les chemins exclus par le projet ne partent jamais : ni par le diff ciblé, ni par le repli,
# ni (pour la tranche) par le contenu complet d'un fichier. Contrôlé AVANT toute collecte.
mistral_exclusions_charger "$BASE_REF" || refuser "contrôle des chemins interdits impossible : rien n'est envoyé."
mistral_refuser_copies_interdites
LIBRES="$(mistral_fichiers_libres "$FINDING")" || exit 1
mapfile -t FICHIERS < <(printf '%s' "$LIBRES" | grep -vE '^$' || true)
DIFF="$(mistral_diff_borne "$BASE_REF" "$MAX" "${FICHIERS[@]}")" || exit 1
if ((${#FICHIERS[@]} > 0)) && [[ -z "${DIFF//[$'\n\t ']/}" ]]; then
  echo "AVERTISSEMENT : diff vide pour ${FICHIERS[*]}, repli sur le diff de la branche (borné)." >&2
  DIFF="$(mistral_diff_borne "$BASE_REF" "$MAX")" || exit 1
fi

PROMPT="Tu es un juge technique indépendant sur le projet « $(cfg .projet.nom) ». Deux parties sont en désaccord sur un défaut signalé en review de code, après plusieurs rounds sans accord. Tu n'as vu aucun de leurs échanges : tu juges sur le code. Ton rôle n'est PAS de chercher d'autres défauts, mais de TRANCHER sur ce seul finding, sans parti pris.

CONTRAT DE SORTIE (impératif) : termine ta réponse par UNIQUEMENT un bloc \`\`\`json, et RIEN après, contenant exactement l'objet {\"verdict\", \"justification\", \"correctif_suggere\", \"severite\"} :
 - verdict : finding_valide (le défaut existe tel que décrit, la réfutation ne tient pas), faux_positif (le défaut n'existe pas, ou le cas décrit ne peut pas se produire : dis quel fait du code le prouve), ou resolution_recommandee (les deux ont en partie raison : décris le correctif minimal) ;
 - justification : les faits du code qui fondent le verdict, avec les fichiers et les lignes lus, en trois phrases au plus ;
 - correctif_suggere : le correctif concret et minimal, ou, pour un faux positif, pourquoi le finding peut être fermé ;
 - severite : la sévérité que TU retiens (P0 à P3), ou null pour un faux positif.
Préfère la solution la plus simple qui soit correcte.

Le finding du relecteur :
 - titre : $(jq -r '.titre' "$FINDING")
 - sévérité annoncée : $(jq -r '.severite' "$FINDING")
 - fichier : $(jq -r '.fichier // "non précisé"' "$FINDING")
 - détail : $(jq -r '.detail' "$FINDING")

La réfutation du codeur :
$(jq -r '.refutation_codeur' "$FINDING")

Ouvre le fichier concerné et ce qui l'appelle. Vérifie par toi-même : ne crois ni l'un ni l'autre sur parole.
$MISTRAL_CONSIGNE_OUTILS
$(codex_consignes)

Le diff pertinent ($BASE_REF...HEAD, limité au fichier du finding quand il est connu) :
--- DÉBUT DU DIFF ---
$DIFF
--- FIN DU DIFF ---
Rappel : termine par le bloc json du contrat."

BRUT="$MISTRAL_TRAVAIL/$(basename "${SORTIE%.json}").brut"
rm -f "$BRUT"
debut=$(date +%s)
rc=0
mistral_appel_isole lecture "$PROMPT" "$BRUT" "$MISTRAL_REVIEW_MODEL" "$MISTRAL_MAX_PRICE" \
  "$MISTRAL_INPUT_PRICE" "$MISTRAL_OUTPUT_PRICE" "$MISTRAL_MAX_TURNS" "$MISTRAL_TIMEOUT" || rc=$?
if ((rc != 0)); then exit "$rc"; fi
mkdir -p "$(dirname "$SORTIE")"
mistral_extraire_json "$BRUT" "$SORTIE" "$SCHEMAS/arbitration.json" || exit 1

echo "arbitrage écrit : $SORTIE (Mistral $MISTRAL_REVIEW_MODEL, coût $(mistral_cout "$BRUT") USD, $(($(date +%s) - debut)) s)"
jq -r '"verdict: \(.verdict)"' "$SORTIE"
