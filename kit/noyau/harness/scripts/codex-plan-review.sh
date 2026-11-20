#!/usr/bin/env bash
# codex-plan-review.sh : contre-review d'un plan technique par le relecteur, AVANT de coder.
#
# Un plan faux coûte cher tard : il se découvre au milieu du code. Le relecteur VÉRIFIE le plan
# contre le dépôt réel (les fichiers cités existent, les fonctions aussi, les pièges connus du
# projet sont évités). Il ne rediscute pas l'opportunité de la story : la spec est validée.
#
# Usage : codex-plan-review.sh <plan.md>
# Sortie : <dossier du plan>/codex-plan-review.json (schéma harness/schemas/plan-review.json)
# Codes : 0 plan relu, rien de bloquant ; 1 échec (rien n'est écrit) ; 2 le plan porte un
#         défaut BLOQUANT (critique_bloquant) ; 5 le relecteur a écrit ; 64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/codex-common.sh"
relecteur_sous_verrou "${BASH_SOURCE[0]}" "$@"

PLAN="${1:-}"
if [[ -z "$PLAN" ]]; then
  echo "usage : codex-plan-review.sh <plan.md>" >&2
  exit 64
fi
[[ -f "$PLAN" ]] || refuser "plan introuvable : $PLAN"
codex_preparer

DOSSIER="$(dirname "$PLAN")"
SORTIE="$DOSSIER/codex-plan-review.json"

PROMPT="Tu es un architecte logiciel senior, sceptique. Tu relis le plan technique d'une story du projet « $(cfg .projet.nom) » AVANT qu'elle soit codée.

Lis d'abord :
 - $PLAN (le plan à relire)
 - $DOSSIER/spec.md (la spec, déjà validée : tu ne la rediscutes pas)
 - $DOSSIER/tasks.md s'il existe (le découpage en tâches)
$(codex_contexte)

Puis VÉRIFIE le plan contre le dépôt réel. Ouvre les fichiers : ne juge pas sur la foi du texte.
1. Réalité : chaque fichier, fonction, table, route ou commande cité par le plan existe-t-il, à l'endroit et sous la forme que le plan suppose ?
2. Couverture : chaque critère d'acceptation de la spec est-il porté par au moins une tâche ?
3. Pièges : le plan tombe-t-il dans un piège écrit dans harness/PROJET.md ?
4. Ordre : une tâche dépend-elle d'une autre placée après elle ?
5. Risque : une étape est-elle irréversible (données, schéma, service partagé) sans retour arrière prévu ?
6. Preuve : pour chaque tâche, sait-on comment on vérifiera qu'elle est faite ?

Un finding est concret : il cite le passage du plan, le fichier réel qui le contredit, et la correction.
Sévérités : critique = coder ce plan tel quel casserait quelque chose ou ne pourrait pas aboutir ; majeur = reprise certaine en cours de route ; mineur = amélioration.
critique_bloquant vaut true UNIQUEMENT si coder le plan tel quel serait dangereux ou voué à l'échec.
Verdict : solide, a_reviser ou a_rejeter.

$(codex_consignes)
Rends UNIQUEMENT le JSON conforme au schéma fourni."

rc=0
codex_run "$SCHEMAS/plan-review.json" "$SORTIE" "$PROMPT" || rc=$?
if ((rc != 0)); then exit "$rc"; fi

echo "contre-review du plan écrite : $SORTIE"
jq -r '"verdict: \(.verdict) | findings: \(.findings | length) | bloquant: \(.critique_bloquant)"' "$SORTIE"
if [[ "$(jq -r '.critique_bloquant' "$SORTIE")" == "true" ]]; then exit 2; fi
