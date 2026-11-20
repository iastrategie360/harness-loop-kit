#!/usr/bin/env bash
# codex-common.sh : socle des scripts de relecture. À SOURCER, jamais à lancer.
#
# Le relecteur est un AUTRE modèle que celui qui écrit, appelé par son CLI. Trois règles
# tiennent ici, chacune payée par un incident :
#
#   1. LECTURE SEULE, et explicite. Le bac à sable par défaut du CLI dépend de la confiance
#      accordée au dossier sur le poste : dans un dossier de confiance, un relecteur reçoit le
#      droit d'écrire, et il s'en sert (un build lancé « pour vérifier » remplace les fichiers
#      construits). On impose donc la lecture seule à chaque appel.
#   2. Une sortie VIDE n'est pas une review propre. La sortie est écrite dans un fichier
#      temporaire, validée (non vide, JSON, conforme au schéma), puis seulement renommée vers
#      sa cible. En cas d'échec, la cible n'existe pas.
#   3. On VÉRIFIE que le relecteur n'a rien écrit (empreinte du dépôt avant et après). Si elle a
#      changé, on s'arrête et on le dit. On n'annule RIEN : un `reset --hard` lancé pour
#      « réparer » détruirait aussi le travail en cours de quelqu'un d'autre.
#
# Codes rendus par les scripts qui sourcent ce fichier :
#   0 succès ; 1 échec (la cible n'est pas écrite) ; 2 la relecture demande une action ;
#   5 le relecteur a modifié le dépôt (intervention humaine).
#   64 usage (2 est pris par « la relecture demande une action »).
. "$(dirname "${BASH_SOURCE[0]}")/commun.sh"

SCHEMAS="$SCRIPTS/../schemas"
CODE_RELECTEUR_A_ECRIT=5
# `exec review` n'accepte pas `-s` : la lecture seule passe par la configuration du CLI.
CODEX_LECTURE_SEULE=(-c 'sandbox_mode="read-only"')
CODEX_MODELE=""
CODEX_EFFORT=""
CODEX_DELAI=600

# codex_preparer : à appeler avant tout appel au relecteur. Refuse sans accord, sans CLI ou
# sans authentification.
codex_preparer() {
  [[ "$(cfg .relecteur.accord_envoi_externe)" == "true" ]] || refuser \
    "relecteur.accord_envoi_externe est à false dans harness/projet.json. Le relecteur envoie le code du projet à un service externe : c'est à $(cfg .projet.approbateur) de l'accepter."
  command -v codex >/dev/null || refuser "CLI du relecteur introuvable (codex). Voir harness/scripts/preflight.sh."
  # Un relecteur non authentifié rend une sortie vide : on le sait AVANT de lancer.
  timeout -k 5 30 codex login status >/dev/null 2>&1 || refuser \
    "le relecteur n'est pas authentifié. Lancer : codex login"
  CODEX_MODELE="$(cfg .relecteur.modele)"
  CODEX_EFFORT="$(cfg .relecteur.effort)"
  mkdir -p "$TRAVAIL/relecteur"
}

# codex_delai <court|diff|pr> : le délai configuré, en secondes.
# HARNESS_DELAI_RELECTEUR_S le remplace (tests, ou une relecture exceptionnellement longue).
codex_delai() {
  if [[ -n "${HARNESS_DELAI_RELECTEUR_S:-}" ]]; then
    printf '%s\n' "$HARNESS_DELAI_RELECTEUR_S"
  else
    cfg ".relecteur.delais_s.$1"
  fi
}

# codex_consignes : les consignes communes à tous les prompts (langue, style, chemins exclus).
codex_consignes() {
  local exclus
  printf 'Rédige tout en %s.\n' "$(cfg .projet.langue)"
  cfg_lignes .projet.regles_style | sed 's/^/Règle de style : /'
  exclus="$(cfg_lignes .relecteur.chemins_exclus | sed 's/^/ - /')"
  if [[ -n "$exclus" ]]; then
    printf "N'ouvre AUCUN fichier sous ces chemins, même pour vérifier :\n%s\n" "$exclus"
  fi
}

# codex_contexte : la liste des documents de contexte du projet, une puce par ligne.
codex_contexte() {
  echo " - harness/PROJET.md (domaine, utilisateurs, pièges du projet)"
  cfg_lignes .chemins.contexte | sed 's/^/ - /'
}

# depot_empreinte : une empreinte de l'arbre de travail (commit courant, état des fichiers
# suivis, contenu des fichiers non suivis). Le dossier de travail du harness en est exclu : le
# harness y écrit lui-même pendant l'appel.
# LIMITE : les fichiers ignorés par Git ne sont pas vus. C'est la lecture seule imposée au CLI
# qui protège ; l'empreinte est le second verrou, pas le premier.
depot_empreinte() {
  {
    git -C "$RACINE" rev-parse HEAD 2>/dev/null || echo "sans-commit"
    git -C "$RACINE" status --porcelain=v1 --untracked-files=all -- . ':(exclude)harness/.travail' | LC_ALL=C sort
    git -C "$RACINE" diff HEAD -- . ':(exclude)harness/.travail' 2>/dev/null
    (cd "$RACINE" && git ls-files -z --others --exclude-standard -- . ':(exclude)harness/.travail' | LC_ALL=C sort -z | xargs -0 -r sha256sum 2>/dev/null)
  } | sha256sum | cut -d' ' -f1
}

relecteur_a_ecrit() {
  {
    echo "ERREUR : le relecteur a MODIFIÉ le dépôt pendant sa lecture, malgré la lecture seule."
    echo "  Sa sortie est écartée. Rien n'a été annulé : regarde « git status » et décide."
    echo "  Tant que ce n'est pas compris, aucune relecture ne vaut."
  } >&2
}

# codex_classify_failure <code> <journal> [stderr] [fiable]
# Dit pourquoi le relecteur a échoué SANS confondre le contenu relu avec un diagnostic.
# Le journal mêle parfois le code relu (qui peut contenir « 401 », « token », « quota » comme
# DONNÉES) et les vraies erreurs du CLI : chercher ces mots dans ce mélange fait passer un
# délai dépassé pour une authentification expirée. Sources fiables, par ordre :
#   1. le code de sortie (124 = délai) prime sur tout ;
#   2. le fichier stderr dédié et les ÉVÉNEMENTS D'ERREUR du flux JSONL (jamais les messages
#      de l'agent, qui portent le contenu relu) ;
#   3. à défaut seulement, les lignes non JSON de la fin du journal.
# fiable=0 : le stderr est mêlé à la transcription. On reste alors générique : ne pas
# diagnostiquer est sûr, diagnostiquer une panne d'authentification inexistante ne l'est pas.
codex_classify_failure() {
  local rc="$1" log="$2" errfile="${3:-}" fiable="${4:-1}"
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
    echo "ERREUR : le relecteur a dépassé le délai (${CODEX_DELAI} s). Baisser relecteur.effort ou relever relecteur.delais_s dans harness/projet.json. Journal : $log" >&2
    return 0
  fi
  if [[ "$fiable" != "1" ]]; then
    echo "ERREUR : le relecteur a échoué (code $rc). Diagnostic non fiable sur ce chemin (stderr mêlé à la transcription) : lire $log" >&2
    return 0
  fi
  local diag="" jsonl_err ligne
  if [[ -n "$errfile" && -s "$errfile" ]]; then
    diag="$(tail -n 40 "$errfile" 2>/dev/null || true)"
  fi
  if [[ -n "$log" && -f "$log" ]]; then
    jsonl_err="$(tail -n 200 "$log" 2>/dev/null | jq -rc 'select(type=="object") | select((.type? // "" | test("error|fail";"i")) or has("error")) | tostring' 2>/dev/null || true)"
    if [[ -n "$jsonl_err" ]]; then
      diag="$diag"$'\n'"$jsonl_err"
    elif [[ -z "$diag" ]]; then
      diag="$(tail -n 40 "$log" 2>/dev/null | while IFS= read -r ligne; do
        printf '%s\n' "$ligne" | jq -e . >/dev/null 2>&1 || printf '%s\n' "$ligne"
      done || true)"
    fi
  fi
  if printf '%s' "$diag" | grep -q "not supported when using Codex with a ChatGPT account"; then
    echo "ERREUR : le modèle « ${CODEX_MODELE:-par défaut} » est refusé par le compte du relecteur. Corriger relecteur.modele (null = modèle par défaut du CLI)." >&2
  elif printf '%s' "$diag" | grep -qiE "unexpected status 401|401 unauthorized|invalid_api_key|refresh token|token (a|has )?expir|re-?login"; then
    echo "ERREUR : authentification du relecteur expirée ou invalide. Relancer : codex login" >&2
  elif printf '%s' "$diag" | grep -qiE "usage limit|rate limit|429 too many|quota"; then
    echo "ERREUR : limite d'usage du compte du relecteur atteinte. Réessayer plus tard, ou baisser relecteur.effort. Journal : $log" >&2
  else
    echo "ERREUR : le relecteur a échoué (code $rc). Journal : $log" >&2
  fi
}

# codex_run <schema.json|-> <sortie> <prompt> [délai en s]
# Lance le relecteur en lecture seule sur un prompt. La sortie n'est posée à <sortie> qu'une
# fois validée. Rend 0, 1 (échec, <sortie> intacte ou absente) ou 5 (le relecteur a écrit).
codex_run() {
  local schema="$1" out="$2" prompt="$3" delai="${4:-$(codex_delai court)}"
  local tmp rc=0 avant apres
  local args=(-s read-only -C "$RACINE" --skip-git-repo-check --json)
  [[ -n "$CODEX_MODELE" ]] && args+=(-m "$CODEX_MODELE")
  [[ -n "$CODEX_EFFORT" ]] && args+=(-c "model_reasoning_effort=\"$CODEX_EFFORT\"")
  [[ "$schema" != "-" ]] && args+=(--output-schema "$schema")
  mkdir -p "$TRAVAIL/relecteur" "$(dirname "$out")"
  tmp="$TRAVAIL/relecteur/$(basename "$out").tmp"
  rm -f "$tmp" "$tmp.log" "$tmp.err"
  CODEX_DELAI="$delai"
  avant="$(depot_empreinte)"
  # stdin fermé : sinon le CLI tente de lire une entrée héritée et peut bloquer.
  timeout -k 10 "$delai" codex exec "${args[@]}" -o "$tmp" "$prompt" > "$tmp.log" 2> "$tmp.err" < /dev/null || rc=$?
  apres="$(depot_empreinte)"
  if [[ "$avant" != "$apres" ]]; then
    relecteur_a_ecrit
    return "$CODE_RELECTEUR_A_ECRIT"
  fi
  if ((rc != 0)); then
    codex_classify_failure "$rc" "$tmp.log" "$tmp.err"
    return 1
  fi
  if [[ ! -s "$tmp" ]]; then
    echo "ERREUR : le relecteur a rendu une sortie VIDE avec un code 0. Ce n'est pas une relecture propre : rien n'est écrit. Journal : $tmp.log" >&2
    return 1
  fi
  if [[ "$schema" != "-" ]]; then
    if ! jq -e . "$tmp" >/dev/null 2>&1; then
      echo "ERREUR : la sortie du relecteur n'est pas du JSON. Rien n'est écrit. Sortie : $tmp" >&2
      return 1
    fi
    if ! node "$SCRIPTS/lib/schema-mini.mjs" "$schema" "$tmp" >&2; then
      echo "ERREUR : la sortie du relecteur ne respecte pas le schéma $(basename "$schema"). Rien n'est écrit. Sortie : $tmp" >&2
      return 1
    fi
  fi
  mv "$tmp" "$out"
}

# codex_base_ref [--bloquant] : la référence de la branche d'intégration à comparer.
# Avec un dépôt distant, on compare contre la référence DISTANTE rafraîchie. --bloquant : un
# rafraîchissement en échec arrête (une review qui certifie ne se fait pas contre une base
# périmée). Sans dépôt distant déclaré dans Git, on compare contre la branche locale.
codex_base_ref() {
  local bloquant=0 remote base
  [[ "${1:-}" == "--bloquant" ]] && bloquant=1
  remote="$(cfg .git.remote)"
  base="$(cfg .git.branche_integration)"
  if git -C "$RACINE" remote get-url "$remote" >/dev/null 2>&1; then
    if ! timeout -k 5 120 git -C "$RACINE" fetch --quiet "$remote" "$base" 2>/dev/null; then
      if ((bloquant)); then
        echo "ERREUR : impossible de rafraîchir $remote/$base (réseau ou authentification). Cette review certifie une PR : la lancer contre une copie périmée de la base serait certifier un état qui n'existe plus." >&2
        return 1
      fi
      echo "avertissement : $remote/$base non rafraîchie, comparaison contre la dernière copie connue" >&2
    fi
    if git -C "$RACINE" rev-parse --verify --quiet "$remote/$base" >/dev/null; then
      printf '%s\n' "$remote/$base"
      return 0
    fi
    echo "ERREUR : la référence $remote/$base est introuvable." >&2
    return 1
  fi
  if git -C "$RACINE" rev-parse --verify --quiet "$base" >/dev/null; then
    printf '%s\n' "$base"
    return 0
  fi
  echo "ERREUR : la branche d'intégration « $base » est introuvable (git.branche_integration)." >&2
  return 1
}

# codex_diff_touche_exclus <base_ref> : rend 0 et nomme les fichiers si le diff touche un
# chemin de relecteur.chemins_exclus. Une review de diff envoie le diff : elle ne part pas.
codex_diff_touche_exclus() {
  local base_ref="$1" fichier motif touche=1
  local motifs=()
  while IFS= read -r motif; do
    [[ -n "$motif" ]] && motifs+=("$motif")
  done < <(cfg_lignes .relecteur.chemins_exclus)
  ((${#motifs[@]} > 0)) || return 1
  # --no-renames : un fichier exclu DÉPLACÉ vers un chemin libre ne paraîtrait que sous son
  # nouveau nom, et son contenu partirait. Sans détection, Git nomme les deux côtés.
  # -z : les noms arrivent bruts, sans les guillemets que Git met autour d'un nom inhabituel.
  while IFS= read -r -d '' fichier; do
    for motif in "${motifs[@]}"; do
      # Le motif est un joker ; un nom de dossier couvre tout ce qu'il contient.
      # shellcheck disable=SC2053
      if [[ "$fichier" == $motif || "$fichier" == "${motif%/}"/* ]]; then
        echo "  $fichier (exclu par « $motif »)" >&2
        touche=0
      fi
    done
  done < <(git -C "$RACINE" diff --no-renames --name-only -z "$base_ref"...HEAD)
  return "$touche"
}

# codex_review <base_ref> <brut> <délai en s>
# La review du CLI sur le diff de la branche contre <base_ref>. Deux formes d'appel, parce que
# `--base` exclut tout prompt : sans chemin exclu, `--base` ; avec des chemins exclus, la même
# review demandée par écrit, seule façon de porter la consigne de ne pas les ouvrir (sans elle,
# le relecteur lirait ces fichiers en explorant le code voisin du diff). Les deux formes rendent
# le même format, constaté sur le CLI réel.
# Écrit <brut> (dernier message) et <brut>.jsonl (flux d'événements, qui porte les deux preuves
# exigées d'une review sans finding : la fin de tour et au moins une commande réussie dans le
# dépôt). `--output-schema` est passé mais peut ne pas être honoré en
# mode review : l'extraction réelle est faite par lib/review-pr-artefact.mjs, à trois niveaux.
# Rend 0, 1 (échec ou sortie vide) ou 5 (le relecteur a écrit).
codex_review() {
  local base_ref="$1" brut="$2" delai="$3" rc=0 avant apres
  local args=("${CODEX_LECTURE_SEULE[@]}")
  [[ -n "$CODEX_MODELE" ]] && args+=(-c "model=\"$CODEX_MODELE\"")
  [[ -n "$CODEX_EFFORT" ]] && args+=(-c "model_reasoning_effort=\"$CODEX_EFFORT\"")
  mkdir -p "$(dirname "$brut")"
  rm -f "$brut" "$brut.jsonl" "$brut.err"
  CODEX_DELAI="$delai"
  avant="$(depot_empreinte)"
  local cible=(--base "$base_ref")
  if [[ -n "$(cfg_lignes .relecteur.chemins_exclus)" ]]; then
    cible=("$(printf 'Relis les changements de la branche courante par rapport à %s (le diff : git diff %s...HEAD).\n%s' \
      "$base_ref" "$base_ref" "$(codex_consignes)")")
  fi
  timeout -k 10 "$delai" codex -C "$RACINE" exec review "${args[@]}" --json \
    --output-schema "$SCHEMAS/review-pr-cli.json" -o "$brut" "${cible[@]}" < /dev/null > "$brut.jsonl" 2> "$brut.err" || rc=$?
  apres="$(depot_empreinte)"
  if [[ "$avant" != "$apres" ]]; then
    relecteur_a_ecrit
    return "$CODE_RELECTEUR_A_ECRIT"
  fi
  if ((rc != 0)); then
    codex_classify_failure "$rc" "$brut.jsonl" "$brut.err"
    return 1
  fi
  if [[ ! -s "$brut" ]]; then
    echo "ERREUR : le relecteur a rendu une sortie VIDE avec un code 0. Ce n'est pas une review propre : rien n'est écrit. Journal : $brut.jsonl" >&2
    return 1
  fi
}
