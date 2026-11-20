#!/usr/bin/env bash
# poser.sh : dépose le kit dans un projet. Il ne fait rien d'autre.
#
# Usage : bash poser.sh <dossier du projet>
#
# Ce qu'il écrit, et seulement ça :
#   <projet>/harness/.kit/                        le kit (VERSION, noyau/, options/, docs/),
#                                                 REMPLACÉ en entier à chaque dépôt
#   <projet>/.claude/commands/harness-install.md  la commande d'installation, REMPLACÉE elle aussi
#
# Il n'installe rien, ne configure rien, ne commite rien. La suite se joue dans le projet,
# avec la commande /harness-install, qui pose les questions.
#
# Codes : 0 déposé ; 1 refus ; 2 usage.
set -euo pipefail

ici="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -ne 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  echo "usage : bash poser.sh <dossier du projet>" >&2
  exit 2
fi
projet="$1"

refuser() {
  echo "REFUS : $1" >&2
  exit 1
}

for piece in VERSION kit/noyau kit/options docs kit/noyau/.claude/commands/harness-install.md; do
  [[ -e "$ici/$piece" ]] || refuser "archive incomplète : « $piece » manque à côté de poser.sh"
done
[[ -d "$projet" ]] || refuser "« $projet » n'est pas un dossier"
command -v git >/dev/null 2>&1 || refuser "git est introuvable"
racine="$(git -C "$projet" rev-parse --show-toplevel 2>/dev/null)" || refuser "« $projet » n'est pas dans un dépôt Git (le harness vit dans le dépôt du projet : git init d'abord)"

case "$racine/" in
  "$ici"/*) refuser "le projet est DANS l'archive du kit : choisir le dépôt du projet à équiper" ;;
esac

version="$(tr -d '[:space:]' < "$ici/VERSION")"
dest="$racine/harness/.kit"
ancienne=""
[[ -f "$dest/VERSION" ]] && ancienne="$(tr -d '[:space:]' < "$dest/VERSION")"

rm -rf "${dest:?}"
mkdir -p "$dest"
cp "$ici/VERSION" "$dest/VERSION"
cp -R "$ici/kit/noyau" "$dest/noyau"
cp -R "$ici/kit/options" "$dest/options"
cp -R "$ici/docs" "$dest/docs"

mkdir -p "$racine/.claude/commands"
cp "$ici/kit/noyau/.claude/commands/harness-install.md" "$racine/.claude/commands/harness-install.md"

if [[ -n "$ancienne" && "$ancienne" != "$version" ]]; then
  echo "kit $version déposé dans $dest (il remplace le kit $ancienne)"
else
  echo "kit $version déposé dans $dest"
fi
echo "commande posée : .claude/commands/harness-install.md"
echo
echo "La suite, dans le projet :"
echo "  1. ouvrir une session Claude Code dans $racine"
echo "     (une session déjà ouverte ne voit pas la nouvelle commande : la relancer)"
echo "  2. taper : /harness-install"
