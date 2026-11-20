#!/usr/bin/env bash
# gate.sh : lance une commande de vérification du projet et rend SON code de sortie.
#
# POURQUOI un script pour ça :
#   - une gate écrite `commande | tail -5 || exit 1` teste le code de `tail`, pas celui de la
#     commande : une suite rouge passe pour verte. Ici la commande tourne SANS pipe, sa sortie
#     part dans un journal, et le code rendu est le sien ;
#   - une commande jamais lancée n'est pas une vérification. Une commande sans preuve
#     (`prouvee_le`) est donc refusée : c'est l'installateur qui la prouve, avec --essai.
#
# Usage :
#   gate.sh <nom>                    nom = installer | tests | tests_longs | build | statique
#                                          | statique:<nom>
#   gate.sh --essai <nom> [--base-rouge]   lance et enregistre la preuve dans la configuration
#   gate.sh --liste                  l'état de chaque commande déclarée
#
# Codes : celui de la commande ; 0 si la commande est déclarée absente (null) ;
#         97 refus (commande sans preuve ou inconnue) ; 124 délai dépassé ; 2 usage.
# Réglages : GATE_DELAI_S (défaut 3600), GATE_LIGNES (défaut 40 dernières lignes affichées).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/commun.sh"

CODE_REFUS=97
DELAI="${GATE_DELAI_S:-3600}"
LIGNES="${GATE_LIGNES:-40}"
SIMPLES="installer tests tests_longs build"

usage() {
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

lister() {
  jq -r '
    def ligne($nom; $c):
      if $c == null then "\($nom)\tabsente (déclarée sans commande)"
      elif $c.prouvee_le == null then "\($nom)\tNON PROUVÉE\t\($c.cmd)"
      else "\($nom)\tprouvée le \($c.prouvee_le), exit \($c.exit), \($c.duree_s) s\(if $c.base_rouge then ", BASE ROUGE" else "" end)\t\($c.cmd)"
      end;
    (.commandes | to_entries[] | select(.key != "statique") | ligne(.key; .value)),
    (.commandes.statique[] | ligne("statique:\(.nom)"; .))
  ' "$CONFIG"
}

essai=0
base_rouge=0
nom=""
while (($#)); do
  case "$1" in
    --essai) essai=1 ;;
    --base-rouge) base_rouge=1 ;;
    --liste) lister; exit 0 ;;
    -*) usage ;;
    *) [[ -z "$nom" ]] || usage; nom="$1" ;;
  esac
  shift
done
[[ -n "$nom" ]] || usage

# lancer_une <nom> : rend le code de la commande (ou 0 absente, 97 refus).
lancer_une() {
  local nom="$1" c cmd prouvee base journal_gate debut duree code=0
  c="$(commande_json "$nom")"
  if [[ -z "$c" ]]; then
    if [[ "$nom" == statique:* ]]; then
      echo "REFUS : commande statique inconnue : « ${nom#statique:} » (voir gate.sh --liste)" >&2
      return "$CODE_REFUS"
    fi
    echo "gate $nom : ABSENTE (déclarée sans commande dans harness/projet.json)"
    return 0
  fi
  cmd="$(jq -r '.cmd' <<<"$c")"
  prouvee="$(jq -r '.prouvee_le // ""' <<<"$c")"
  base="$(jq -r '.base_rouge' <<<"$c")"
  if ((!essai)) && [[ -z "$prouvee" ]]; then
    echo "REFUS : la commande « $nom » n'a jamais été prouvée. La lancer une première fois : gate.sh --essai $nom" >&2
    return "$CODE_REFUS"
  fi

  mkdir -p "$TRAVAIL/gates"
  journal_gate="$TRAVAIL/gates/${nom//:/-}.log"
  debut="$(date +%s)"
  # SANS pipe : le code capturé est celui de la commande, pas celui d'un filtre. Et `pipefail`
  # dans le shell lancé, qui n'hérite pas du nôtre : une commande DÉCLARÉE avec un pipe (des
  # tests suivis d'un filtre) rendrait sinon le code du filtre, et la gate serait verte.
  (cd "$RACINE" && timeout -k 10 "$DELAI" bash -o pipefail -c "$cmd") >"$journal_gate" 2>&1 || code=$?
  duree=$(($(date +%s) - debut))

  tail -n "$LIGNES" "$journal_gate"
  if ((code == 0)); then
    echo "gate $nom : VERT (${duree} s) · journal : $journal_gate"
  elif ((code == 124)); then
    echo "gate $nom : DÉLAI DÉPASSÉ (${DELAI} s) · journal : $journal_gate"
  else
    echo "gate $nom : ROUGE (exit $code, ${duree} s) · journal : $journal_gate"
    if [[ "$base" == "true" ]] && ((!essai)); then
      echo "AVERTISSEMENT : base rouge déclarée le $prouvee. Cette commande échouait DÉJÀ : ce rouge ne prouve pas une régression, et un vert ne prouvait rien non plus. Compare les échecs un par un."
    fi
  fi

  if ((essai)); then
    if ((code == 0)); then
      node "$SCRIPTS/lib/config.mjs" prouver "$nom" --exit 0 --duree "$duree" || return "$CODE_REFUS"
    elif ((base_rouge)) && ((code != 124)); then
      node "$SCRIPTS/lib/config.mjs" prouver "$nom" --exit "$code" --duree "$duree" --base-rouge || return "$CODE_REFUS"
      echo "base rouge déclarée : la commande échoue aujourd'hui, c'est consigné."
    else
      echo "preuve NON enregistrée : la commande échoue. La corriger, ou déclarer la base rouge : gate.sh --essai $nom --base-rouge"
    fi
  fi
  return "$code"
}

if [[ "$nom" == "statique" ]]; then
  noms="$(cfg_lignes '.commandes.statique | map(.nom)')"
  if [[ -z "$noms" ]]; then
    echo "gate statique : ABSENTE (aucune vérification statique déclarée)"
    exit 0
  fi
  # Toutes sont lancées, même après un rouge : s'arrêter au premier cache l'ampleur.
  premier=0
  bilan=""
  while IFS= read -r n; do
    code=0
    lancer_une "statique:$n" || code=$?
    bilan+="  statique:$n : exit $code"$'\n'
    if ((code != 0 && premier == 0)); then premier="$code"; fi
  done <<<"$noms"
  printf 'bilan statique :\n%s' "$bilan"
  exit "$premier"
fi

if [[ "$nom" != statique:* ]] && [[ " $SIMPLES " != *" $nom "* ]]; then
  echo "REFUS : commande inconnue : « $nom » (attendu : $SIMPLES, statique, statique:<nom>). Le banc se pilote par banc.sh." >&2
  exit "$CODE_REFUS"
fi

code=0
lancer_une "$nom" || code=$?
exit "$code"
