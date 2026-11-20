#!/usr/bin/env bash
# mistral-commun.sh : socle des relecteurs de l'option mistral. À SOURCER, jamais à lancer.
#
# L'option ajoute un SECOND service externe, Mistral, appelé par son CLI `vibe`, pour trois
# gestes : la relecture SÉCURITÉ de PR (mistral-securite.sh), l'arbitre d'un finding contesté
# (mistral-arbitrer.sh) et la tranche finale d'un désaccord qui dure (mistral-trancher.sh). Ce
# fichier est le SEUL endroit qui appelle `vibe`, et chaque appel nomme ses outils
# (`--enabled-tools`) : verifier-kit.sh le contrôle.
#
# Il s'appuie sur codex-common.sh du noyau pour ce qui est commun à tous les relecteurs : la
# configuration, le verrou des relecteurs, l'empreinte du dépôt, la base à comparer, les chemins
# exclus, les consignes de langue et de style. Les codes rendus sont les mêmes :
#   0 succès ; 1 échec (rien n'est écrit) ; 5 le relecteur a modifié le dépôt ; 64 usage.
#
# LECTURE SEULE, sur trois niveaux, du plus fort au plus faible :
#   1. CONSTRUCTION : la session ne contient que read_file et grep (profil
#      harness/vibe/agents/relecteur.toml et --enabled-tools). La tranche finale n'a AUCUN outil.
#   2. SECRETS : le profil interdit la lecture des fichiers de secrets aux deux outils, avec la
#      même liste. Le préflight refuse un profil qui ouvrirait davantage (lib/profil-vibe.mjs).
#   3. CONTRÔLE après coup : empreinte du dépôt avant et après. Si elle a bougé, la sortie est
#      écartée, le script rend 5, et RIEN n'est annulé : une remise à zéro lancée « pour
#      réparer » détruirait aussi le travail en cours de quelqu'un d'autre. Jamais en parallèle
#      d'un codeur ni d'un autre relecteur dans le même arbre de travail : chaque script prend le
#      verrou des relecteurs (relecteur_sous_verrou, dans codex-common.sh).
#
# CHOIX DU MODÈLE SANS TOUCHER ~/.vibe. Vibe lit toute variable VIBE_<CHAMP> avant son fichier
# de réglages (constaté sur vibe 2.13) : on pose VIBE_MODELS (la liste, réduite au modèle voulu)
# et VIBE_ACTIVE_MODEL pour CETTE invocation seulement, et VIBE_AGENT_PATHS trouve le profil du
# kit. Rien n'est exporté dans le shell appelant, rien n'est écrit dans ~/.vibe. La clé reste
# celle que vibe lit lui-même (~/.vibe/.env, ou MISTRAL_API_KEY) : elle n'est jamais affichée.
. "$(dirname "${BASH_SOURCE[0]}")/codex-common.sh"

# --- Valeurs : options.mistral de harness/projet.json, surchargeables par l'environnement -------
# La surcharge sert aux essais et aux reprises exceptionnelles ; la valeur de référence reste
# celle de la configuration.
mistral_cfg() {
  cfg ".options.mistral.$1"
}
MISTRAL_REVIEW_MODEL="${MISTRAL_REVIEW_MODEL:-$(mistral_cfg modeles.relecture)}"
# Tranche finale : un AUTRE modèle que l'arbitre, pour que les deux derniers étages de l'échelle
# ne rendent pas le même avis.
MISTRAL_SIMPLIFY_MODEL="${MISTRAL_SIMPLIFY_MODEL:-$(mistral_cfg modeles.tranche)}"
# Prix catalogue (USD par million de jetons). Vibe s'en sert pour --max-price : un prix nul
# rendrait le plafond de coût INERTE, d'où le minimum du schéma de configuration.
MISTRAL_INPUT_PRICE="${MISTRAL_INPUT_PRICE:-$(mistral_cfg prix.relecture.entree)}"
MISTRAL_OUTPUT_PRICE="${MISTRAL_OUTPUT_PRICE:-$(mistral_cfg prix.relecture.sortie)}"
MISTRAL_SIMPLIFY_INPUT_PRICE="${MISTRAL_SIMPLIFY_INPUT_PRICE:-$(mistral_cfg prix.tranche.entree)}"
MISTRAL_SIMPLIFY_OUTPUT_PRICE="${MISTRAL_SIMPLIFY_OUTPUT_PRICE:-$(mistral_cfg prix.tranche.sortie)}"
MISTRAL_TEMPERATURE="${MISTRAL_TEMPERATURE:-$(mistral_cfg temperature)}"
# Plafonds PAR SESSION vibe (une session = un lot de diff, ou un arbitrage).
MISTRAL_MAX_PRICE="${MISTRAL_MAX_PRICE:-$(mistral_cfg plafonds.prix_session_usd)}"
MISTRAL_MAX_TURNS="${MISTRAL_MAX_TURNS:-$(mistral_cfg plafonds.tours_session)}"
MISTRAL_TIMEOUT="${MISTRAL_TIMEOUT:-$(mistral_cfg plafonds.delai_session_s)}"
# Délai d'UN appel HTTP au modèle. Le défaut du CLI a coupé des appels sur de gros contextes.
MISTRAL_API_TIMEOUT="${MISTRAL_API_TIMEOUT:-$(mistral_cfg plafonds.delai_appel_s)}"
# Plafond GLOBAL d'une relecture découpée : elle refuse de démarrer si
# lots x prix de session x essais le dépasse. On ne découvre pas le coût après coup. C'est un
# PLAFOND, pas une estimation : le coût réel est écrit dans l'artefact.
MISTRAL_BUDGET_REVUE="${MISTRAL_BUDGET_REVUE:-$(mistral_cfg plafonds.budget_revue_usd)}"
# Essais par session : un nouvel essai sur un échec TRANSITOIRE seulement (mistral_appeler).
MISTRAL_ESSAIS="${MISTRAL_ESSAIS:-$(mistral_cfg plafonds.essais)}"
# Lots relus en parallèle. Des relecteurs en parallèle ENTRE EUX ne se gênent pas : ils lisent.
MISTRAL_PARALLELE="${MISTRAL_PARALLELE:-$(mistral_cfg plafonds.parallele)}"
# Taille d'un lot (octets). Des lots plus petits font des appels plus courts, coupés moins
# souvent par le réseau, et des nouveaux essais moins chers.
MISTRAL_LOT_MAX_BYTES="${MISTRAL_LOT_MAX_BYTES:-$(mistral_cfg plafonds.taille_lot_octets)}"
MISTRAL_TRANCHE_MAX_PRICE="${MISTRAL_TRANCHE_MAX_PRICE:-$(mistral_cfg plafonds.prix_tranche_usd)}"
MISTRAL_TRANCHE_MAX_TURNS="${MISTRAL_TRANCHE_MAX_TURNS:-$(mistral_cfg plafonds.tours_tranche)}"
MISTRAL_TRANCHE_TIMEOUT="${MISTRAL_TRANCHE_TIMEOUT:-$(mistral_cfg plafonds.delai_tranche_s)}"
# Taille du prompt complet, en octets. Le prompt est passé comme ARGUMENT UNIQUE de `vibe -p`,
# et Linux borne un argument seul à 131072 octets. Vibe accepte un prompt sur l'entrée standard,
# mais il le jette sans terminal : inutilisable en tâche de fond. D'où les lots, et ce refus :
# un prompt trop gros n'est JAMAIS tronqué (une relecture ou une décision sur un contexte amputé
# est pire qu'un échec).
MISTRAL_PROMPT_MAX_OCTETS="${MISTRAL_PROMPT_MAX_OCTETS:-125000}"

MISTRAL_AGENT="relecteur"
# Le profil LIVRÉ (lecture seule, secrets interdits) et le profil EFFECTIF d'une session : le livré
# plus les chemins exclus du projet (relecteur.chemins_exclus), écrit à chaque préparation dans le
# dossier de travail (jetable, ignoré par Git). C'est l'effectif que vibe charge.
MISTRAL_PROFIL="$(cd "$SCRIPTS/.." && pwd)/vibe/agents/$MISTRAL_AGENT.toml"
MISTRAL_TRAVAIL="$TRAVAIL/mistral"
MISTRAL_AGENT_DIR="$MISTRAL_TRAVAIL/vibe-agents"
MISTRAL_PROFIL_EFFECTIF="$MISTRAL_AGENT_DIR/$MISTRAL_AGENT.toml"
# Le profil SANS OUTIL (tranche, appel du préflight) : contrôlé, puis recopié à côté de l'effectif.
MISTRAL_AGENT_SANS_OUTILS="sans-outils"
MISTRAL_PROFIL_SANS_OUTILS="$(cd "$SCRIPTS/.." && pwd)/vibe/agents/$MISTRAL_AGENT_SANS_OUTILS.toml"
# Version minimale de vibe : celle sur laquelle les variables VIBE_* et le profil ont été vérifiés.
MISTRAL_VIBE_MIN="2.13"

# Consigne d'outils commune aux relecteurs qui en ont. Sans borne, une session a fait vingt et
# une lectures et renvoyé tout son historique à chaque tour, pour cinq fois le coût d'un lot
# voisin qui en avait fait quatre. Le lot est la source ; les outils servent à VÉRIFIER.
MISTRAL_CONSIGNE_OUTILS="OUTILS (lecture seule) : le texte ci-dessous est ta source principale. Les outils read_file et grep servent à VÉRIFIER un point précis (un appelant, une configuration, un contrôle fait ailleurs), pas à relire le dépôt : au plus six appels d'outil au total, des plages ciblées (read_file avec offset et limit de deux cents lignes au plus), jamais un fichier entier de plus de trois cents lignes. Rends ta réponse avant d'épuiser ce budget."

# --- Préparation : rien ne part sans tout ceci ----------------------------------------------------

# mistral_modele_valide <nom> : le nom part dans du JSON (VIBE_MODELS) : on n'accepte que des
# caractères sans effet de syntaxe, plutôt que d'échapper.
mistral_modele_valide() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "ERREUR : nom de modèle Mistral invalide : « ${1:-} » (attendu [A-Za-z0-9._-]+)." >&2
    return 1
  }
}

# mistral_nombre <nom de variable> : la variable porte un nombre strictement positif.
mistral_nombre() {
  local v="${!1:-}"
  [[ "$v" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v x="$v" 'BEGIN { exit !(x > 0) }' || {
    echo "ERREUR : $1 doit être un nombre strictement positif (lu : « $v »)." >&2
    return 1
  }
}

# mistral_entier <nom de variable> : la variable porte un entier strictement positif.
mistral_entier() {
  [[ "${!1:-}" =~ ^[1-9][0-9]*$ ]] || {
    echo "ERREUR : $1 doit être un entier strictement positif (lu : « ${!1:-} »)." >&2
    return 1
  }
}

# mistral_version_ok : vibe est-il au moins en MISTRAL_VIBE_MIN ? On le lance pour le savoir.
mistral_version_ok() {
  local sortie version
  sortie="$(timeout -k 5 30 vibe --version 2>/dev/null | head -n 1)" || true
  version="$(printf '%s' "$sortie" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1)"
  [[ -n "$version" ]] || {
    echo "ERREUR : vibe --version ne rend pas de version lisible (« $sortie »)." >&2
    return 1
  }
  awk -v v="$version" -v m="$MISTRAL_VIBE_MIN" 'BEGIN {
    split(v, a, "."); split(m, b, ".");
    exit !((a[1] + 0 > b[1] + 0) || (a[1] + 0 == b[1] + 0 && a[2] + 0 >= b[2] + 0))
  }' || {
    echo "ERREUR : vibe $version est trop ancien : il faut $MISTRAL_VIBE_MIN ou plus (les variables VIBE_* et le profil n'ont été vérifiés qu'à partir de là)." >&2
    return 1
  }
  printf '%s\n' "$version"
}

# mistral_cle_presente : la clé est-elle là ? On teste sa PRÉSENCE, sans jamais l'afficher.
mistral_cle_presente() {
  local envf="${VIBE_HOME:-$HOME/.vibe}/.env"
  [[ -n "${MISTRAL_API_KEY:-}" ]] && return 0
  grep -qE '^[[:space:]]*(export[[:space:]]+)?MISTRAL_API_KEY[[:space:]]*=[[:space:]]*["'\'']?[^[:space:]"'\'']' "$envf" 2>/dev/null
}

# mistral_preparer : à appeler avant tout appel. Refuse (code 1) sans option active, sans accord
# d'envoi, sans CLI assez récent, sans clé, avec un profil qui ouvrirait davantage que la lecture,
# ou avec une valeur de configuration inexploitable. Tout est contrôlé AVANT le premier appel.
mistral_preparer() {
  [[ "$(cfg '.options.mistral.actif // false')" == "true" ]] || refuser \
    "l'option mistral n'est pas active (options.mistral.actif dans harness/projet.json)."
  [[ "$(cfg '.options.mistral.accord_envoi_externe // false')" == "true" ]] || refuser \
    "options.mistral.accord_envoi_externe est à false dans harness/projet.json. Ces relecteurs envoient le diff et des extraits du dépôt à Mistral, un AUTRE service que le relecteur de code : c'est à $(cfg .projet.approbateur) de l'accepter, et l'accord donné au relecteur de code ne vaut pas pour lui."
  local m v
  for m in "$MISTRAL_REVIEW_MODEL" "$MISTRAL_SIMPLIFY_MODEL"; do
    mistral_modele_valide "$m" || exit 1
  done
  for v in MISTRAL_INPUT_PRICE MISTRAL_OUTPUT_PRICE MISTRAL_SIMPLIFY_INPUT_PRICE MISTRAL_SIMPLIFY_OUTPUT_PRICE \
    MISTRAL_MAX_PRICE MISTRAL_BUDGET_REVUE MISTRAL_TRANCHE_MAX_PRICE; do
    mistral_nombre "$v" || exit 1
  done
  for v in MISTRAL_MAX_TURNS MISTRAL_TIMEOUT MISTRAL_API_TIMEOUT MISTRAL_ESSAIS MISTRAL_PARALLELE \
    MISTRAL_LOT_MAX_BYTES MISTRAL_TRANCHE_MAX_TURNS MISTRAL_TRANCHE_TIMEOUT MISTRAL_PROMPT_MAX_OCTETS; do
    mistral_entier "$v" || exit 1
  done
  [[ "$MISTRAL_TEMPERATURE" =~ ^[0-9]+([.][0-9]+)?$ ]] || refuser "MISTRAL_TEMPERATURE illisible (« $MISTRAL_TEMPERATURE »)."
  command -v realpath >/dev/null || refuser "outil manquant : realpath (coreutils), il canonise les chemins d'un finding."
  command -v vibe >/dev/null || refuser "CLI de Mistral introuvable (vibe). L'installer, puis : vibe --setup"
  # ripgrep EXIGÉ, dans le PATH que vibe héritera : vibe 2.13 choisit son moteur de recherche par
  # shutil.which("rg") (core/tools/builtins/grep.py) et retombe sinon sur GNU grep, dont --exclude
  # ne porte que sur le nom de base : « private/data.json » ne serait plus exclu du parcours.
  command -v rg >/dev/null || refuser \
    "ripgrep (rg) introuvable dans le PATH : sans lui, l'outil grep de vibe retombe sur GNU grep et ne sait plus exclure un dossier interdit. Installer ripgrep."
  MISTRAL_VIBE_VERSION="$(mistral_version_ok)" || exit 1
  mistral_cle_presente || refuser \
    "clé Mistral absente (ni MISTRAL_API_KEY dans l'environnement, ni dans ${VIBE_HOME:-$HOME/.vibe}/.env). La poser avec : vibe --setup"
  [[ -f "$MISTRAL_PROFIL" ]] || refuser "profil du relecteur absent : $MISTRAL_PROFIL (l'option mistral est-elle posée ?)"
  node "$SCRIPTS/lib/profil-vibe.mjs" "$MISTRAL_PROFIL" || refuser \
    "le profil $MISTRAL_PROFIL ouvre davantage que la lecture (motifs ci-dessus). Refus avant tout appel."
  mkdir -p "$MISTRAL_TRAVAIL"
  # Le profil effectif : les chemins exclus du projet deviennent des interdits des DEUX outils, pas
  # seulement une consigne du prompt. Contrôlé avec les mêmes règles que le livré, plus la présence
  # de chaque exclusion ; rien n'est posé si le contrôle échoue.
  local motifs=()
  while IFS= read -r m; do [[ -n "$m" ]] && motifs+=("$m"); done < <(cfg_lignes .relecteur.chemins_exclus)
  MISTRAL_MOTIFS_EXCLUS=("${motifs[@]}")
  rm -f "$MISTRAL_PROFIL_EFFECTIF"
  node "$SCRIPTS/lib/profil-vibe.mjs" --effectif "$MISTRAL_PROFIL" "$(realpath -m -- "$RACINE")" "$MISTRAL_PROFIL_EFFECTIF" "${motifs[@]}" || refuser \
    "le profil effectif ($MISTRAL_PROFIL_EFFECTIF) n'a pas pu porter les chemins exclus du projet (motifs ci-dessus). Refus avant tout appel."
  rm -f "$MISTRAL_AGENT_DIR/$MISTRAL_AGENT_SANS_OUTILS.toml"
  [[ -f "$MISTRAL_PROFIL_SANS_OUTILS" ]] || refuser "profil sans outil absent : $MISTRAL_PROFIL_SANS_OUTILS (l'option mistral est-elle posée ?)"
  node "$SCRIPTS/lib/profil-vibe.mjs" --sans-outils "$MISTRAL_PROFIL_SANS_OUTILS" || refuser \
    "le profil sans outil $MISTRAL_PROFIL_SANS_OUTILS rouvrirait un outil ou du contexte (motifs ci-dessus). Refus avant tout appel."
  cp "$MISTRAL_PROFIL_SANS_OUTILS" "$MISTRAL_AGENT_DIR/$MISTRAL_AGENT_SANS_OUTILS.toml"
}

# --- Appels ---------------------------------------------------------------------------------------

# mistral_env <modèle> <dossier des sessions> <prix entrée> <prix sortie> : une affectation par
# ligne, lue par `env` pour CETTE invocation.
mistral_env() {
  local modele="$1" sessions="$2" prix_e="$3" prix_s="$4"
  mistral_modele_valide "$modele" || return 1
  printf 'VIBE_MODELS=[{"name":"%s","provider":"mistral","alias":"%s","temperature":%s,"input_price":%s,"output_price":%s,"thinking":"off"}]\n' \
    "$modele" "$modele" "$MISTRAL_TEMPERATURE" "$prix_e" "$prix_s"
  printf 'VIBE_ACTIVE_MODEL=%s\n' "$modele"
  printf 'VIBE_AGENT_PATHS=["%s"]\n' "$MISTRAL_AGENT_DIR"
  # Journal de session PAR APPEL (le coût réel s'y lit, cf. mistral_cout), hors du journal
  # de l'utilisateur.
  printf 'VIBE_SESSION_LOGGING={"save_dir":"%s","session_prefix":"mistral","enabled":true}\n' "$sessions"
  printf 'VIBE_ENABLE_UPDATE_CHECKS=false\nVIBE_ENABLE_AUTO_UPDATE=false\n'
  printf 'VIBE_API_TIMEOUT=%s\n' "$MISTRAL_API_TIMEOUT"
  # Seconde couche, quel que soit le profil : rien n'entre d'office dans le prompt système (contexte
  # du dépôt, AGENTS.md de l'utilisateur et du projet, compétences, prompt personnel).
  printf 'VIBE_INCLUDE_PROJECT_CONTEXT=false\nVIBE_INCLUDE_PROMPT_DETAIL=false\nVIBE_SYSTEM_PROMPT_ID=cli\n'
}

# mistral_echec_definitif <journal> : vrai si l'échec ne se corrige pas en relançant (plafond de
# coût ou de tours atteint, authentification refusée, clé absente). Lu sur les DERNIÈRES lignes
# seulement, le message final du CLI, jamais sur le contenu relu.
mistral_echec_definitif() {
  tail -n 25 "$1" 2>/dev/null | grep -qiE "price limit|max-price|turn limit|max.?turns|token limit|unauthorized|401|403|missing [a-z_]*api_key|not authenticated"
}

# mistral_diagnostic <code> <journal> : pourquoi l'appel a échoué, sans confondre le contenu relu
# avec un diagnostic : le code de sortie d'abord, puis les dernières lignes du journal seulement.
mistral_diagnostic() {
  local rc="$1" log="$2" fin
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
    echo "ERREUR : Mistral a dépassé le délai de session. Relever options.mistral.plafonds, ou découper la story. Journal : $log" >&2
    return 0
  fi
  fin="$(tail -n 25 "$log" 2>/dev/null)"
  if printf '%s' "$fin" | grep -qiE "unauthorized|not authenticated|401|403|missing [a-z_]*api_key"; then
    echo "ERREUR : clé Mistral refusée ou absente. La reposer avec : vibe --setup" >&2
  elif printf '%s' "$fin" | grep -qiE "price limit|max-price|turn limit|max.?turns|token limit"; then
    echo "ERREUR : plafond de session atteint (coût ou tours). Rien n'a été relancé : relancer paierait deux fois la même impasse. Journal : $log" >&2
  elif printf '%s' "$fin" | grep -qiE "rate limit|429|quota"; then
    echo "ERREUR : limite de débit ou de quota de Mistral. Réessayer plus tard. Journal : $log" >&2
  else
    echo "ERREUR : Mistral a échoué (code $rc). Journal : $log" >&2
  fi
}

# mistral_appeler <lecture|aucun> <prompt> <sortie> <modèle> <plafond USD> <prix entrée>
#                 <prix sortie> <tours> <délai s>
# UNE session vibe, sans contrôle d'empreinte (l'appelant l'encadre : mistral_appel_isole pour
# un appel seul, mistral_lots pour un lot de sessions). `lecture` : profil du relecteur,
# read_file et grep seulement. `aucun` : aucun outil, la réponse se fait sur le prompt seul.
# Rend 0 (sortie non vide écrite) ou 1.
mistral_appeler() {
  local mode="$1" prompt="$2" sortie="$3" modele="$4" plafond="$5" prix_e="$6" prix_s="$7" tours="$8" delai="$9"
  local rc=0 envs=() ligne essai=1
  if [[ "$(printf '%s' "$prompt" | wc -c)" -gt "$MISTRAL_PROMPT_MAX_OCTETS" ]]; then
    echo "ERREUR : prompt Mistral trop volumineux (plus de $MISTRAL_PROMPT_MAX_OCTETS octets) : refus plutôt que troncature. Baisser options.mistral.plafonds.taille_lot_octets, ou réduire le finding à un fichier plus petit." >&2
    return 1
  fi
  while IFS= read -r ligne; do envs+=("$ligne"); done < <(mistral_env "$modele" "$sortie.sessions" "$prix_e" "$prix_s")
  ((${#envs[@]} > 0)) || return 1
  rm -rf "${sortie:?}.sessions"
  # NOUVEL ESSAI sur un échec TRANSITOIRE seulement : un hoquet réseau sur un lot parmi d'autres
  # faisait échouer toute la relecture (fail-closed, comme voulu, mais pour rien). On ne relance
  # JAMAIS un plafond atteint (relancer paierait deux fois la même impasse), ni un délai dépassé,
  # ni un refus d'authentification. Les journaux de session des essais s'additionnent :
  # mistral_cout rend le coût RÉEL, essais compris.
  while :; do
    rc=0
    case "$mode" in
      lecture)
        env "${envs[@]}" timeout -k 10 "$delai" vibe -p "$prompt" \
          --agent "$MISTRAL_AGENT" \
          --enabled-tools read_file --enabled-tools grep \
          --workdir "$RACINE" \
          --output text \
          --max-turns "$tours" \
          --max-price "$plafond" \
          > "$sortie" 2> "$sortie.log" < /dev/null || rc=$?
        ;;
      aucun)
        # 're:^$' ne désigne aucun nom d'outil : en mode programmatique, tous les autres sont
        # coupés. Profil DÉDIÉ sans outil : sans lui, vibe reprendrait ses réglages par défaut et
        # chargerait d'office les AGENTS.md et l'état Git dans le prompt système.
        env "${envs[@]}" timeout -k 10 "$delai" vibe -p "$prompt" \
          --agent "$MISTRAL_AGENT_SANS_OUTILS" \
          --enabled-tools 're:^$' \
          --workdir "$RACINE" \
          --output text \
          --max-turns "$tours" \
          --max-price "$plafond" \
          > "$sortie" 2> "$sortie.log" < /dev/null || rc=$?
        ;;
      *)
        echo "ERREUR : mode d'appel inconnu : $mode" >&2
        return 1
        ;;
    esac
    [[ "$rc" -eq 0 && -s "$sortie" ]] && return 0
    if [[ "$essai" -ge "$MISTRAL_ESSAIS" || "$rc" -eq 124 || "$rc" -eq 137 ]] || mistral_echec_definitif "$sortie.log"; then
      break
    fi
    echo "AVERTISSEMENT : Mistral a échoué (code $rc, essai $essai sur $MISTRAL_ESSAIS), nouvel essai." >&2
    cp "$sortie.log" "$sortie.log.essai-$essai" 2>/dev/null || true
    essai=$((essai + 1))
  done
  if [[ "$rc" -ne 0 ]]; then
    mistral_diagnostic "$rc" "$sortie.log"
    return 1
  fi
  echo "ERREUR : Mistral a rendu une sortie VIDE avec un code 0. Ce n'est pas une relecture propre : rien n'est écrit. Journal : $sortie.log" >&2
  return 1
}

# mistral_appel_isole <mode> <prompt> <sortie> ... : un appel seul, encadré par le contrôle
# d'empreinte. Rend 0, 1, ou 5 (le relecteur a écrit : sa sortie est écartée, rien n'est annulé).
mistral_appel_isole() {
  local avant apres rc=0
  avant="$(depot_empreinte)"
  mistral_appeler "$@" || rc=1
  apres="$(depot_empreinte)"
  if [[ "$avant" != "$apres" ]]; then
    relecteur_a_ecrit
    return "$CODE_RELECTEUR_A_ECRIT"
  fi
  return "$rc"
}

# mistral_decouper <diff> <dossier> [--exclure <motif>]... : écrit les lots (decouper-diff.mjs).
# L'empreinte de l'instantané relu (commit et état de l'arbre) lie les réponses gardées pour une
# reprise : le relecteur lit hors du lot, une réponse obtenue sur un autre état ne vaut plus.
mistral_decouper() {
  local diff="$1" dossier="$2" reprise=()
  shift 2
  [[ "${MISTRAL_REPRISE:-0}" == "1" ]] && reprise=(--reprise)
  node "$SCRIPTS/decouper-diff.mjs" --diff "$diff" --sortie "$dossier" --max "$MISTRAL_LOT_MAX_BYTES" \
    --empreinte "$(git -C "$RACINE" rev-parse HEAD) $(depot_empreinte)" "${reprise[@]}" "$@" >&2
}

# mistral_lots <dossier> <fabrique> : relit chaque lot de <dossier>/index.json dans une session
# distincte, MISTRAL_PARALLELE à la fois. <fabrique> est le nom d'une fonction appelée avec
# (<chemin du lot> <rang> <total> <fichiers>) qui écrit le prompt sur sa sortie. La réponse de
# chaque lot va dans <chemin>.raw, et un lot réussi laisse <chemin>.ok.
# Rend 0 si TOUS les lots ont une réponse ; 1 si un seul manque (une relecture à laquelle manque
# un lot n'est pas une relecture : jamais de vert partiel) ou si le budget global serait dépassé
# (refus AVANT tout appel) ; 5 si le dépôt a bougé pendant les sessions.
mistral_lots() {
  local dossier="$1" fabrique="$2" index="$1/index.json"
  local total a_faire=0 j plafond
  total="$(jq '.lots | length' "$index")"
  if [[ "$total" -eq 0 ]]; then
    echo "ERREUR : aucun lot à relire dans $index." >&2
    return 1
  fi
  # REPRISE (MISTRAL_REPRISE=1) : un lot dont la réponse a déjà été obtenue sur un texte IDENTIQUE
  # n'est pas relancé. Sans elle, un seul lot en échec sur une longue relecture faisait repayer
  # tous les autres.
  for ((j = 0; j < total; j++)); do
    if [[ "${MISTRAL_REPRISE:-0}" == "1" && -f "$(jq -r ".lots[$j].chemin" "$index").ok" ]]; then continue; fi
    a_faire=$((a_faire + 1))
  done
  # Plafond = lots x prix de session x essais permis : un nouvel essai ouvre une session de plus,
  # avec son propre plafond. Il se budgète donc AVANT de démarrer, pas après.
  plafond="$(awk -v n="$a_faire" -v p="$MISTRAL_MAX_PRICE" -v e="$MISTRAL_ESSAIS" 'BEGIN { printf "%.2f", n * p * e }')"
  if awk -v a="$plafond" -v b="$MISTRAL_BUDGET_REVUE" 'BEGIN { exit !(a > b) }'; then
    echo "ERREUR : $a_faire lot(s) x $MISTRAL_MAX_PRICE USD x $MISTRAL_ESSAIS essai(s) = $plafond USD, au-dessus du budget de relecture ($MISTRAL_BUDGET_REVUE USD). Aucun appel n'est parti. Relever options.mistral.plafonds.budget_revue_usd en le décidant, ou découper la story." >&2
    return 1
  fi
  echo "mistral : $total lot(s), plafond $plafond USD, $MISTRAL_PARALLELE en parallèle, modèle $MISTRAL_REVIEW_MODEL." >&2
  local avant apres i chemin fichiers echecs=0 actifs=0
  avant="$(depot_empreinte)"
  for ((i = 0; i < total; i++)); do
    chemin="$(jq -r ".lots[$i].chemin" "$index")"
    fichiers="$(jq -r ".lots[$i].fichiers | join(\", \")" "$index")"
    if [[ "${MISTRAL_REPRISE:-0}" == "1" && -f "$chemin.ok" ]]; then
      echo "mistral : lot $((i + 1)) sur $total repris (réponse déjà obtenue sur un texte identique)." >&2
      continue
    fi
    rm -f "$chemin.raw" "$chemin.ok"
    (
      p="$("$fabrique" "$chemin" "$((i + 1))" "$total" "$fichiers")" || exit 1
      mistral_appeler lecture "$p" "$chemin.raw" "$MISTRAL_REVIEW_MODEL" "$MISTRAL_MAX_PRICE" \
        "$MISTRAL_INPUT_PRICE" "$MISTRAL_OUTPUT_PRICE" "$MISTRAL_MAX_TURNS" "$MISTRAL_TIMEOUT" && : > "$chemin.ok"
    ) &
    actifs=$((actifs + 1))
    if [[ "$actifs" -ge "$MISTRAL_PARALLELE" ]]; then
      wait -n || true
      actifs=$((actifs - 1))
    fi
  done
  wait || true
  apres="$(depot_empreinte)"
  if [[ "$avant" != "$apres" ]]; then
    relecteur_a_ecrit
    # Aucune réponse de ce passage ne se reprend : obtenues pendant que le dépôt bougeait, elles
    # ne portent sur aucun état sûr. Sans cet effacement, une reprise après restauration du
    # checkout (même empreinte qu'avant) les réutiliserait.
    for ((i = 0; i < total; i++)); do
      chemin="$(jq -r ".lots[$i].chemin" "$index")"
      rm -f "$chemin.ok" "$chemin.raw" "$chemin.json"
    done
    return "$CODE_RELECTEUR_A_ECRIT"
  fi
  for ((i = 0; i < total; i++)); do
    chemin="$(jq -r ".lots[$i].chemin" "$index")"
    if [[ ! -f "$chemin.ok" ]]; then
      echo "ERREUR : lot $((i + 1)) sur $total sans réponse exploitable (journal : $chemin.raw.log)." >&2
      echecs=$((echecs + 1))
    fi
  done
  [[ "$echecs" -eq 0 ]]
}

# --- Lecture des réponses -------------------------------------------------------------------------

# mistral_extraire_json <brut> <sortie> <schéma> : le DERNIER bloc ```json de la réponse (un
# modèle qui se reprend écrit son verdict final en dernier), à défaut le fichier entier. Il doit
# être du JSON conforme au schéma, validé par le même validateur que le reste du harness.
# <sortie> n'est posée qu'une fois validée : en cas d'échec, elle n'existe pas.
mistral_extraire_json() {
  local brut="$1" sortie="$2" schema="$3" tmp
  tmp="$sortie.tmp"
  rm -f "$tmp"
  awk '
    /^[[:space:]]*```json[[:space:]]*$/ { cap = 1; buf = ""; next }
    /^[[:space:]]*```[[:space:]]*$/     { if (cap) { last = buf; cap = 0 }; next }
    cap { buf = buf $0 "\n" }
    END { printf "%s", last }
  ' "$brut" > "$tmp"
  [[ -s "$tmp" ]] || cp "$brut" "$tmp"
  if ! jq -e . "$tmp" >/dev/null 2>&1; then
    echo "ERREUR : la réponse de Mistral ne porte pas de JSON lisible. Rien n'est écrit. Réponse : $brut" >&2
    rm -f "$tmp"
    return 1
  fi
  if ! node "$SCRIPTS/lib/schema-mini.mjs" "$schema" "$tmp" >&2; then
    echo "ERREUR : la réponse de Mistral ne respecte pas le schéma $(basename "$schema"). Rien n'est écrit. Réponse : $brut" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$sortie"
}

# mistral_cout <brut>... : la somme des coûts réels (USD) des sessions de ces appels, lue dans le
# journal que vibe écrit (stats.session_cost). Rend 0 si rien n'est lisible.
mistral_cout() {
  local f m metas=()
  for f in "$@"; do
    while IFS= read -r m; do metas+=("$m"); done < <(find "$f.sessions" -name meta.json 2>/dev/null)
  done
  ((${#metas[@]} > 0)) || { echo 0; return 0; }
  jq -s 'map(.stats.session_cost // 0) | add | . * 10000 | round / 10000' "${metas[@]}" 2>/dev/null || echo 0
}

# --- Contexte d'un finding --------------------------------------------------------------------------

# mistral_fichiers_du_finding <finding.json> : les chemins BRUTS du finding, un par ligne, le
# suffixe « :ligne » retiré. Bruts veut dire NON CONTRÔLÉS : ils ne servent qu'à
# mistral_fichiers_libres, seul endroit qui les canonise et les confronte aux exclusions.
mistral_fichiers_du_finding() {
  jq -r '[.fichier // empty, (.fichiers_touches // [])[]] | .[] | select(type == "string")' "$1" 2>/dev/null \
    | sed -E 's/:[0-9].*$//; s/[[:space:]]+$//' \
    | grep -vE '^$' || true
}

# Au-delà, un finding ne désigne plus un défaut précis : on refuse au lieu de tronquer la liste.
MISTRAL_FICHIERS_MAX=20

# --- Chemins interdits : UNE liste, d'où dérivent tous les contrôles ---------------------------------
# La liste effective des chemins interdits = les secrets du profil livré (sa denylist) ∪ les chemins
# exclus du projet (relecteur.chemins_exclus). Elle est calculée en UN endroit,
# lib/profil-vibe.mjs (listeInterdite), et TOUT en dérive : les denylists des deux outils et le
# parcours de grep du profil effectif, le contrôle du diff de la relecture sécurité, la détection
# des copies et déplacements, et le contexte de l'arbitre et de la tranche. Deux listes traitées
# par deux chemins avaient fini par diverger : la copie d'un .env n'était détectée que pour les
# chemins exclus, et un réglage local interdit à read_file restait parcouru par grep.
# LIMITE : l'interdiction protège des CHEMINS, pas du contenu ; une copie retouchée sous le seuil
# de similarité de Git, ou un contenu recollé à la main, passe.
MISTRAL_MOTIFS_EXCLUS=()
MISTRAL_DERIVES_INTERDITS=()

# mistral_interdits_parmi : lit des chemins relatifs à la racine sur l'entrée, séparés par un octet
# NUL (git -z, jamais une forme citée), rend ceux qui tombent sous la liste interdite, séparés de
# même. Rend 1 si le contrôle ne se fait pas : l'appelant refuse.
mistral_interdits_parmi() {
  node "$SCRIPTS/lib/profil-vibe.mjs" --interdits "$MISTRAL_PROFIL" "$RACINE" "${MISTRAL_MOTIFS_EXCLUS[@]}"
}

# mistral_trier_interdits <chemin>... : pose MISTRAL_TROUVES, les chemins donnés qui sont interdits
# (sous la liste, ou copie ou déplacement d'un interdit). Rend 1 si le contrôle ne se fait pas.
MISTRAL_TROUVES=()
mistral_trier_interdits() {
  local f d lus=()
  MISTRAL_TROUVES=()
  (($# > 0)) || return 0
  mapfile -d '' -t lus < <(printf '%s\0' "$@" | mistral_interdits_parmi && printf 'FIN-OK\0')
  ((${#lus[@]} > 0)) && [[ "${lus[${#lus[@]}-1]}" == "FIN-OK" ]] || return 1
  unset "lus[$((${#lus[@]} - 1))]"
  MISTRAL_TROUVES=("${lus[@]}")
  for f in "$@"; do
    for d in "${MISTRAL_DERIVES_INTERDITS[@]}"; do
      if [[ "$d" == "$f" ]]; then MISTRAL_TROUVES+=("$f"); fi
    done
  done
  return 0
}

# mistral_est_trouve <chemin> : vrai si le chemin est dans MISTRAL_TROUVES.
mistral_est_trouve() {
  local t
  for t in "${MISTRAL_TROUVES[@]}"; do [[ "$t" == "$1" ]] && return 0; done
  return 1
}

# mistral_exclusions_charger <base_ref> : charge les motifs du projet, puis relève, sur tout le
# diff de la branche, les COPIES et DÉPLACEMENTS dont la source est interdite (secret ou chemin
# exclu). --find-copies-harder : sans lui, Git ne cherche la source d'une copie que parmi les
# fichiers modifiés, et la copie d'un .env laissé intact passe pour un ajout ordinaire. À appeler
# une fois, avant tout contrôle. Rend 1 si le contrôle ne se fait pas.
mistral_exclusions_charger() {
  local base_ref="$1" statut source dest m i
  local sources=() dests=()
  MISTRAL_MOTIFS_EXCLUS=()
  MISTRAL_DERIVES_INTERDITS=()
  while IFS= read -r m; do [[ -n "$m" ]] && MISTRAL_MOTIFS_EXCLUS+=("$m"); done < <(cfg_lignes .relecteur.chemins_exclus)
  while IFS= read -r -d '' statut; do
    case "$statut" in
      R* | C*)
        IFS= read -r -d '' source || break
        IFS= read -r -d '' dest || break
        sources+=("$source")
        dests+=("$dest")
        ;;
      *) IFS= read -r -d '' source || break ;;
    esac
  done < <(git -C "$RACINE" diff -M -C --find-copies-harder --name-status -z "$base_ref"...HEAD 2>/dev/null)
  ((${#sources[@]} > 0)) || return 0
  mistral_trier_interdits "${sources[@]}" || return 1
  for ((i = 0; i < ${#sources[@]}; i++)); do
    if mistral_est_trouve "${sources[i]}"; then MISTRAL_DERIVES_INTERDITS+=("${dests[i]}"); fi
  done
}

# mistral_refuser_copies_interdites : l'arbitre et la tranche REFUSENT l'appel entier quand la
# branche porte une copie ou un déplacement d'un chemin interdit. Retirer la copie du diff ne
# suffit pas : l'arbitre peut la lire avec ses outils, et la copie a un nom permis. Même règle que
# la relecture sécurité, qui refuse un tel diff. Appeler mistral_exclusions_charger avant.
mistral_refuser_copies_interdites() {
  ((${#MISTRAL_DERIVES_INTERDITS[@]} == 0)) && return 0
  printf '  %s\n' "${MISTRAL_DERIVES_INTERDITS[@]}" >&2
  refuser "la branche porte une copie ou un déplacement d'un fichier de secrets ou d'un chemin exclu (ci-dessus) : son contenu partirait chez Mistral. Retire-la de la branche, ou escalade vers l'humain."
}

# mistral_interdits_du_diff <base_ref> : pose MISTRAL_TROUVES, les fichiers du diff de la branche
# qui sont interdits, copies et déplacements compris. Appeler mistral_exclusions_charger avant.
mistral_interdits_du_diff() {
  local noms=()
  mapfile -d '' -t noms < <(git -C "$RACINE" diff --no-renames --name-only -z "$1"...HEAD 2>/dev/null && printf 'FIN-OK\0')
  ((${#noms[@]} > 0)) && [[ "${noms[${#noms[@]}-1]}" == "FIN-OK" ]] || return 1
  unset "noms[$((${#noms[@]} - 1))]"
  mistral_trier_interdits "${noms[@]}" "${MISTRAL_DERIVES_INTERDITS[@]}"
}

# mistral_diff_borne <base_ref> <max caractères> [<fichier>...] : le diff de la branche, limité
# aux fichiers donnés, SANS aucun chemin interdit (ils sont nommés sur la sortie d'erreur), et
# BORNÉ avec un avis de troncature explicite. Rend 1 si Git ou le contrôle échouent : un diff raté ne passe jamais
# pour un diff vide. Appeler mistral_exclusions_charger avant.
mistral_diff_borne() {
  local base_ref="$1" max="$2" diff f
  shift 2
  local noms=() gardes=()
  # La marque finale n'est écrite que si Git a réussi : sans elle, l'échec ne se perdrait pas
  # dans la substitution de processus.
  mapfile -d '' -t noms < <(git -C "$RACINE" diff --no-renames --name-only -z "$base_ref"...HEAD -- "$@" 2>/dev/null && printf 'FIN-OK\0')
  ((${#noms[@]} > 0)) && [[ "${noms[${#noms[@]}-1]}" == "FIN-OK" ]] || { echo "ERREUR : git diff a échoué ($base_ref...HEAD)." >&2; return 1; }
  unset "noms[$((${#noms[@]} - 1))]"
  mistral_trier_interdits "${noms[@]}" || {
    echo "ERREUR : contrôle des chemins interdits impossible : rien n'est envoyé." >&2
    return 1
  }
  for f in "${noms[@]}"; do
    if mistral_est_trouve "$f"; then
      echo "  $f : chemin interdit (secret ou chemin exclu, ou copie d'un tel fichier), retiré du contexte envoyé" >&2
    else
      gardes+=("$f")
    fi
  done
  ((${#gardes[@]} > 0)) || return 0
  if ! diff="$(git -C "$RACINE" -c core.quotePath=false diff --no-renames "$base_ref"...HEAD -- "${gardes[@]}" 2>/dev/null)"; then
    echo "ERREUR : git diff a échoué ($base_ref...HEAD)." >&2
    return 1
  fi
  if [[ "${#diff}" -gt "$max" ]]; then
    printf '%s\n\n[... diff tronqué à %s caractères ...]\n' "${diff:0:$max}" "$max"
  else
    printf '%s\n' "$diff"
  fi
}

# mistral_canoniser <chemin> : le chemin relatif à la racine du checkout, sous deux formes,
# séparées par une tabulation : la forme LEXICALE (« ./ » et « .. » résolus, liens laissés tels
# quels : c'est le nom que Git connaît) et la forme RÉSOLUE (liens symboliques suivis : c'est le
# fichier qu'on lirait). Rend 1, sans rien écrire, si l'une des deux sort du checkout.
mistral_canoniser() {
  local brut="$1" absolu lex res racine_lex racine_res
  [[ "$brut" == /* ]] && absolu="$brut" || absolu="$RACINE/$brut"
  racine_lex="$(realpath -m -s -- "$RACINE")" || return 1
  racine_res="$(realpath -m -- "$RACINE")" || return 1
  lex="$(realpath -m -s -- "$absolu")" || return 1
  res="$(realpath -m -- "$absolu")" || return 1
  [[ "$lex" == "$racine_lex"/* && "$res" == "$racine_res"/* ]] || return 1
  printf '%s\t%s\n' "${lex#"$racine_lex"/}" "${res#"$racine_res"/}"
}

# mistral_fichiers_libres <finding.json> : les chemins du finding qui peuvent entrer dans un
# prompt, un par ligne, sous leur forme LEXICALE canonique. C'est le SEUL contrôle des chemins
# d'un finding, partagé par l'arbitre et la tranche :
#   - chaque chemin est canonisé (« ./x », « a/../x », liens symboliques) AVANT tout jugement ;
#     comparer des chaînes brutes laissait passer « ./secrets/cle.txt » ;
#   - un chemin qui sort du checkout (« .. », chemin absolu, lien vers l'extérieur) : REFUS du
#     finding entier, rien ne part ;
#   - l'exclusion se juge sur le chemin lexical ET sur la cible du lien : un lien libre vers un
#     fichier exclu est exclu ; le dossier Git ne part jamais ;
#   - un finding qui ne porte QUE sur des chemins interdits : REFUS (code 1), l'arbitrer
#     obligerait à envoyer ce que le projet a exclu.
# --strict (la tranche) : UN SEUL chemin interdit suffit à refuser. Sans outil, la tranche
# décide sur ce qu'on lui donne : un sous-ensemble la ferait trancher sans un fichier requis.
# L'arbitre, qui peut lire avec ses outils, reste sur le sous-ensemble permis.
# Appeler mistral_exclusions_charger avant.
mistral_fichiers_libres() {
  local brut canon lex res vus=0 libres=0 exclus=0 strict=0 total
  [[ "${2:-}" == "--strict" ]] && strict=1
  total="$(mistral_fichiers_du_finding "$1" | wc -l)"
  if ((total > MISTRAL_FICHIERS_MAX)); then
    echo "REFUS : le finding nomme $total fichiers, plus que $MISTRAL_FICHIERS_MAX : il ne désigne plus un défaut précis, et la liste ne se tronque pas en silence. Le découper, ou escalader vers l'humain." >&2
    return 1
  fi
  while IFS= read -r brut; do
    vus=$((vus + 1))
    if ! canon="$(mistral_canoniser "$brut")"; then
      echo "REFUS : le chemin « $brut » du finding sort du checkout ($RACINE). Rien n'est envoyé." >&2
      return 1
    fi
    lex="${canon%%$'\t'*}"
    res="${canon#*$'\t'}"
    mistral_trier_interdits "$lex" "$res" || {
      echo "REFUS : contrôle des chemins interdits impossible : rien n'est envoyé." >&2
      return 1
    }
    if ((${#MISTRAL_TROUVES[@]} > 0)); then
      echo "  $brut : chemin exclu ou fichier de secrets (lui-même, ou la cible de son lien) : il ne part pas chez Mistral" >&2
      exclus=$((exclus + 1))
    else
      libres=$((libres + 1))
      printf '%s\n' "$lex"
    fi
  done < <(mistral_fichiers_du_finding "$1")
  if ((vus > 0 && libres == 0)); then
    echo "REFUS : le finding ne porte que sur des chemins exclus de toute relecture (ci-dessus). Il ne s'arbitre pas par un service externe : escalade vers l'humain." >&2
    return 1
  fi
  if ((strict && exclus > 0)); then
    echo "REFUS : un fichier requis par le finding est exclu (ci-dessus) : la tranche ne décide pas sans lui. Escalade vers l'humain." >&2
    return 1
  fi
}
