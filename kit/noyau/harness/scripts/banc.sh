#!/usr/bin/env bash
# banc.sh : le banc local, là où le produit tourne pour être exercé et regardé.
#
# POURQUOI un script pour ça :
#   - un banc lancé avec la configuration de production écrit dans la production. La garde
#     passe AVANT tout démarrage, et elle ne montre jamais une valeur ;
#   - un banc tué par son nom tue aussi les processus du voisin. Ici on n'arrête QUE le
#     groupe de processus qu'on a lancé, retrouvé par son PID exact ;
#   - un port déjà pris fait croire qu'on teste son code alors qu'on teste celui d'un autre.
#
# Usage :
#   banc.sh garde                      contrôle la garde de production, ne lance rien
#   banc.sh port                       le port du banc (refuse un port interdit ou déjà pris)
#   banc.sh demarrer                   garde, démarrage, attente de la santé
#   banc.sh etat                       tourne ou non, depuis quand, sur quel port
#   banc.sh arreter                    arrête le groupe de processus lancé par demarrer
#   banc.sh capture <cible> <sortie>   rendu réel de <cible> dans le fichier <sortie>
#   banc.sh essai                      cycle complet, et preuve enregistrée (installation)
#
# Codes : 0 fait (ou banc déclaré absent) ; 1 refus ou échec ; 97 commande sans preuve ;
#         2 usage.
# Réglages : HARNESS_PORT (remplace execution.port), BANC_ATTENTE_S (défaut 120).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/commun.sh"

CODE_REFUS=97
ATTENTE="${BANC_ATTENTE_S:-120}"
FICHE="$TRAVAIL/banc.json"
JOURNAL_BANC="$TRAVAIL/banc.log"
ESSAI=0
mkdir -p "$TRAVAIL"

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# valeur_dans_fichier <fichier> <variable> : la dernière valeur définie, sans les guillemets.
valeur_dans_fichier() {
  awk -v nom="$2" '
    {
      ligne = $0
      sub(/^[ \t]*(export[ \t]+)?/, "", ligne)
      if (index(ligne, nom "=") == 1) {
        v = substr(ligne, length(nom) + 2)
        sub(/\r$/, "", v)
        if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
        trouve = v
      }
    }
    END { printf "%s", trouve }
  ' "$1"
}

# garde : rend 1 si une variable contrôlée vise une cible interdite. N'affiche JAMAIS une valeur.
garde() {
  local variables motifs fichiers variable motif fichier chemin valeur fautes=0
  variables="$(cfg_lignes .execution.garde_prod.variables)"
  motifs="$(cfg_lignes .execution.garde_prod.motifs_interdits)"
  fichiers="$(cfg_lignes .execution.garde_prod.fichiers)"
  if [[ -z "$variables" || -z "$motifs" ]]; then
    echo "garde de production : rien à contrôler (aucune variable ou aucun motif déclaré)"
    return 0
  fi
  while IFS= read -r variable; do
    while IFS= read -r motif; do
      valeur="${!variable:-}"
      if [[ -n "$valeur" && "$valeur" =~ $motif ]]; then
        echo "REFUS : la variable $variable (environnement du processus) vise une cible interdite (motif « $motif »)." >&2
        fautes=$((fautes + 1))
      fi
      while IFS= read -r fichier; do
        [[ -n "$fichier" ]] || continue
        chemin="$fichier"
        [[ "$chemin" == /* ]] || chemin="$RACINE/$chemin"
        [[ -r "$chemin" ]] || continue
        valeur="$(valeur_dans_fichier "$chemin" "$variable")"
        if [[ -n "$valeur" && "$valeur" =~ $motif ]]; then
          echo "REFUS : la variable $variable (fichier $fichier) vise une cible interdite (motif « $motif »)." >&2
          fautes=$((fautes + 1))
        fi
      done <<<"$fichiers"
    done <<<"$motifs"
  done <<<"$variables"
  if ((fautes > 0)); then
    echo "Le banc ne démarre pas : il écrirait ailleurs que chez lui. Corrige l'environnement, pas la garde." >&2
    return 1
  fi
  echo "garde de production : verte"
  return 0
}

port_pris() {
  local port="$1" ecoutes
  if command -v ss >/dev/null; then
    # Capturé PUIS filtré : sous pipefail, un filtre qui sort tôt ferait échouer le pipe.
    ecoutes="$(ss -ltnH 2>/dev/null || true)"
    if grep -Eq "[:.]${port}[[:space:]]" <<<"$ecoutes"; then return 0; fi
    return 1
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then return 0; fi
  return 1
}

# port_du_banc : écrit le port, ou rien si le projet n'en déclare pas. Rend 1 s'il est interdit.
# Avec l'option creneaux, chaque arbre de travail a le sien : c'est elle qui le dit.
port_du_banc() {
  local port interdit
  port="${HARNESS_PORT:-}"
  if [[ -z "$port" && "$(cfg .options.creneaux.actif)" == "true" && -f "$SCRIPTS/creneaux.sh" ]]; then
    port="$(bash "$SCRIPTS/creneaux.sh" port)" || return 1
  fi
  if [[ -z "$port" ]]; then port="$(cfg .execution.port)"; fi
  [[ -n "$port" ]] || return 0
  while IFS= read -r interdit; do
    if [[ -n "$interdit" && "$interdit" == "$port" ]]; then
      echo "REFUS : le port $port est dans execution.ports_interdits (il appartient à un autre service)." >&2
      return 1
    fi
  done <<<"$(cfg_lignes .execution.ports_interdits)"
  printf '%s\n' "$port"
}

# debut_noyau <pid> : l'heure de lancement du processus telle que le noyau la note. Le nom du
# programme peut contenir des espaces : on compte les champs après la parenthèse fermante.
debut_noyau() {
  sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{ print $20 }'
}

# fiche_vivante : rend 0 si le processus enregistré tourne encore ET que c'est bien le nôtre.
fiche_vivante() {
  local pid depuis
  [[ -f "$FICHE" ]] || return 1
  pid="$(jq -r '.pid' "$FICHE")"
  depuis="$(jq -r '.lance_le_noyau' "$FICHE")"
  [[ -d "/proc/$pid" ]] || return 1
  # Un PID se recycle : l'heure de lancement lue dans /proc doit être celle qu'on a notée.
  [[ "$(debut_noyau "$pid")" == "$depuis" ]]
}

# groupe_vivant <pgid> : rend 0 tant qu'il reste un processus dans le groupe.
groupe_vivant() {
  kill -0 -- "-$1" 2>/dev/null
}

exiger_preuve() {
  local nom="$1" c
  c="$(commande_json "$nom")"
  [[ -n "$c" ]] || return 0
  if ((!ESSAI)) && [[ "$(jq -r '.prouvee_le // ""' <<<"$c")" == "" ]]; then
    echo "REFUS : la commande « $nom » n'a jamais été prouvée. Faire d'abord : banc.sh essai" >&2
    exit "$CODE_REFUS"
  fi
}

# sante : rend 0 quand le banc répond.
sante() {
  local port="$1" cmd
  cmd="$(commande_json sante | jq -r '.cmd')"
  if [[ -n "$cmd" ]]; then
    # `pipefail` dans le shell lancé, qui n'hérite pas du nôtre : une santé déclarée avec un
    # pipe rendrait sinon le code de son filtre, et un banc muet serait dit prêt. Même règle
    # plus bas pour l'arrêt et la capture.
    (cd "$RACINE" && PORT="$port" timeout -k 5 30 bash -o pipefail -c "$cmd") >>"$JOURNAL_BANC.sante" 2>&1
    return $?
  fi
  # Sans commande de santé : on se contente d'un port qui écoute.
  if [[ -n "$port" ]]; then port_pris "$port"; else return 0; fi
}

demarrer() {
  local cmd port pid debut
  cmd="$(commande_json demarrer | jq -r '.cmd')"
  if [[ -z "$cmd" ]]; then
    echo "banc : ABSENT (aucune commande de démarrage déclarée, rien à lancer)"
    return 0
  fi
  exiger_preuve demarrer
  exiger_preuve sante
  garde || return 1
  if fiche_vivante; then
    echo "banc : déjà lancé (PID $(jq -r '.pid' "$FICHE"), port $(jq -r '.port // "aucun"' "$FICHE")). L'arrêter d'abord : banc.sh arreter"
    return 1
  fi
  port="$(port_du_banc)" || return 1
  if [[ -n "$port" ]] && port_pris "$port"; then
    echo "REFUS : le port $port est déjà pris, et pas par ce banc. Tester dessus, ce serait tester le code d'un autre." >&2
    return 1
  fi

  mkdir -p "$TRAVAIL"
  : >"$JOURNAL_BANC"
  : >"$JOURNAL_BANC.sante"
  # setsid : le banc a son propre groupe de processus, qu'on pourra arrêter d'un bloc.
  (cd "$RACINE" && PORT="$port" exec setsid bash -c "$cmd") >"$JOURNAL_BANC" 2>&1 &
  pid=$!
  sleep 0.3
  if [[ ! -d "/proc/$pid" ]]; then
    tail -n 30 "$JOURNAL_BANC"
    echo "banc : le démarrage a échoué tout de suite · journal : $JOURNAL_BANC" >&2
    return 1
  fi
  jq -n --argjson pid "$pid" --arg port "$port" --arg le "$(maintenant)" \
    --arg noyau "$(debut_noyau "$pid")" \
    '{pid: $pid, port: (if $port == "" then null else ($port | tonumber) end), lance_le: $le, lance_le_noyau: $noyau}' >"$FICHE"

  debut="$(date +%s)"
  while true; do
    if ! fiche_vivante; then
      tail -n 30 "$JOURNAL_BANC"
      rm -f "$FICHE"
      echo "banc : le processus s'est arrêté avant de répondre · journal : $JOURNAL_BANC" >&2
      return 1
    fi
    if sante "$port"; then break; fi
    if (($(date +%s) - debut >= ATTENTE)); then
      tail -n 30 "$JOURNAL_BANC"
      echo "banc : pas de réponse après ${ATTENTE} s · journal : $JOURNAL_BANC" >&2
      arreter >/dev/null || true
      return 1
    fi
    sleep 1
  done
  DUREE_DEMARRAGE=$(($(date +%s) - debut))
  echo "banc : lancé (PID $pid${port:+, port $port}, prêt en ${DUREE_DEMARRAGE} s) · journal : $JOURNAL_BANC"
}

arreter() {
  local cmd pid port essais=0 code=0
  cmd="$(commande_json arreter | jq -r '.cmd')"
  if [[ ! -f "$FICHE" ]]; then
    echo "banc : rien à arrêter (aucun banc lancé par ce script)"
    return 0
  fi
  pid="$(jq -r '.pid' "$FICHE")"
  port="$(jq -r '.port // ""' "$FICHE")"
  if fiche_vivante; then
    if [[ -n "$cmd" ]]; then
      (cd "$RACINE" && PORT="$port" timeout -k 5 60 bash -o pipefail -c "$cmd") >>"$JOURNAL_BANC" 2>&1 || code=$?
    fi
    # Le groupe de processus lancé par demarrer, et lui seul : jamais un arrêt par nom.
    # On suit le GROUPE, pas son chef : le chef peut mourir au premier signal pendant qu'un
    # enfant l'ignore et garde le port. Le chef vient d'être reconnu vivant, donc ce numéro de
    # groupe est le nôtre, et il ne peut pas être repris tant qu'il lui reste un membre.
    if groupe_vivant "$pid"; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
    while groupe_vivant "$pid" && ((essais < 20)); do
      sleep 0.5
      essais=$((essais + 1))
    done
    if groupe_vivant "$pid"; then
      kill -KILL -- "-$pid" 2>/dev/null || true
      sleep 0.3
    fi
  fi
  rm -f "$FICHE"
  # Le chef disparu avant cet appel, on ne sait plus reconnaître son groupe : on ne tue rien à
  # l'aveugle, mais on ne dit pas « arrêté » si le port répond encore.
  if [[ -n "$port" ]] && port_pris "$port"; then
    echo "banc : le processus lancé (PID $pid) n'est plus là, mais le port $port répond encore. Trouver qui le tient et l'arrêter par son PID exact." >&2
    return 1
  fi
  echo "banc : arrêté (PID $pid)"
  return "$code"
}

etat() {
  if fiche_vivante; then
    jq -r '"banc : lancé (PID \(.pid), port \(.port // "aucun"), depuis \(.lance_le))"' "$FICHE"
  else
    [[ ! -f "$FICHE" ]] || rm -f "$FICHE"
    echo "banc : arrêté"
  fi
}

capturer() {
  local cible="$1" sortie="$2" cmd port code=0
  cmd="$(commande_json capture | jq -r '.cmd')"
  if [[ -z "$cmd" ]]; then
    echo "REFUS : aucune commande de capture déclarée (commandes.capture). Sans rendu réel, il n'y a pas de regard client : le dire, ne pas le remplacer par la lecture d'un diff." >&2
    return 1
  fi
  exiger_preuve capture
  [[ "$sortie" == /* ]] || sortie="$RACINE/$sortie"
  mkdir -p "$(dirname "$sortie")"
  rm -f "$sortie"
  port=""
  if fiche_vivante; then port="$(jq -r '.port // ""' "$FICHE")"; fi
  (cd "$RACINE" && PORT="$port" HARNESS_CIBLE="$cible" HARNESS_SORTIE="$sortie" timeout -k 5 300 bash -o pipefail -c "$cmd") >"$TRAVAIL/capture.log" 2>&1 || code=$?
  if ((code != 0)); then
    tail -n 20 "$TRAVAIL/capture.log"
    echo "capture : ÉCHEC (exit $code)" >&2
    return 1
  fi
  # Une capture vide est un échec : un fichier absent ou vide ne montre rien à personne.
  if [[ ! -s "$sortie" ]]; then
    echo "capture : ÉCHEC, la commande a rendu 0 mais n'a rien écrit dans $sortie" >&2
    return 1
  fi
  echo "capture : $sortie ($(wc -c <"$sortie") octets, cible « $cible »)"
}

essai() {
  local code=0 debut
  ESSAI=1
  if [[ -z "$(commande_json demarrer)" ]]; then
    if [[ -z "$(commande_json capture)" ]]; then
      echo "banc : ABSENT (aucune commande de démarrage déclarée), rien à prouver"
      return 0
    fi
    # Un produit sans serveur (bibliothèque, outil) montre quand même un rendu : la capture se prouve seule.
    debut="$(date +%s)"
    capturer "${BANC_CIBLE_ESSAI:-/}" "$TRAVAIL/capture-essai" || return 1
    node "$SCRIPTS/lib/config.mjs" prouver capture --exit 0 --duree "$(($(date +%s) - debut))"
    echo "banc : aucun démarrage déclaré, capture prouvée seule"
    return 0
  fi
  DUREE_DEMARRAGE=0
  demarrer || return 1
  node "$SCRIPTS/lib/config.mjs" prouver demarrer --exit 0 --duree "$DUREE_DEMARRAGE"
  if [[ -n "$(commande_json sante)" ]]; then
    node "$SCRIPTS/lib/config.mjs" prouver sante --exit 0 --duree 0
  fi
  if [[ -n "$(commande_json capture)" ]]; then
    debut="$(date +%s)"
    if capturer "${BANC_CIBLE_ESSAI:-/}" "$TRAVAIL/capture-essai"; then
      node "$SCRIPTS/lib/config.mjs" prouver capture --exit 0 --duree "$(($(date +%s) - debut))"
    else
      code=1
    fi
  fi
  debut="$(date +%s)"
  if arreter; then
    if [[ -n "$(commande_json arreter)" ]]; then
      node "$SCRIPTS/lib/config.mjs" prouver arreter --exit 0 --duree "$(($(date +%s) - debut))"
    fi
  else
    code=1
  fi
  if ((code == 0)); then echo "banc : essai complet, preuves enregistrées"; fi
  return "$code"
}

case "${1:-}" in
  garde) garde ;;
  port) port_du_banc ;;
  demarrer) demarrer ;;
  arreter) arreter ;;
  etat) etat ;;
  capture)
    [[ $# -eq 3 ]] || usage
    capturer "$2" "$3"
    ;;
  essai) essai ;;
  *) usage ;;
esac
