#!/usr/bin/env bash
# notifier.sh : prévient l'approbateur, et garde une trace de chaque message.
#
# POURQUOI des modes nommés par leur EFFET : avec des niveaux (info, warning, critical) et un
# filtre « seul critical part », une gate humaine notifiée en « info » n'arrive jamais, et la
# story attend en silence. Ici le mode dit ce qui se passe :
#
#   notifier.sh gate   "<sujet>" "<corps>"   part TOUJOURS (une décision est attendue)
#   notifier.sh alerte "<sujet>" "<corps>"   part, sauf si la même alerte est déjà partie
#                                            dans la fenêtre notification.anti_repetition_h
#   notifier.sh journal "<sujet>" "<corps>"  n'envoie rien, écrit seulement dans le journal
#   notifier.sh test                         envoie un message d'essai (installation)
#
# L'envoi passe par `notification.commande` (configuration), qui reçoit HARNESS_SUJET,
# HARNESS_CORPS et HARNESS_NIVEAU. Le secret du canal vit dans `notification.fichier_env`,
# HORS du dépôt. Sans commande configurée : journal seul, code 0.
#
# Codes : 0 envoyé, journalisé ou déjà envoyé ; 4 ÉCHEC D'ENVOI (le message n'est pas parti) ;
#         2 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/commun.sh"

usage() {
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

mode="${1:-}"
sujet="${2:-}"
corps="${3:-}"
case "$mode" in
  gate | alerte | journal) [[ -n "$sujet" ]] || usage ;;
  test)
    sujet="Test du harness ($(cfg .projet.nom))"
    corps="Si tu lis ce message, les notifications du harness arrivent."
    ;;
  *) usage ;;
esac

JOURNAL="$(cfg .notification.journal)"
[[ "$JOURNAL" == /* ]] || JOURNAL="$RACINE/$JOURNAL"
REGISTRE="$TRAVAIL/alertes-envoyees.tsv"
mkdir -p "$(dirname "$JOURNAL")" "$TRAVAIL"

# Une ligne par message : date, mode, résultat, sujet, corps (ramené sur une ligne).
tracer() {
  local plat="${corps//$'\n'/ / }"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(maintenant)" "$mode" "$1" "${sujet//$'\t'/ }" "${plat//$'\t'/ }" >>"$JOURNAL"
}

maintenant_s() {
  if [[ -n "${HARNESS_DATE:-}" ]]; then date -u -d "$HARNESS_DATE" +%s; else date +%s; fi
}

# envoyer : rend 0 si le canal a accusé réception, 3 s'il n'y a pas de canal, 4 sur échec.
envoyer() {
  local commande fichier_env code=0 reponse="$TRAVAIL/notification-dernier-envoi.log"
  commande="$(cfg .notification.commande)"
  if [[ -z "$commande" ]]; then
    tracer "JOURNAL SEUL (aucun canal configuré)"
    echo "notification : journal seul, aucun canal configuré ($JOURNAL)"
    return 3
  fi
  fichier_env="$(cfg .notification.fichier_env)"
  fichier_env="${fichier_env/#\~/$HOME}"
  if [[ -n "$fichier_env" && ! -r "$fichier_env" ]]; then
    tracer "ECHEC ENVOI (fichier d'environnement illisible)"
    echo "ECHEC ENVOI : fichier d'environnement illisible : $fichier_env" >&2
    return 4
  fi
  # La réponse brute du canal peut répéter un jeton : elle va dans un fichier local privé,
  # jamais dans le journal.
  (
    umask 077
    : >"$reponse"
    if [[ -n "$fichier_env" ]]; then
      set -a
      # shellcheck disable=SC1090
      . "$fichier_env"
      set +a
    fi
    export HARNESS_SUJET="$sujet" HARNESS_CORPS="$corps" HARNESS_NIVEAU="$mode"
    cd "$RACINE"
    timeout -k 5 "${NOTIFIER_DELAI_S:-30}" bash -o pipefail -c "$commande" >>"$reponse" 2>&1
  ) || code=$?
  if ((code != 0)); then
    tracer "ECHEC ENVOI (code $code)"
    echo "ECHEC ENVOI : la commande de notification a rendu $code. Le message N'EST PAS parti. Réponse brute : $reponse" >&2
    return 4
  fi
  tracer "ENVOYE"
  echo "notification envoyée : $sujet"
  return 0
}

case "$mode" in
  journal)
    tracer "JOURNAL"
    ;;
  gate | test)
    code=0
    envoyer || code=$?
    if ((code == 3)); then code=0; fi
    exit "$code"
    ;;
  alerte)
    cle="$(printf '%s\n%s' "$sujet" "$corps" | sha256sum)"
    cle="${cle%% *}"
    fenetre_s="$(cfg '.notification.anti_repetition_h * 3600 | floor')"
    touch "$REGISTRE"
    # Sous verrou : deux boucles qui lèvent la même alerte au même instant n'en envoient qu'une.
    exec 9>"$TRAVAIL/alertes.verrou"
    flock 9
    dernier="$(awk -F'\t' -v c="$cle" '$1 == c { d = $2 } END { print d + 0 }' "$REGISTRE")"
    present="$(maintenant_s)"
    if ((dernier > 0 && present - dernier < fenetre_s)); then
      tracer "DEJA ENVOYEE (fenêtre anti-répétition)"
      echo "alerte déjà envoyée il y a $(((present - dernier) / 60)) min : non répétée"
      exit 0
    fi
    code=0
    envoyer || code=$?
    # L'horodatage ne s'écrit qu'APRÈS un envoi accusé : un échec ne doit pas faire taire la
    # tentative suivante.
    if ((code == 0)); then printf '%s\t%s\n' "$cle" "$present" >>"$REGISTRE"; fi
    if ((code == 3)); then code=0; fi
    exit "$code"
    ;;
esac
