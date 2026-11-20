#!/usr/bin/env bash
# commun.sh : socle des scripts shell du harness. À SOURCER, jamais à lancer.
#
# Fournit : RACINE, CONFIG, SCRIPTS, TRAVAIL, cfg, cfg_lignes, commande_json, refuser,
# maintenant, verrou. Valide la configuration une fois par chaîne d'appels.
#
# Un script qui tourne AVANT que la configuration existe (preflight de l'installateur) pose
# HARNESS_SANS_CONFIG=1 avant de sourcer.

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${HARNESS_RACINE:-}" ]]; then
  RACINE="$HARNESS_RACINE"
else
  # La racine est celle du CHECKOUT courant : un second arbre de travail a la sienne.
  RACINE="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "REFUS : pas dans un dépôt Git. Le harness se lance depuis le dépôt du projet." >&2
    exit 1
  }
fi
CONFIG="$RACINE/harness/projet.json"
# Fichiers de travail locaux (journaux, PID, verrous) : jamais commités.
TRAVAIL="$RACINE/harness/.travail"

refuser() {
  echo "REFUS : $*" >&2
  exit 1
}

# Horodatage ISO. HARNESS_DATE fige l'horloge pour les tests.
maintenant() {
  printf '%s\n' "${HARNESS_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
}

if [[ "${HARNESS_SANS_CONFIG:-}" != "1" ]]; then
  for outil in jq node; do
    command -v "$outil" >/dev/null || refuser "outil manquant : $outil (voir harness/scripts/preflight.sh)"
  done
  [[ -f "$CONFIG" ]] || refuser "configuration absente : $CONFIG. Lancer /harness-install."
  # Validée une fois par chaîne d'appels : l'empreinte suit la date et la taille du fichier,
  # une configuration modifiée entre deux appels est donc revalidée.
  empreinte_config="$(stat -c '%Y-%s' "$CONFIG")"
  if [[ "${HARNESS_CONFIG_VALIDEE:-}" != "$empreinte_config" ]]; then
    node "$SCRIPTS/lib/config.mjs" valider --silencieux || exit 1
    export HARNESS_CONFIG_VALIDEE="$empreinte_config"
  fi
  unset empreinte_config
fi

# cfg '<filtre jq>' : une valeur de la configuration. Rien pour null (false reste « false »).
cfg() {
  jq -r "$1 | if . == null then empty else . end" "$CONFIG"
}

# cfg_lignes '<filtre jq vers une liste>' : un élément par ligne.
cfg_lignes() {
  jq -r "$1 | if . == null then empty else .[] end" "$CONFIG"
}

# commande_json <nom> : l'objet commande en JSON sur une ligne, rien si elle est absente (null).
# <nom> = installer, tests, tests_longs, build, demarrer, sante, arreter, capture, statique:<nom>.
commande_json() {
  local nom="$1"
  if [[ "$nom" == statique:* ]]; then
    jq -c --arg n "${nom#statique:}" '.commandes.statique[] | select(.nom == $n)' "$CONFIG"
  else
    jq -c --arg n "$nom" '.commandes[$n] | if . == null then empty else . end' "$CONFIG"
  fi
}

# verrou <jeton> <commande...> : exclusion mutuelle entre TOUS les arbres de travail du dépôt.
# Le verrou vit dans le dossier Git commun, partagé par les arbres de travail.
verrou() {
  local jeton="$1" commun
  shift
  commun="$(git -C "$RACINE" rev-parse --git-common-dir)"
  [[ "$commun" == /* ]] || commun="$RACINE/$commun"
  command -v flock >/dev/null || refuser "outil manquant : flock"
  flock "$commun/harness-$jeton.lock" "$@"
}
