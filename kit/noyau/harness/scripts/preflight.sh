#!/usr/bin/env bash
# preflight.sh : la machine a-t-elle ce qu'il faut pour faire tourner le harness ?
#
# POURQUOI : un outil manquant découvert au milieu d'une passe coûte la passe. Un relecteur non
# authentifié rend une sortie vide, et une sortie vide ressemble à « aucun défaut ».
#
# Usage :
#   preflight.sh                  contrôle complet (configuration comprise)
#   preflight.sh --installation   avant que la configuration existe (lancé par /harness-install)
#   preflight.sh --sans-relecteur ne contrôle pas le CLI du relecteur
#
# Codes : 0 tout est là ; 1 il manque quelque chose d'obligatoire ; 2 usage.
set -uo pipefail

installation=0
sans_relecteur=0
for arg in "$@"; do
  case "$arg" in
    --installation) installation=1 ;;
    --sans-relecteur) sans_relecteur=1 ;;
    *)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
      exit 2
      ;;
  esac
done

manques=0
ok() { printf '  OK      %s\n' "$*"; }
note() { printf '  NOTE    %s\n' "$*"; }
manque() {
  printf '  MANQUE  %s\n' "$*"
  manques=$((manques + 1))
}

echo "Outils"
if ((BASH_VERSINFO[0] >= 4)); then ok "bash ${BASH_VERSION%%(*}"; else manque "bash 4 ou plus (ici ${BASH_VERSION})"; fi
for outil in git jq flock timeout setsid sha256sum awk sed; do
  if command -v "$outil" >/dev/null; then ok "$outil"; else manque "$outil"; fi
done
if command -v node >/dev/null; then
  majeure="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if ((majeure >= 18)); then ok "node $(node --version)"; else manque "node 18 ou plus (ici $(node --version))"; fi
else
  manque "node 18 ou plus (outil du harness, même si le projet n'a pas de JavaScript)"
fi

echo "Dépôt"
if racine="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  ok "dépôt Git : $racine"
  # Le kit que poser.sh vient de déposer n'est pas une modification du projet.
  if [[ -n "$(git -C "$racine" status --porcelain -- . ':(exclude)harness/.kit' ':(exclude).claude/commands/harness-install.md' 2>/dev/null)" ]]; then
    note "l'arbre de travail a des modifications non commitées"
  fi
else
  manque "un dépôt Git (le harness se lance depuis le dépôt du projet)"
  racine=""
fi

forge=""
config="${HARNESS_RACINE:-$racine}/harness/projet.json"
if ((!installation)); then
  echo "Configuration"
  if [[ -f "$config" ]] && command -v node >/dev/null; then
    if HARNESS_RACINE="${HARNESS_RACINE:-$racine}" node "$(dirname "${BASH_SOURCE[0]}")/lib/config.mjs" valider --silencieux; then
      ok "harness/projet.json valide"
      forge="$(jq -r '.git.forge' "$config")"
      distant="$(jq -r '.git.remote' "$config")"
      if [[ -n "$racine" ]] && ! git -C "$racine" remote get-url "$distant" >/dev/null 2>&1; then
        note "le dépôt distant « $distant » n'existe pas : tout se fait en local, rien n'est poussé"
      fi
      if [[ "$(jq -r '.relecteur.accord_envoi_externe' "$config")" != "true" ]]; then
        note "relecteur.accord_envoi_externe est à false : les scripts de relecture refuseront de partir"
      fi
      non_prouvees="$(jq -r '[.commandes | to_entries[] | select(.key != "statique" and .value != null and .value.prouvee_le == null) | .key] + [.commandes.statique[] | select(.prouvee_le == null) | "statique:" + .nom] | join(", ")' "$config")"
      if [[ -n "$non_prouvees" ]]; then note "commandes jamais prouvées : $non_prouvees"; fi
    else
      manque "harness/projet.json invalide (détail ci-dessus)"
    fi
  else
    manque "harness/projet.json (lancer /harness-install)"
  fi
elif [[ -n "$racine" ]]; then
  # À l'installation la forge n'est pas encore déclarée : on la devine à l'adresse du dépôt.
  if git -C "$racine" remote -v 2>/dev/null | grep -q 'github\.com'; then forge="github"; fi
fi

echo "Forge"
if [[ "$forge" == "github" ]]; then
  if command -v gh >/dev/null; then
    if gh auth status >/dev/null 2>&1; then ok "gh authentifié"; else manque "gh n'est pas authentifié (gh auth login)"; fi
  else
    manque "gh (le CLI GitHub, nécessaire pour ouvrir les PR)"
  fi
else
  note "forge « ${forge:-non déclarée} » : les PR s'ouvrent à la main, le harness donne le texte"
fi

echo "Relecteur"
if ((sans_relecteur)); then
  note "contrôle du relecteur sauté (--sans-relecteur)"
elif command -v codex >/dev/null; then
  ok "codex $(codex --version 2>/dev/null | head -n 1)"
  if timeout -k 5 30 codex login status >/dev/null 2>&1; then
    ok "codex authentifié"
  else
    manque "codex n'est pas authentifié (codex login) : un relecteur muet ressemble à une review propre"
  fi
else
  manque "codex (le CLI du relecteur)"
fi

echo
if ((manques > 0)); then
  echo "preflight : $manques manque(s). Rien ne démarre tant que ce n'est pas réglé."
  exit 1
fi
echo "preflight : tout est là."
