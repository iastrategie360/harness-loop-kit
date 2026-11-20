#!/usr/bin/env bash
# creneaux.sh : deux stories en même temps, sans qu'elles se marchent dessus. EXPÉRIMENTAL.
#
# Deux créneaux, pas plus :
#   a = l'arbre de travail principal du dépôt ;
#   b = un second arbre de travail (git worktree), créé à côté, sur la branche de sa story.
# Chaque créneau DÉCLARE sa story et son périmètre de fichiers. Le script refuse d'ouvrir un
# créneau dont le périmètre peut croiser celui de l'autre : c'est la seule chose qui rend le
# parallèle sûr, et elle se prouve sur des chemins, pas sur une impression.
#
# Les déclarations vivent dans le dossier Git commun aux deux arbres (jamais versionnées).
#
# Usage :
#   creneaux.sh ouvrir <story> [a|b] [--perimetre <glob>]...
#       Déclare la story dans un créneau. Sans créneau nommé : celui qui porte déjà la story,
#       sinon celui de l'arbre courant. Sans --perimetre : celui de l'état de la story.
#       Relançable : redéclarer la même story met son périmètre à jour et recontrôle.
#       Créneau b : crée le second arbre et la branche de la story s'ils n'existent pas.
#   creneaux.sh fermer <a|b>
#       a : retire la déclaration. b : retire aussi le second arbre, depuis l'arbre principal,
#       et refuse tant qu'il porte du travail non poussé.
#   creneaux.sh verifier [a|b]
#       Compare ce que la branche a RÉELLEMENT touché à ce que le créneau a déclaré. Un fichier
#       touché hors du périmètre déclaré est un refus : c'est lui que l'autre chantier n'a
#       jamais vu. Les documents de la story elle-même ne comptent pas.
#   creneaux.sh etat [--json]
#   creneaux.sh port [a|b]        le port du banc de ce créneau (ligne vide si le projet n'en a pas)
#
# Codes : 0 fait ; 1 refus (la cause est nommée) ; 2 usage.
# Réglage : HARNESS_CRENEAU_B (chemin du second arbre ; défaut : <arbre principal>-creneau-b).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/commun.sh"

usage() {
  echo "usage : creneaux.sh ouvrir <story> [a|b] [--perimetre <glob>]... | fermer <a|b> | verifier [a|b] | etat [--json] | port [a|b]" >&2
  exit 2
}

reel() { (cd "$1" && pwd -P); }

COMMUN="$(git -C "$RACINE" rev-parse --git-common-dir)"
[[ "$COMMUN" == /* ]] || COMMUN="$RACINE/$COMMUN"
COMMUN="$(reel "$COMMUN")"
ARBRES="$(git -C "$RACINE" worktree list --porcelain)"
ARBRE_PRINCIPAL="$(sed -n '1s/^worktree //p' <<<"$ARBRES")"
[[ -n "$ARBRE_PRINCIPAL" && -d "$ARBRE_PRINCIPAL" ]] || refuser "arbre de travail principal introuvable."
ARBRE_PRINCIPAL="$(reel "$ARBRE_PRINCIPAL")"
ICI="$(reel "$RACINE")"
CHEMIN_B="${HARNESS_CRENEAU_B:-$(dirname "$ARBRE_PRINCIPAL")/$(basename "$ARBRE_PRINCIPAL")-creneau-b}"

[[ "$(cfg .options.creneaux.actif)" == "true" ]] || refuser "l'option creneaux n'est pas active (options.creneaux.actif dans harness/projet.json)."

descripteur() { printf '%s\n' "$COMMUN/harness-creneau-$1.json"; }

# lire_descripteur <a|b> : écrit le JSON du créneau, ou rien s'il est libre. Un descripteur
# illisible est un REFUS : le prendre pour « libre » ouvrirait un chantier par-dessus un autre.
lire_descripteur() {
  local f
  f="$(descripteur "$1")"
  [[ -f "$f" ]] || return 0
  if ! jq -ce 'select((.story | type) == "string" and (.chemin | type) == "string" and (.perimetre | type) == "array")' "$f" 2>/dev/null; then
    refuser "déclaration du créneau $1 illisible : $f. Vérifier qu'aucun chantier n'y tourne, puis la corriger ou la supprimer à la main."
  fi
}

autre() { if [[ "$1" == "a" ]]; then echo b; else echo a; fi; }

# creneau_courant : a dans l'arbre principal, b dans le second arbre déclaré, rien ailleurs.
creneau_courant() {
  local d
  if [[ "$ICI" == "$ARBRE_PRINCIPAL" ]]; then
    echo a
    return 0
  fi
  d="$(lire_descripteur b)" || exit 1
  if [[ -n "$d" && "$(jq -r '.chemin' <<<"$d")" == "$ICI" ]]; then echo b; fi
}

# port_de <a|b> : a prend son port propre, sinon celui du projet ; b n'a que le sien.
port_de() {
  local p=""
  if [[ "$1" == "a" ]]; then
    p="$(cfg .options.creneaux.ports.a)"
    if [[ -z "$p" ]]; then p="$(cfg .execution.port)"; fi
  else
    p="$(cfg .options.creneaux.ports.b)"
  fi
  printf '%s' "$p"
}

# --- contrôle de croisement -------------------------------------------------------------

TOUS_FICHIERS=""

echapper_ere() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      .|'['|']'|'{'|'}'|'('|')'|'+'|'^'|'$'|'|'|'\') out+="\\$c" ;;
      *) out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

# Un glob sans joker qui nomme un dossier vaut tout ce dossier.
glob_vers_regex() {
  local g="$1" r
  if [[ "$g" != *[*?]* ]]; then
    g="${g%/}"
    if grep -qF -- "$g/" <<<"$TOUS_FICHIERS"; then g="$g/**"; fi
  fi
  r="$(echapper_ere "$g")"
  r="${r//\*\*/$'\001'}"    # marque « ** » avant de traiter « * »
  r="${r//\*/[^\/]*}"
  r="${r//$'\001'/.*}"
  r="${r//\?/[^\/]}"
  printf '^%s$' "$r"
}

fichiers_du_perimetre() {
  local g
  for g in "$@"; do
    grep -E -- "$(glob_vers_regex "$g")" <<<"$TOUS_FICHIERS" || true
  done | sort -u
}

# peuvent_se_croiser <glob> <glob> : 0 si l'un peut porter un fichier de l'autre, même un
# fichier qui n'existe pas encore. On compare les parties littérales, avant le premier joker.
# Le contrôle est prudent : il refuse parfois deux globs qui ne se croiseraient pas.
peuvent_se_croiser() {
  local g="${1%/}" h="${2%/}" pg ph
  pg="${g%%[*?]*}"
  ph="${h%%[*?]*}"
  if [[ "$g" == "$pg" && "$h" == "$ph" ]]; then
    if [[ "$g" == "$h" || "$g" == "$h/"* || "$h" == "$g/"* ]]; then return 0; fi
  elif [[ "$g" == "$pg" ]]; then
    if [[ "$g" == "$ph"* || "$ph" == "$g/"* ]]; then return 0; fi
  elif [[ "$h" == "$ph" ]]; then
    if [[ "$h" == "$pg"* || "$pg" == "$h/"* ]]; then return 0; fi
  else
    if [[ "$pg" == "$ph"* || "$ph" == "$pg"* ]]; then return 0; fi
  fi
  return 1
}

# revendique <ressource> <glob>... : 0 si l'un des globs touche la ressource exclusive.
revendique() {
  local ressource="$1" g fr fg communs
  shift
  fr="$(fichiers_du_perimetre "$ressource")"
  for g in "$@"; do
    if peuvent_se_croiser "$g" "$ressource"; then return 0; fi
    fg="$(fichiers_du_perimetre "$g")"
    if [[ -n "$fr" && -n "$fg" ]]; then
      communs="$(comm -12 <(printf '%s\n' "$fr") <(printf '%s\n' "$fg"))"
      if [[ -n "$communs" ]]; then return 0; fi
    fi
  done
  return 1
}

# controler_croisement <créneau> <story> <json du périmètre> : refuse si l'autre créneau est
# déclaré et que les deux périmètres peuvent se croiser.
controler_croisement() {
  local c="$1" story="$2" perimetre="$3" o d story_o liste g h ressource fm fo communs n
  local -a miens siens
  o="$(autre "$c")"
  d="$(lire_descripteur "$o")" || exit 1
  [[ -n "$d" ]] || return 0
  story_o="$(jq -r '.story' <<<"$d")"
  if [[ "$story_o" == "$story" ]]; then
    refuser "la story $story est déjà déclarée dans le créneau $o. Une story n'occupe qu'un créneau."
  fi
  liste="$(jq -r '.[]' <<<"$perimetre")" || exit 1
  mapfile -t miens <<<"$liste"
  liste="$(jq -r '.perimetre[]' <<<"$d")" || exit 1
  mapfile -t siens <<<"$liste"
  if [[ -z "${siens[0]:-}" ]]; then
    refuser "le créneau $o ($story_o) n'a déclaré aucun périmètre : impossible de prouver que les deux chantiers ne se croisent pas."
  fi

  for g in "${miens[@]}"; do
    if [[ "$g" == [*?]* ]]; then
      refuser "périmètre trop large pour deux chantiers en parallèle : « $g » ($story) commence par un joker. Nommer les dossiers."
    fi
  done
  for h in "${siens[@]}"; do
    if [[ "$h" == [*?]* ]]; then
      refuser "périmètre trop large pour deux chantiers en parallèle : « $h » ($story_o, créneau $o) commence par un joker. Nommer les dossiers."
    fi
  done

  TOUS_FICHIERS="$(git -C "$ARBRE_PRINCIPAL" ls-files)"

  # 1. Les ressources exclusives d'abord : deux fichiers DIFFÉRENTS d'un même dossier numéroté
  #    ne se croisent pas sur le papier, et se télescopent au merge.
  while IFS= read -r ressource; do
    [[ -n "$ressource" ]] || continue
    if revendique "$ressource" "${miens[@]}" && revendique "$ressource" "${siens[@]}"; then
      refuser "ressource exclusive revendiquée des deux côtés : « $ressource » ($story et $story_o, créneau $o). Un seul chantier à la fois peut la porter."
    fi
  done <<<"$(cfg_lignes .options.creneaux.ressources_exclusives)"

  # 2. Des fichiers suivis en commun.
  fm="$(fichiers_du_perimetre "${miens[@]}")"
  fo="$(fichiers_du_perimetre "${siens[@]}")"
  if [[ -n "$fm" && -n "$fo" ]]; then
    communs="$(comm -12 <(printf '%s\n' "$fm") <(printf '%s\n' "$fo"))"
    if [[ -n "$communs" ]]; then
      n="$(grep -c . <<<"$communs")"
      echo "REFUS : $n fichier(s) dans les deux périmètres ($story et $story_o, créneau $o) :" >&2
      head -n 20 <<<"$communs" | sed 's/^/  - /' >&2
      if (( n > 20 )); then echo "  (et $(( n - 20 )) autre(s))" >&2; fi
      exit 1
    fi
  fi

  # 3. Des périmètres qui peuvent se croiser, même sans fichier commun aujourd'hui.
  for g in "${miens[@]}"; do
    for h in "${siens[@]}"; do
      if peuvent_se_croiser "$g" "$h"; then
        refuser "les périmètres peuvent se croiser : « $g » ($story) et « $h » ($story_o, créneau $o)."
      fi
    done
  done
  return 0
}

# --- second arbre ------------------------------------------------------------------------

distant_connu() { git -C "$ARBRE_PRINCIPAL" remote get-url "$1" >/dev/null 2>&1; }

creer_arbre_b() {
  local branche="$1" distant integration base
  if [[ -e "$CHEMIN_B" ]]; then
    [[ -d "$CHEMIN_B" ]] || refuser "$CHEMIN_B existe et n'est pas un dossier. Le déplacer, ou régler HARNESS_CRENEAU_B."
    CHEMIN_B="$(reel "$CHEMIN_B")"
    if ! grep -qxF -- "worktree $CHEMIN_B" <<<"$ARBRES"; then
      refuser "$CHEMIN_B existe et n'est pas un arbre de travail de ce dépôt. Le déplacer, ou régler HARNESS_CRENEAU_B."
    fi
    if [[ "$(git -C "$CHEMIN_B" rev-parse --abbrev-ref HEAD)" != "$branche" ]]; then
      refuser "$CHEMIN_B est sur une autre branche que $branche. Le remettre sur sa branche, ou le retirer (git worktree remove) s'il ne sert plus."
    fi
    return 0
  fi
  if git -C "$ARBRE_PRINCIPAL" show-ref --verify --quiet "refs/heads/$branche"; then
    git -C "$ARBRE_PRINCIPAL" worktree add -q "$CHEMIN_B" "$branche" \
      || refuser "impossible de sortir $branche dans $CHEMIN_B (la branche est peut-être déjà sortie dans l'arbre principal)."
    return 0
  fi
  distant="$(cfg .git.remote)"
  integration="$(cfg .git.branche_integration)"
  base="$integration"
  if [[ -n "$distant" ]] && distant_connu "$distant"; then
    git -C "$ARBRE_PRINCIPAL" fetch -q "$distant" "$integration" \
      || refuser "git fetch $distant $integration a échoué : la branche partirait d'une base périmée."
    base="$distant/$integration"
  fi
  git -C "$ARBRE_PRINCIPAL" worktree add -q -b "$branche" "$CHEMIN_B" "$base" \
    || refuser "création de l'arbre $CHEMIN_B impossible."
}

exclure() {
  local f="$COMMUN/info/exclude"
  mkdir -p "$COMMUN/info"
  touch "$f"
  if ! grep -qxF -- "$1" "$f"; then printf '%s\n' "$1" >>"$f"; fi
}

# Relie dans le second arbre ce qui n'est pas versionné et coûte cher à refaire (dépendances
# installées). Jamais vers une source absente, jamais par-dessus un vrai fichier.
poser_liens() {
  local lien source cible
  while IFS= read -r lien; do
    lien="${lien%/}"
    [[ -n "$lien" ]] || continue
    if [[ "$lien" == /* || "$lien" == *..* ]]; then
      echo "lien ignoré : « $lien » doit être un chemin relatif, à l'intérieur du dépôt"
      continue
    fi
    source="$ARBRE_PRINCIPAL/$lien"
    cible="$CHEMIN_B/$lien"
    if [[ -L "$cible" ]]; then continue; fi
    if [[ ! -e "$source" ]]; then
      echo "lien ignoré : $lien est absent de l'arbre principal"
      continue
    fi
    if [[ -e "$cible" ]]; then
      echo "lien ignoré : $lien existe déjà dans le second arbre, il n'est pas remplacé"
      continue
    fi
    mkdir -p "$(dirname "$cible")"
    ln -s "$source" "$cible"
    exclure "/$lien"
    echo "lien posé : $lien"
  done <<<"$(cfg_lignes .options.creneaux.liens)"
}

# --- commandes ---------------------------------------------------------------------------

ouvrir() {
  local story="" c="" perimetre="[]" donne=0 d story_d o pa pb interdit branche chemin tmp le
  while (( $# > 0 )); do
    case "$1" in
      --perimetre)
        [[ -n "${2:-}" ]] || usage
        perimetre="$(jq -c --arg g "$2" '. + [$g]' <<<"$perimetre")"
        donne=1
        shift 2
        ;;
      -*) usage ;;
      *)
        if [[ -z "$story" ]]; then
          story="$1"
        elif [[ -z "$c" && ( "$1" == "a" || "$1" == "b" ) ]]; then
          c="$1"
        else
          usage
        fi
        shift
        ;;
    esac
  done
  [[ -n "$story" ]] || usage
  [[ "$story" =~ ^[a-z0-9][a-z0-9-]*$ ]] || refuser "identifiant de story invalide : « $story » (minuscules, chiffres et tirets)."

  if [[ -z "$c" ]]; then
    for o in a b; do
      d="$(lire_descripteur "$o")" || exit 1
      if [[ -n "$d" && "$(jq -r '.story' <<<"$d")" == "$story" ]]; then c="$o"; fi
    done
  fi
  if [[ -z "$c" ]]; then c="$(creneau_courant)" || exit 1; fi
  [[ -n "$c" ]] || refuser "cet arbre de travail n'est ni l'arbre principal ni le créneau b déclaré : nommer le créneau (a ou b)."

  d="$(lire_descripteur "$c")" || exit 1
  story_d=""
  if [[ -n "$d" ]]; then story_d="$(jq -r '.story' <<<"$d")"; fi
  if [[ -n "$story_d" && "$story_d" != "$story" ]]; then
    refuser "créneau $c occupé par $story_d. Le fermer d'abord (creneaux.sh fermer $c), ou ouvrir $story dans le créneau $(autre "$c")."
  fi

  if (( donne == 0 )); then
    perimetre="$(node "$SCRIPTS/etat.mjs" lire "$story" perimetre 2>/dev/null | jq -c .)" \
      || refuser "périmètre inconnu : la story $story n'a pas encore d'état dans cet arbre. Le donner par --perimetre."
  fi
  if [[ "$(jq 'length' <<<"$perimetre")" == "0" || "$(jq 'map(select(. == "")) | length' <<<"$perimetre")" != "0" ]]; then
    refuser "périmètre vide : un créneau déclare les fichiers que sa story va toucher."
  fi

  pa="$(port_de a)"
  pb="$(port_de b)"
  if [[ "$c" == "b" ]]; then
    if [[ -n "$pa" && -z "$pb" ]]; then
      refuser "options.creneaux.ports.b n'est pas renseigné : deux bancs ne partagent pas le port $pa."
    fi
    if [[ -n "$pb" && "$pa" == "$pb" ]]; then
      refuser "les deux créneaux ont le même port ($pb) : en donner un autre à options.creneaux.ports.b."
    fi
    while IFS= read -r interdit; do
      if [[ -n "$interdit" && "$interdit" == "$pb" ]]; then
        refuser "le port $pb du créneau b est dans execution.ports_interdits."
      fi
    done <<<"$(cfg_lignes .execution.ports_interdits)"
  fi

  controler_croisement "$c" "$story" "$perimetre"

  branche="$(cfg .git.prefixe_branche)$story"
  chemin="$ARBRE_PRINCIPAL"
  if [[ "$c" == "b" ]]; then
    if [[ -n "$story_d" ]]; then
      chemin="$(jq -r '.chemin' <<<"$d")"
      [[ -d "$chemin" ]] || refuser "le second arbre $chemin a disparu. Fermer le créneau (creneaux.sh fermer b) puis le rouvrir."
    else
      creer_arbre_b "$branche"
      chemin="$(reel "$CHEMIN_B")"
    fi
    CHEMIN_B="$chemin"
    poser_liens
  fi

  le="$(maintenant)"
  if [[ -n "$story_d" ]]; then le="$(jq -r '.ouvert_le' <<<"$d")"; fi
  tmp="$(descripteur "$c").tmp-$$"
  jq -n --arg creneau "$c" --arg story "$story" --arg chemin "$chemin" --arg branche "$branche" \
    --argjson perimetre "$perimetre" --arg le "$le" \
    '{creneau: $creneau, story: $story, chemin: $chemin, branche: $branche, perimetre: $perimetre, ouvert_le: $le}' >"$tmp"
  mv "$tmp" "$(descripteur "$c")"

  if [[ -n "$story_d" ]]; then
    echo "créneau $c : périmètre de $story mis à jour ($(jq 'length' <<<"$perimetre") glob(s)), aucun croisement"
  elif [[ "$c" == "b" ]]; then
    echo "créneau b ouvert pour $story : $chemin (branche $branche${pb:+, port $pb})"
    echo "La story se mène depuis ce dossier : y ouvrir une session."
  else
    echo "créneau a ouvert pour $story${pa:+ (port $pa)}"
  fi
}

fermer() {
  local c="${1:-}" d chemin story branche sale distant integration n lien cible fiche pid
  local -a vrais=()
  [[ $# -eq 1 ]] || usage
  [[ "$c" == "a" || "$c" == "b" ]] || usage
  d="$(lire_descripteur "$c")" || exit 1
  if [[ -z "$d" ]]; then
    echo "créneau $c : déjà libre"
    return 0
  fi
  story="$(jq -r '.story' <<<"$d")"
  if [[ "$c" == "a" ]]; then
    rm -f -- "$(descripteur a)"
    echo "créneau a libéré ($story)"
    return 0
  fi

  chemin="$(jq -r '.chemin' <<<"$d")"
  branche="$(jq -r '.branche' <<<"$d")"
  if [[ ! -d "$chemin" ]]; then
    git -C "$ARBRE_PRINCIPAL" worktree prune
    rm -f -- "$(descripteur b)"
    echo "créneau b libéré ($story) : le second arbre $chemin n'existait plus"
    return 0
  fi
  if [[ "$ICI" == "$chemin" ]]; then
    refuser "le créneau b se ferme depuis l'arbre principal ($ARBRE_PRINCIPAL), pas depuis le dossier qu'il va retirer."
  fi

  sale="$(git -C "$chemin" status --porcelain)"
  if [[ -n "$sale" ]]; then
    echo "REFUS : le second arbre porte du travail non commité ($chemin) :" >&2
    head -n 10 <<<"$sale" | sed 's/^/  /' >&2
    exit 1
  fi
  distant="$(cfg .git.remote)"
  integration="$(cfg .git.branche_integration)"
  if [[ -n "$distant" ]] && distant_connu "$distant"; then
    n="$(git -C "$chemin" rev-list --count HEAD --not --remotes="$distant")"
    if [[ "$n" != "0" ]]; then
      refuser "$n commit(s) du second arbre ne sont sur aucune branche connue de $distant. Les pousser avant de fermer. (Branche déjà mergée puis supprimée du dépôt distant : retirer l'arbre à la main par git worktree remove, puis relancer cette commande.)"
    fi
  elif ! git -C "$chemin" merge-base --is-ancestor HEAD "$integration"; then
    refuser "le second arbre porte des commits absents de $integration, et le dépôt n'a pas de dépôt distant où les retrouver."
  fi
  fiche="$chemin/harness/.travail/banc.json"
  if [[ -f "$fiche" ]]; then
    pid="$(jq -r '.pid // empty' "$fiche" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      refuser "le banc du créneau b tourne encore (PID $pid). L'arrêter depuis $chemin : bash harness/scripts/banc.sh arreter"
    fi
  fi
  while IFS= read -r lien; do
    lien="${lien%/}"
    [[ -n "$lien" ]] || continue
    cible="$chemin/$lien"
    if [[ -e "$cible" && ! -L "$cible" ]] && ! git -C "$chemin" ls-files --error-unmatch -- "$lien" >/dev/null 2>&1; then
      vrais+=("$lien")
    fi
  done <<<"$(cfg_lignes .options.creneaux.liens)"
  if (( ${#vrais[@]} > 0 )); then
    refuser "dans le second arbre, ceci est un vrai fichier ou dossier et non un lien : ${vrais[*]}. Le retirer à la main avant de fermer (il serait effacé sans prévenir)."
  fi

  # Les liens d'abord, un par un et par leur nom : on ne retire que ce qu'on a posé, et
  # jamais ce vers quoi le lien pointe.
  while IFS= read -r lien; do
    lien="${lien%/}"
    [[ -n "$lien" ]] || continue
    if [[ -L "$chemin/$lien" ]]; then unlink "${chemin:?}/${lien:?}"; fi
  done <<<"$(cfg_lignes .options.creneaux.liens)"
  git -C "$ARBRE_PRINCIPAL" worktree remove "$chemin" \
    || refuser "git n'a pas voulu retirer $chemin (voir son message ci-dessus). Rien d'autre n'a été touché."
  rm -f -- "$(descripteur b)"
  echo "créneau b fermé ($story) : $chemin retiré, la branche $branche est conservée"
}

verifier() {
  local c="${1:-}" d story chemin base distant integration socle liste touches specs etats index g f n
  local -a globs regexes=() hors=()
  [[ $# -le 1 ]] || usage
  if [[ -z "$c" ]]; then c="$(creneau_courant)" || exit 1; fi
  [[ "$c" == "a" || "$c" == "b" ]] || refuser "cet arbre de travail n'est ni l'arbre principal ni le créneau b déclaré : nommer le créneau (a ou b)."
  d="$(lire_descripteur "$c")" || exit 1
  if [[ -z "$d" ]]; then
    echo "créneau $c : libre, rien à vérifier"
    return 0
  fi
  story="$(jq -r '.story' <<<"$d")"
  chemin="$(jq -r '.chemin' <<<"$d")"
  [[ -d "$chemin" ]] || refuser "l'arbre du créneau $c a disparu : $chemin."
  distant="$(cfg .git.remote)"
  integration="$(cfg .git.branche_integration)"
  base="$integration"
  if [[ -n "$distant" ]] && distant_connu "$distant"; then base="$distant/$integration"; fi
  socle="$(git -C "$chemin" merge-base "$base" HEAD)" || refuser "aucun ancêtre commun entre $base et la branche du créneau $c."

  # Tout ce que la branche a touché : commité, en cours, et pas encore suivi.
  # --no-renames : un fichier pris hors du périmètre et DÉPLACÉ dedans ne paraîtrait sinon que
  # sous sa destination, et sa disparition chez l'autre créneau passerait.
  touches="$( { git -C "$chemin" diff --no-renames --name-only "$socle"; git -C "$chemin" ls-files --others --exclude-standard; } | sort -u)"
  if [[ -z "$touches" ]]; then
    echo "créneau $c ($story) : aucun fichier touché"
    return 0
  fi
  TOUS_FICHIERS="$(git -C "$chemin" ls-files)"$'\n'"$touches"
  liste="$(jq -r '.perimetre[]' <<<"$d")" || exit 1
  mapfile -t globs <<<"$liste"
  for g in "${globs[@]}"; do
    [[ -n "$g" ]] || continue
    regexes+=("$(glob_vers_regex "$g")")
  done
  specs="$(cfg .chemins.specs)"
  etats="$(cfg .chemins.etat)"
  index=""
  if [[ "$(cfg .options.note_story.actif)" == "true" ]]; then index="$(cfg .options.note_story.index)"; fi
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if [[ "$f" == "$specs/$story/"* || "$f" == "$etats/$story.json" || "$f" == "$index" ]]; then continue; fi
    n=0
    for g in "${regexes[@]}"; do
      if grep -Eq -- "$g" <<<"$f"; then
        n=1
        break
      fi
    done
    if (( n == 0 )); then hors+=("$f"); fi
  done <<<"$touches"
  if (( ${#hors[@]} > 0 )); then
    echo "REFUS : ${#hors[@]} fichier(s) touché(s) hors du périmètre déclaré de $story (créneau $c) :" >&2
    printf '  - %s\n' "${hors[@]:0:20}" >&2
    if (( ${#hors[@]} > 20 )); then echo "  (et $(( ${#hors[@]} - 20 )) autre(s))" >&2; fi
    echo "Les déclarer (etat.mjs ecrire puis creneaux.sh ouvrir $story), ou revenir dessus." >&2
    exit 1
  fi
  echo "créneau $c ($story) : $(grep -c . <<<"$touches") fichier(s) touché(s), tous dans le périmètre déclaré"
}

etat() {
  local c d p a b
  if [[ "${1:-}" == "--json" ]]; then
    a="$(lire_descripteur a)" || exit 1
    b="$(lire_descripteur b)" || exit 1
    jq -n --argjson a "${a:-null}" --argjson b "${b:-null}" '{a: $a, b: $b}'
    return 0
  fi
  [[ $# -eq 0 ]] || usage
  for c in a b; do
    d="$(lire_descripteur "$c")" || exit 1
    p="$(port_de "$c")"
    if [[ -z "$d" ]]; then
      echo "créneau $c : libre"
    else
      jq -r --arg c "$c" --arg p "$p" \
        '"créneau \($c) : \(.story) · \(.chemin) · \(.perimetre | length) glob(s)" + (if $p == "" then "" else " · port \($p)" end) + " · ouvert le \(.ouvert_le)"' <<<"$d"
    fi
  done
}

port() {
  local c="${1:-}"
  if [[ -z "$c" ]]; then c="$(creneau_courant)" || exit 1; fi
  [[ -n "$c" ]] || refuser "cet arbre de travail n'est ni l'arbre principal ni le créneau b déclaré : pas de port pour lui."
  [[ "$c" == "a" || "$c" == "b" ]] || usage
  port_de "$c"
  echo
}

ACTION="${1:-}"
[[ -n "$ACTION" ]] || usage
shift
case "$ACTION" in
  ouvrir|fermer)
    # Deux sessions peuvent déclarer en même temps : une seule à la fois lit puis écrit.
    if [[ "${CRENEAUX_SOUS_VERROU:-}" != "1" ]]; then
      export CRENEAUX_SOUS_VERROU=1
      code=0
      verrou creneaux bash "${BASH_SOURCE[0]}" "$ACTION" "$@" || code=$?
      exit "$code"
    fi
    "$ACTION" "$@"
    ;;
  etat) etat "$@" ;;
  verifier) verifier "$@" ;;
  port) [[ $# -le 1 ]] || usage; port "$@" ;;
  *) usage ;;
esac
