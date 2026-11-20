#!/usr/bin/env bash
# codex-arbitrer.sh : arbitrage d'UN désaccord tenace, par le relecteur en contexte NEUF.
#
# Quand un finding survit à plusieurs rounds (le codeur le réfute, le relecteur le redétecte),
# continuer la boucle ne converge pas. Un juge qui n'a vu ni le débat ni les rounds précédents
# relit le code et tranche. Sa portée est bornée par le superviseur, pas ici : son
# « faux_positif » ne ferme seul qu'un P2 ; un P0 ou un P1 monte toujours à l'humain.
#
# Usage : codex-arbitrer.sh <finding.json> [sortie.json]
#   <finding.json> : {cle, titre, detail, severite, refutation_codeur, fichier}
# Sortie : par défaut <finding>.arbitration.json (schéma harness/schemas/arbitration.json)
# Codes : 0 verdict écrit ; 1 échec (rien n'est écrit) ; 5 le relecteur a écrit ; 64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/codex-common.sh"
relecteur_sous_verrou "${BASH_SOURCE[0]}" "$@"

FINDING="${1:-}"
if [[ -z "$FINDING" ]]; then
  echo "usage : codex-arbitrer.sh <finding.json> [sortie.json]" >&2
  exit 64
fi
[[ -f "$FINDING" ]] || refuser "finding introuvable : $FINDING"
jq -e 'type == "object" and (.cle | type == "string") and (.titre | type == "string") and (.detail | type == "string") and (.severite | type == "string") and (.refutation_codeur | type == "string")' "$FINDING" >/dev/null 2>&1 \
  || refuser "finding invalide : il faut {cle, titre, detail, severite, refutation_codeur, fichier}"
SORTIE="${2:-${FINDING%.json}.arbitration.json}"
codex_preparer

PROMPT="Tu es un juge technique indépendant sur le projet « $(cfg .projet.nom) ». Deux parties sont en désaccord sur un défaut signalé en review de code. Tu n'as vu aucun de leurs échanges : tu juges sur le code.

Le finding du relecteur :
 - titre : $(jq -r '.titre' "$FINDING")
 - sévérité annoncée : $(jq -r '.severite' "$FINDING")
 - fichier : $(jq -r '.fichier // "non précisé"' "$FINDING")
 - détail : $(jq -r '.detail' "$FINDING")

La réfutation du codeur :
$(jq -r '.refutation_codeur' "$FINDING")

Ouvre le fichier concerné et ce qui l'appelle. Vérifie par toi-même : ne crois ni l'un ni l'autre sur parole.
Rends un verdict :
 - finding_valide : le défaut existe tel que décrit, la réfutation ne tient pas ;
 - faux_positif : le défaut n'existe pas, ou le cas décrit ne peut pas se produire ; dis quel fait du code le prouve ;
 - resolution_recommandee : les deux ont en partie raison ; décris le correctif minimal dans correctif_suggere.
severite : la sévérité que TU retiens (P0 à P3), ou null pour un faux positif.
justification : les faits du code qui fondent le verdict, avec les fichiers et les lignes.

$(codex_consignes)
Rends UNIQUEMENT le JSON conforme au schéma fourni."

rc=0
codex_run "$SCHEMAS/arbitration.json" "$SORTIE" "$PROMPT" || rc=$?
if ((rc != 0)); then exit "$rc"; fi

echo "arbitrage écrit : $SORTIE"
jq -r '"verdict: \(.verdict)"' "$SORTIE"
