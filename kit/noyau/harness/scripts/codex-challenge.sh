#!/usr/bin/env bash
# codex-challenge.sh : challenge d'une spec par le relecteur, du point de vue du produit.
#
# Le relecteur est un autre modèle que le rédacteur : il ne partage pas ses angles morts. Il
# juge la spec comme document de DÉCISION (ce qu'on construit, pour qui, comment on saura que
# c'est fait), pas comme document technique.
#
# Usage : codex-challenge.sh <spec.md> [contexte supplémentaire ...]
# Sortie : <dossier de la spec>/codex-challenge.json (schéma harness/schemas/challenge.json)
# Codes : 0 challenge écrit ; 1 échec (rien n'est écrit) ; 5 le relecteur a écrit ; 64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/codex-common.sh"
relecteur_sous_verrou "${BASH_SOURCE[0]}" "$@"

SPEC="${1:-}"
if [[ -z "$SPEC" ]]; then
  echo "usage : codex-challenge.sh <spec.md> [contexte supplémentaire ...]" >&2
  exit 64
fi
[[ -f "$SPEC" ]] || refuser "spec introuvable : $SPEC"
shift
codex_preparer

SORTIE="$(dirname "$SPEC")/codex-challenge.json"
APPROBATEUR="$(cfg .projet.approbateur)"
PLUS=""
for f in "$@"; do PLUS+=" - $f"$'\n'; done

PROMPT="Tu es un analyste métier senior, sceptique et exigeant. Tu challenges la spec d'une story du projet « $(cfg .projet.nom) » : $(cfg .projet.description)

Lis d'abord :
 - $SPEC (la spec à challenger)
$(codex_contexte)
${PLUS}
Ton angle est le PRODUIT, pas l'implémentation :
1. Valeur : le problème est-il réel pour l'utilisateur visé ? La story le résout-elle, ou le déplace-t-elle ?
2. Cohérence : la spec contredit-elle une décision ou une règle écrite dans les documents de contexte ?
3. Acceptation : chaque critère est-il vérifiable par quelqu'un qui n'a pas écrit la spec ? Un critère flou est un finding.
4. Périmètre : que fait la story qu'on ne lui demande pas ? Que lui manque-t-il pour être utilisable de bout en bout ?
5. Hypothèses : quels faits la spec tient-elle pour acquis sans les avoir vérifiés ?
6. Décisions : qu'est-ce que seul $APPROBATEUR peut trancher ? Mets-le dans questions_pour_humain, pas dans les findings.

Ne commente ni le choix des outils ni le code : ce n'est pas le moment.
Un finding est concret : il cite le passage de la spec et dit ce qu'elle devrait dire à la place. Pas de remarque générale.
Sévérités : critique = la story livrée ainsi serait fausse ou inutile ; majeur = elle serait incomplète ou ambiguë sur un point qui compte ; mineur = amélioration.
Verdict : solide, a_reviser ou a_rejeter.

$(codex_consignes)
Rends UNIQUEMENT le JSON conforme au schéma fourni."

rc=0
codex_run "$SCHEMAS/challenge.json" "$SORTIE" "$PROMPT" || rc=$?
if ((rc != 0)); then exit "$rc"; fi

echo "challenge écrit : $SORTIE"
jq -r --arg a "$APPROBATEUR" '"verdict: \(.verdict) | findings: \(.findings | length) | questions pour \($a): \(.questions_pour_humain | length)"' "$SORTIE"
