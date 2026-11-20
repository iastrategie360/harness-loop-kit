#!/usr/bin/env bash
# mistral-securite.sh : la relecture SÉCURITÉ d'une PR, par un second service (option mistral).
#
# Elle s'ajoute à la review de code (review-pr-locale.sh), jamais à sa place. Son mandat est
# ÉTROIT : les failles de sécurité, rien d'autre. Pas de style, pas de lisibilité : la review de
# code couvre le reste. Un second modèle d'un autre fournisseur, chargé d'une seule question,
# trouve ce que la review générale laisse passer.
#
# Elle produit un ARTEFACT COMMITÉ DISTINCT de celui de la review de code, lu par la MÊME gate :
#   <specs>/<id>/review-securite.json  (même format que review-pr.json), et son .md généré ;
#   hors story : <reviews>/<branche assainie>.securite.json et .md.
# Deux artefacts et non un seul : la fusion ferme d'elle-même un finding absent d'une re-review,
# donc une relecture sécurité propre fermerait les findings ouverts de la review de code (voir
# cheminArtefactSecurite dans lib/review-pr-artefact.mjs). La gate rend 3 tant qu'il manque.
#
# Le diff est DÉCOUPÉ EN LOTS (lib/decoupe-diff.mjs) : un prompt est un argument unique, borné
# par le système, et un diff tronqué ferait conclure « propre » sur un préfixe. Chaque lot part
# dans une session distincte ; un seul lot sans réponse, et rien n'est écrit.
#
# SÉQUENCEMENT : APRÈS review-pr-locale.sh, jamais en même temps. Celle-ci écrit son artefact
# dans l'arbre à la fin de sa course ; le contrôle d'empreinte de cette relecture le prendrait
# pour une écriture de Mistral. Les deux scripts prennent le même verrou des relecteurs.
#
# Usage : mistral-securite.sh <story-id>
#         mistral-securite.sh --branche        (branche sans dossier de story)
# Variables : MISTRAL_REPRISE=1 ne relance que les lots sans réponse, sur un instantané
#   identique ; MISTRAL_SECURITE_EXCLURE remplace options.mistral.exclusions (motifs séparés
#   par des espaces) ; les autres surcharges sont dans mistral-commun.sh.
# Codes : 0 relecture menée et artefact écrit (le VERDICT est rendu par review-locale.mjs) ;
#         1 relecture NON aboutie (un lot en échec, budget, clé, accord) : AUCUN artefact écrit,
#           la gate reste à 3 ; 5 le relecteur a écrit ; 64 usage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/mistral-commun.sh"
relecteur_sous_verrou "${BASH_SOURCE[0]}" "$@"

CIBLE="${1:-}"
if [[ -z "$CIBLE" || $# -gt 1 ]]; then
  echo "usage : mistral-securite.sh <story-id> | --branche" >&2
  exit 64
fi
mistral_preparer

BRANCHE="$(git -C "$RACINE" rev-parse --abbrev-ref HEAD)"
[[ "$BRANCHE" != "HEAD" ]] || refuser "HEAD détaché : la relecture sécurité se lance depuis la branche de la story."
BASE="$(cfg .git.branche_integration)"
[[ "$BRANCHE" != "$BASE" && "$BRANCHE" != "$(cfg .git.branche_production)" ]] \
  || refuser "tu es sur « $BRANCHE » : la relecture sécurité se lance depuis la branche de la story."

SPECS="$(cfg .chemins.specs)"
ETAT="$(cfg .chemins.etat)"
REVIEWS="$(cfg .chemins.reviews)"
NOM="$(printf '%s' "$BRANCHE" | tr -c 'A-Za-z0-9._-' '_')"
if [[ "$CIBLE" == "--branche" ]]; then
  ARTEFACT_CODE="$REVIEWS/$NOM.json"
  ARTEFACT="$REVIEWS/$NOM.securite.json"
else
  [[ "$CIBLE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || refuser "identifiant de story invalide : $CIBLE"
  [[ -d "$RACINE/$SPECS/$CIBLE" ]] || refuser "dossier de story introuvable : $SPECS/$CIBLE (pour une branche sans story : --branche)"
  ARTEFACT_CODE="$SPECS/$CIBLE/review-pr.json"
  ARTEFACT="$SPECS/$CIBLE/review-securite.json"
fi

# Une relecture qui certifie ne se fait pas contre une base périmée : rafraîchissement bloquant.
BASE_REF="$(codex_base_ref --bloquant)" || exit 1
if git -C "$RACINE" diff --quiet "$BASE_REF"...HEAD; then
  echo "ERREUR : aucun diff commité entre $BASE_REF et $BRANCHE. Rien à relire, donc rien à certifier." >&2
  exit 1
fi
# L'artefact certifie HEAD, et le relecteur lit l'arbre de travail : les deux doivent être le même
# objet. Passent seulement l'état et les deux artefacts de review, qui ne sont pas du code.
NON_COMMITES="$(git -C "$RACINE" status --porcelain --untracked-files=no -- . ":(exclude)$ETAT" \
  ":(exclude)$ARTEFACT" ":(exclude)${ARTEFACT%.json}.md" ":(exclude)$ARTEFACT_CODE" ":(exclude)${ARTEFACT_CODE%.json}.md")"
if [[ -n "$NON_COMMITES" ]]; then
  printf '%s\n' "$NON_COMMITES" | sed -n '1,20p' >&2
  refuser "des fichiers suivis sont modifiés sans être commités (ci-dessus). Commite d'abord : l'artefact certifie le commit courant."
fi
HEAD_SHA="$(git -C "$RACINE" rev-parse HEAD)"

DOSSIER="$MISTRAL_TRAVAIL/securite-$NOM"
mkdir -p "$DOSSIER"
DIFF="$DOSSIER/branche.diff"
# --no-renames : un fichier relu DÉPLACÉ vers un chemin exclu (du code renommé en .md) ne paraîtrait
# que sous son nouveau nom, exclu, et disparaîtrait de la relecture. Sans détection, sa suppression
# sous l'ancien nom reste dans un lot.
if ! git -C "$RACINE" -c core.quotePath=false diff --no-renames "$BASE_REF...$HEAD_SHA" > "$DIFF" 2>/dev/null; then
  echo "ERREUR : git diff a échoué ($BASE_REF...$HEAD_SHA)." >&2
  exit 1
fi
# Un diff qui touche un chemin INTERDIT (secret du profil livré ou chemin exclu du projet, ou leur
# copie ou déplacement, --find-copies-harder compris) ne part jamais : une seule liste, la même que
# celle des outils de vibe. -z partout : avec core.quotePath, « déploiement/.env » sortirait cité.
mistral_exclusions_charger "$BASE_REF" || refuser "contrôle des chemins interdits impossible : la relecture n'est pas lancée."
mistral_interdits_du_diff "$BASE_REF" || refuser "contrôle des chemins interdits impossible : la relecture n'est pas lancée."
if ((${#MISTRAL_TROUVES[@]} > 0)); then
  printf '  %s\n' "${MISTRAL_TROUVES[@]}" >&2
  refuser "le diff touche un fichier de secrets ou un chemin exclu, ou en porte une copie (ci-dessus) : il partirait chez Mistral. Retire-le de la branche ; la relecture n'est pas lancée."
fi

# Exclusions : ce que le projet a déclaré sans effet sur le comportement (options.mistral.exclusions),
# plus ce que le harness écrit lui-même : les états de story et les artefacts de review. Ils sont
# NOMMÉS dans l'artefact, jamais retirés en silence.
EXCLURE=()
if [[ -n "${MISTRAL_SECURITE_EXCLURE:-}" ]]; then
  read -r -a EXCLURE <<< "$MISTRAL_SECURITE_EXCLURE"
else
  while IFS= read -r motif; do [[ -n "$motif" ]] && EXCLURE+=("$motif"); done < <(cfg_lignes .options.mistral.exclusions)
fi
EXCLURE+=("${ETAT%/}/**" "${REVIEWS%/}/**" "$SPECS/*/review-pr.json" "$SPECS/*/review-pr.md" "$SPECS/*/review-securite.json" "$SPECS/*/review-securite.md")
args=()
for g in "${EXCLURE[@]}"; do args+=(--exclure "$g"); done
mistral_decouper "$DIFF" "$DOSSIER/lots" "${args[@]}" || exit 1

INDEX="$DOSSIER/lots/index.json"
SCHEMA="$SCHEMAS/review-pr-cli.json"
PROJET_NOM="$(cfg .projet.nom)"
PROJET_DESCRIPTION="$(cfg .projet.description)"

# prompt_securite <lot> <rang> <total> <fichiers> : le contrat de sortie EN TÊTE, le lot en dernier.
prompt_securite() {
  local lot="$1" i="$2" n="$3" fichiers="$4"
  cat <<EOF
Tu es un auditeur de SÉCURITÉ applicative, adversarial et précis, pour le projet « $PROJET_NOM » ($PROJET_DESCRIPTION).
Le contexte du projet (domaine, utilisateurs, pièges) est dans harness/PROJET.md, que tu peux lire.
Tu relis le diff d'une PR AVANT sa fusion. Un autre relecteur couvre la correction générale :
TOI, tu ne cherches QUE des failles de sécurité.

AXES À COUVRIR, pour chaque fichier du lot :
1. Accès et identité : qui peut appeler quoi ; une route, une commande ou une fonction exposée sans contrôle ; une identité prise dans un paramètre fourni par l'appelant au lieu de la session.
2. Contrôle d'autorisation côté serveur : un droit vérifié seulement dans l'interface, un rôle ou une propriété de l'objet jamais revérifiés là où l'action s'exécute ; un identifiant d'objet deviné qui donne accès à celui d'un autre.
3. Isolation entre clients : une requête, un cache, un fichier ou une file qui ne filtre pas sur le client, l'organisation ou l'utilisateur ; une fuite d'un client vers un autre.
4. Privilèges en base : un droit accordé trop large, une fonction ou une vue qui s'exécute avec les droits de son propriétaire sans revalider l'appelant, une politique d'accès qui laisse tout passer, une table d'audit inscriptible.
5. Secrets : une clé ou un mot de passe en dur, dans un journal, un message d'erreur, ou dans le code envoyé au navigateur ; une variable réservée au serveur lue côté client.
6. Données personnelles : un nom, une adresse, un enregistrement exposés à un tiers ou à un autre client, journalisés en clair, renvoyés sans besoin.
7. Injection : requête construite par concaténation, commande shell construite avec une entrée, chemin de fichier tiré d'une entrée, HTML injecté sans échappement, en-tête ou adresse non validés, entrée non validée à la frontière.
8. Chemins d'argent : paiement, crédit, remboursement, webhook (signature, idempotence, rejeu), montant ou quantité fournis par le client, course entre deux débits.

SÉVÉRITÉ : P0 = exploitable maintenant (fuite entre clients, élévation de privilège, argent créé ou détourné, secret exposé) ; P1 = faille sérieuse sous une condition plausible ; P2 = défaut de sécurité à corriger avant la fusion (une défense manque sur un chemin réel) ; P3 = durcissement.
N'invente RIEN pour meubler : zéro finding est une réponse valable et attendue sur un lot sans surface de sécurité. Un finding cite un fichier et une ligne du lot. Vérifie dans le dépôt (read_file, grep) avant d'affirmer qu'une garde manque : elle peut vivre ailleurs.
$MISTRAL_CONSIGNE_OUTILS
$(codex_consignes)

CONTRAT DE SORTIE (impératif) : termine ta réponse par UNIQUEMENT un bloc \`\`\`json, et RIEN après, contenant exactement :
{"findings": [{"priority": "P0|P1|P2|P3", "title": "titre court", "body": "la faille, le scénario d'exploitation, le correctif minimal", "file": "chemin relatif à la racine du dépôt", "line_start": 1, "line_end": 1}], "overall_explanation": "ce que tu as relu, en deux phrases"}
line_start et line_end sont des entiers : les numéros de ligne du fichier après le diff.

Le diff ($BASE_REF...${HEAD_SHA:0:7}) est relu en $n lots, chacun par une session distincte. Tu relis le LOT $i SUR $n, ci-dessous en entier. Il couvre :
$fichiers

--- DÉBUT DU LOT $i SUR $n ---
$(cat "$lot")
--- FIN DU LOT $i SUR $n ---
Rappel : termine par le bloc json du contrat.
EOF
}

echo "mistral-securite : relecture de $BRANCHE ($BASE_REF...${HEAD_SHA:0:7}, modèle $MISTRAL_REVIEW_MODEL)..." >&2
debut=$(date +%s)
NB_LOTS="$(jq '.lots | length' "$INDEX")"
EXCLUS="$(jq -r 'if (.exclus | length) == 0 then "aucun" else (.exclus | join(", ")) end' "$INDEX")"
FUSION="$DOSSIER/fusion.json"
ATTESTATION="$DOSSIER/attestation.json"
rm -f "$FUSION" "$ATTESTATION"
JSONS=()

if [[ "$NB_LOTS" -eq 0 ]]; then
  # Diff ENTIÈREMENT exclu (une PR de documentation seule). Ce n'est pas un échec : rien dans le
  # diff ne change un comportement. On écrit donc un artefact EXPLICITE à zéro finding, qui le dit
  # et nomme chaque fichier exclu, plutôt que de laisser la gate à 3 pour toujours. Le diff est non
  # vide (contrôlé plus haut) : ce cas ne peut pas naître d'une base introuvable.
  cout=0
  duree=0
  jq -n --arg exclus "$EXCLUS" --arg modele "$MISTRAL_REVIEW_MODEL" \
    '{findings: [], overall_explanation: ("Aucun fichier à relire pour la sécurité (" + $modele + ") : tous les fichiers du diff sont exclus par nature. Exclus : " + $exclus + ".")}' \
    > "$FUSION"
else
  rc=0
  mistral_lots "$DOSSIER/lots" prompt_securite || rc=$?
  if ((rc != 0)); then
    echo "ERREUR : relecture sécurité incomplète : AUCUN artefact écrit, la gate reste bloquante." >&2
    exit "$rc"
  fi
  # Chaque lot doit rendre un JSON conforme au schéma : un lot illisible, relecture non aboutie.
  mapfile -t LOTS < <(jq -r '.lots[].chemin' "$INDEX")
  for lot in "${LOTS[@]}"; do
    if ! mistral_extraire_json "$lot.raw" "$lot.json" "$SCHEMA"; then
      # Le lot n'est PAS réutilisable : sans ce retrait, une reprise sauterait ce lot et
      # revaliderait sans fin la même réponse invalide.
      rm -f "$lot.ok"
      echo "ERREUR : lot $(basename "$lot") : réponse non conforme, AUCUN artefact écrit." >&2
      exit 1
    fi
    JSONS+=("$lot.json")
  done
  duree=$(($(date +%s) - debut))
  cout="$(mistral_cout "${LOTS[@]/%/.raw}")"
  jq -s --arg entete "Relecture sécurité Mistral ($MISTRAL_REVIEW_MODEL), ${#LOTS[@]} lot(s), coût $cout USD, ${duree} s. Exclus : $EXCLUS." \
    '{findings: (map(.findings) | add // []),
      overall_explanation: ([$entete] + (to_entries | map("Lot \(.key + 1) : \(.value.overall_explanation)")) | join("\n\n"))}' \
    "${JSONS[@]}" > "$FUSION"
fi

# L'attestation : ce que CE script a constaté, lot par lot (les réponses validées contre le
# schéma). C'est la preuve que la fusion exige pour croire une relecture sans finding : un
# relecteur sans flux d'événements n'en a pas d'autre.
jq --argjson relus "${#JSONS[@]}" '{relecteur: "mistral", lots_total: (.lots | length), lots_relus: $relus, exclus: .exclus, fichiers: .fichiers}' \
  "$INDEX" > "$ATTESTATION"

node "$SCRIPTS/review-pr-fusionner.mjs" \
  --artefact "$RACINE/$ARTEFACT" --brut "$FUSION" \
  --head-sha "$HEAD_SHA" --branche "$BRANCHE" --base "$BASE" \
  --modele "mistral:$MISTRAL_REVIEW_MODEL" --racine "$RACINE" \
  --source securite --attestation "$ATTESTATION" || exit 1

echo "mistral-securite : terminé ($(jq '.findings | length' "$FUSION") finding(s), coût $cout USD, ${duree} s)."
echo "À commiter avec la branche : $ARTEFACT et ${ARTEFACT%.json}.md"
if [[ "$CIBLE" == "--branche" ]]; then
  echo "Verdict : node harness/scripts/review-locale.mjs $ARTEFACT_CODE"
else
  echo "Verdict : node harness/scripts/review-locale.mjs $CIBLE"
fi
