# Le questionnaire d'installation

Ce fichier est la SEULE source des questions que pose `/harness-install`. Il sert à deux
lecteurs :

- **toi, avant l'installation** : parcours-le pour savoir ce qu'on va te demander et préparer
  ce que tu ne sais pas de tête (le nom de la branche de production, la commande exacte des
  tests longs, l'endroit où vit le secret de ton canal d'alerte) ;
- **l'installateur, pendant** : il le lit lot par lot, cherche d'abord la réponse dans le
  dépôt, puis te la propose.

## Les règles du jeu

1. **Une question, une clé.** Chaque réponse va dans une clé de `harness/projet.json`, ou
   dans une section de `harness/PROJET.md` (les questions de prose). Rien n'est retenu
   ailleurs.
2. **Chercher avant de demander.** L'installateur propose en premier ce qu'il a trouvé dans
   le dépôt, en disant OÙ il l'a trouvé. Une proposition sans source est une supposition, et
   elle se présente comme telle.
3. **« Je ne sais pas » est une réponse.** Elle vaut `null` ou la valeur par défaut, et la
   question revient dans le compte rendu, à la rubrique « reste à compléter ». Une valeur
   inventée pour faire avancer est le pire résultat possible.
4. **Jamais la valeur d'une variable d'environnement.** L'installateur relève des NOMS de
   variables et des NOMS de fichiers. Si une réponse demande un secret, c'est que la question
   est mal comprise : le secret reste dans un fichier hors du dépôt, on ne donne que son
   chemin.
5. **Quatre questions au plus à la fois.** Un lot peut prendre deux tours.
6. **Rien n'est tenu pour vrai sans preuve.** Une commande déclarée ici n'est qu'une
   déclaration. Elle est lancée à l'étape de preuve, et c'est son résultat qui est noté.

Les valeurs par défaut sont celles de `projet.exemple.json`, dans le noyau du kit : c'est lui
qui fait foi si ce document et lui divergent.

## Lot A : l'identité

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| A1 | Comment s'appelle le projet ? | `projet.nom` | le manifeste (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`), sinon le nom du dossier |
| A2 | En une phrase : que fait le produit, et pour qui ? | `projet.description` | la description du manifeste, le premier paragraphe du README |
| A3 | Qui franchit les gates humaines ? Un prénom ou un rôle. | `projet.approbateur` | `git config user.name` |
| A4 | Dans quelle langue s'écrivent les specs, les commits et les commentaires ? | `projet.langue` | la langue du README et des trente derniers messages de commit |

A3 compte plus qu'il n'y paraît : c'est le nom que le harness écrit quand il dit « seul
`<approbateur>` peut trancher ». Une seule personne, ou un rôle tenu par une seule personne à
la fois.

## Lot B : Git

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| B1 | Quelle branche reçoit les PR des stories ? | `git.branche_integration` | `git symbolic-ref --short refs/remotes/<remote>/HEAD`, la branche par défaut de la forge |
| B2 | Y a-t-il une branche de production distincte, que seul l'approbateur fait avancer ? | `git.branche_production` (`null` si c'est la même, ou s'il n'y en a pas) | les branches distantes nommées `production`, `prod`, `release`, `stable` ; la branche que déploie la CI |
| B3 | Quel dépôt distant, sur quelle forge ? | `git.remote`, `git.forge` (`github`, `gitlab`, `aucune`) | `git remote -v` |
| B4 | Quel préfixe pour les branches de story, et quel format de message de commit ? | `git.prefixe_branche`, `git.format_commit` | les noms des branches existantes, les trente derniers messages |

Avec `forge: gitlab` ou `aucune`, le harness n'ouvre pas la PR lui-même : il en donne le
texte et s'arrête. Tout le reste fonctionne.

Un dépôt sans dépôt distant convient aussi : garde `origin` à B3 avec `forge: aucune`. Les
scripts constatent l'absence et travaillent sur les branches locales, rien n'est poussé.

À B4, un dépôt de moins de dix commits n'a pas d'usage à relever : les valeurs de l'exemple
sont proposées telles quelles.

## Lot C : les commandes de vérification

Pour chacune : la commande exacte, telle qu'on la tape à la racine du dépôt. `null` si le
projet n'en a pas, et c'est une réponse honnête.

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| C1 | Comment installe-t-on les dépendances ? | `commandes.installer` | le fichier de verrouillage présent, le README, la première étape de la CI |
| C2 | Quelles vérifications statiques (types, lint, format) ? Une commande par vérification, chacune avec un nom court. | `commandes.statique[]` | les scripts du manifeste, les cibles du `Makefile` ou du `justfile`, les étapes de la CI |
| C3 | Quels sont les tests rapides, ceux qu'on lance après chaque tâche ? | `commandes.tests` | idem ; la CI dit ce qui tourne VRAIMENT |
| C4 | Y a-t-il des tests longs (bout en bout, intégration), lancés une fois avant la PR ? | `commandes.tests_longs` | idem |

La CI est la meilleure source : un script du manifeste peut être mort depuis un an, une
étape de CI verte tourne à chaque push.

Si une commande échoue DÉJÀ aujourd'hui, dis-le. Elle sera enregistrée avec
`base_rouge: true` : le harness saura qu'un rouge ne prouve pas une régression, et te le
rappellera au lieu de faire comme si de rien n'était.

## Lot D : faire tourner le produit

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| D1 | Quel genre de produit ? | `execution.type` (`web`, `api`, `cli`, `bibliotheque`, `mobile`, `autre`) | le manifeste, la structure du dépôt |
| D2 | Y a-t-il une étape de build, et laquelle ? | `commandes.build` | les scripts du manifeste, la CI |
| D3 | Comment lance-t-on le produit en local, et sur quel port ? | `commandes.demarrer`, `execution.port` | le script de développement, la configuration du serveur |
| D4 | Comment sait-on qu'il répond ? | `commandes.sante` | une route de santé, sinon la page d'accueil |
| D5 | Comment l'arrête-t-on ? | `commandes.arreter` (`null` = par le PID exact noté au démarrage, c'est le bon défaut) | |
| D6 | Comment obtient-on le rendu réel d'un écran ou d'une sortie, dans un fichier ? | `commandes.capture` | un outil de test de navigateur déjà installé, sinon rien |

Trois contraintes sur ces commandes :

- `demarrer` et `sante` reçoivent le port dans la variable `PORT`. Une commande qui porte un
  numéro de port en dur empêche le banc de changer de port : écris `--port "$PORT"`.
- `capture` reçoit `PORT`, la cible dans `HARNESS_CIBLE` (un chemin d'URL, un nom de
  commande, ce qui a du sens pour le produit) et doit ÉCRIRE son résultat dans le fichier
  `$HARNESS_SORTIE`. Une capture qui rend 0 sans rien écrire est comptée comme un échec.
- Une bibliothèque ou un outil sans serveur n'a ni `demarrer` ni `sante` : `null` aux deux.
  Sa « capture » peut être la sortie d'une commande d'exemple, redirigée dans
  `$HARNESS_SORTIE`.

Sans `capture`, le stage REGARD (montrer le rendu réel avant la gate de merge) ne peut pas
avoir lieu. Le harness le dira à chaque story visible par un utilisateur, plutôt que de
remplacer le rendu par la lecture d'un diff.

## Lot E : les garde-fous

Ce lot décide de ce que le harness ne pourra jamais faire sur cette machine. Prends le temps.

À E1, la liste ne reçoit que les ports de services durables qu'un banc pourrait heurter (un
autre produit, une base, un proxy), pas tout ce qui écoute à cet instant. `harness/projet.json`
est commité : y recopier la carte complète de la machine la publierait pour rien. Un projet
sans commande de démarrage n'a pas de banc : liste vide.

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| E1 | Quels ports de cette machine appartiennent à d'autres services ? | `execution.ports_interdits` | les ports en écoute (`ss -ltn`), les fichiers de composition de services |
| E2 | Quelles variables d'environnement désignent une cible (base, API, stockage) qui pourrait être la production ? | `execution.garde_prod.variables` (des NOMS) | les noms relevés dans les fichiers d'environnement, ceux lus par le code |
| E3 | Dans quels fichiers ces variables sont-elles définies ? | `execution.garde_prod.fichiers` | les fichiers `.env*` présents à la racine |
| E4 | À quoi reconnaît-on une cible de production ? Un ou plusieurs motifs (expressions régulières) qui ne correspondent QU'À elle. | `execution.garde_prod.motifs_interdits` | rien : c'est toi qui le sais |
| E5 | Quelles commandes le harness ne doit-il jamais lancer ? | `execution.commandes_interdites` | les scripts de déploiement, de migration distante, de remise à zéro |
| E6 | Y a-t-il des services partagés avec d'autres projets ou d'autres personnes (conteneurs, base commune, compte de test) ? | prose : `harness/PROJET.md`, « Les environnements » et « Les pièges connus » | les fichiers de composition, la CI |

Sur E4 : tu donnes un motif, par exemple le nom d'hôte de la production. L'installateur ne
lit pas la valeur de la variable pour le deviner, et le harness ne l'affichera jamais. Avant
chaque démarrage du banc, `banc.sh` compare et refuse si une variable contrôlée vise une
cible interdite.

Si E2 à E4 restent vides, le banc démarre sans garde. C'est acceptable pour un projet qui n'a
pas de production. Pour les autres, c'est le premier point du compte rendu.

## Lot F : la rigueur

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| F1 | Quelles parties du dépôt ne pardonnent pas l'erreur ? Pour chacune : un nom, des chemins, une phrase qui dit ce qui casse. | `rigueur.declencheurs[]` | les dossiers de migrations, d'authentification, de paiement, d'infrastructure, les workflows de CI |
| F2 | Quels chemins sont interdits au harness sans ton accord écrit ? | `perimetres_interdits[]` (chemins et raison) | les textes légaux, la licence, les migrations déjà appliquées, la configuration de production |
| F3 | Le budget d'une story en rigueur légère te convient-il ? | `rigueur.budget_legere` (pages de spec, exigences, tâches) | le défaut de l'exemple |
| F4 | La spec doit-elle toujours attendre ta lecture avant le plan, ou seulement quand le relecteur la conteste ? | `gates.spec` (`humaine` ou `auto`) | le défaut est `auto` |

F1 est le réglage qui compte le plus pour le coût : une story ne passe en rigueur complète
que si elle touche un de ces chemins. Trop de déclencheurs, et chaque page de texte coûte le
prix d'une migration. Aucun, et une migration passe comme une page de texte. Vise trois à
six, sur des chemins précis.

La gate de merge, elle, n'est pas un réglage : `gates.merge` vaut toujours `humaine`.

## Lot G : les documents

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| G1 | Où vivent les specs des stories ? | `chemins.specs` | un dossier `specs/`, `docs/stories/`, `docs/specs/` existant |
| G2 | Quels documents un agent doit-il lire avant d'écrire ? | `chemins.contexte[]` | `README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`, un dossier d'ADR |
| G3 | Y a-t-il un backlog tenu dans le dépôt ? | `chemins.backlog` | `BACKLOG.md`, `TODO.md`, `ROADMAP.md` |
| G4 | Quels documents de suivi changent sans que le code change ? | `chemins.narratifs[]` | un journal des changements, un fichier de statut |
| G5 | Quelles règles d'écriture s'imposent à tout ce que produit le harness ? | `projet.regles_style[]` | les conventions écrites dans les documents de contexte |

Sur G2 : court vaut mieux que complet. Chaque agent lit ces fichiers à chaque appel. Trois
documents justes valent mieux que quinze dont cinq sont périmés.

Sur G4 : modifier un de ces fichiers après la review de PR ne la périme pas. Ils se nomment
un par un, jamais par joker : un joker finirait par couvrir un fichier de code.

`chemins.etat` et `chemins.reviews` gardent leur valeur par défaut, sauf conflit avec un
dossier existant.

## Lot H : le relecteur

Le relecteur est un second modèle, appelé par le CLI `codex` en lecture seule. Il relit la
spec, le plan, le diff et la PR.

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| H1 | Acceptes-tu que le code de ce dépôt soit envoyé au fournisseur du relecteur ? | `relecteur.accord_envoi_externe` | rien : c'est ta décision, et parfois celle de ton client ou de ton employeur |
| H2 | Y a-t-il des chemins que le relecteur a pour consigne de ne pas ouvrir ? | `relecteur.chemins_exclus[]` | les dossiers de données, d'exports, de fixtures réelles |
| H3 | Quel modèle et quel niveau d'effort ? | `relecteur.modele` (`null` = celui du CLI), `relecteur.effort` (`low`, `medium`, `high`) | le défaut de l'exemple |
| H4 | Les délais par défaut conviennent-ils ? | `relecteur.delais_s` (`court`, `diff`, `pr`, en secondes) | le défaut ; à allonger pour un gros dépôt |

Sur H1 : si la réponse est non, l'installation se termine quand même, mais aucun script de
relecture ne démarrera, et le harness perd ce qui fait sa valeur (un second regard qui ne
partage pas les angles morts du premier). Mieux vaut le savoir maintenant.

Sur H2 : avec l'option `mistral`, un motif doit avoir un seul sens pour tous les outils : des
segments entiers (`secrets/`, `**/fixtures/**`, `private/**`, `a/*`) ou une extension seule
(`*.pem`). Un joker mêlé à du texte (`private*.json`, `docs/*.md`) ou placé au milieu (`a/*/b`)
est refusé, avec la façon de le réécrire.

Sur H2 : c'est une **consigne**, pas une barrière. Le relecteur lit l'arbre de travail, et
rien ne l'empêche techniquement d'ouvrir un fichier. Deux protections réelles existent : une
review de diff refuse de partir si le diff touche un de ces chemins, et un fichier qui ne
doit jamais sortir de la machine ne doit pas se trouver dans l'arbre de travail.

## Lot I : la boucle et les alertes

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| I1 | Les bornes de la boucle par défaut conviennent-elles ? | `boucle.max_tours`, `boucle.echecs_consecutifs`, `boucle.seuil_escalade_rounds`, `boucle.seuil_survie` | le défaut de l'exemple |
| I2 | Par quel canal veux-tu être prévenu quand une décision t'attend ? | `notification.commande` (`null` = aucun, journal seul) | un script d'alerte déjà présent sur la machine |
| I3 | Où vit le secret de ce canal ? Un fichier HORS du dépôt. | `notification.fichier_env` | rien : donne le chemin, pas le contenu |
| I4 | Combien d'heures avant de répéter une même alerte ? | `notification.anti_repetition_h` | le défaut |

Sur I2 : la commande reçoit trois variables, `HARNESS_SUJET`, `HARNESS_CORPS` et
`HARNESS_NIVEAU` (`gate`, `alerte` ou `test`), et doit rendre 0 seulement si le message est
parti. Tout ce qui sait envoyer un message convient : un webhook de messagerie, un e-mail, un
script maison. Exemple avec un webhook dont l'adresse est dans le fichier de I3 :

```bash
curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "$(jq -n --arg t "$HARNESS_SUJET" --arg c "$HARNESS_CORPS" '{text: ($t + "\n" + $c)}')" \
  "$ADRESSE_ALERTE"
```

Sans canal, les messages vont dans le journal (`notification.journal`) et nulle part
ailleurs. C'est tenable si tu regardes `/harness-status` toi-même. Avec `/loop`, c'est une
story qui attend ta décision en silence.

L'installation envoie un message d'essai et te demande si tu l'as reçu. Un « non » bloque la
fin de l'installation : un canal qui ne marche pas est pire que pas de canal, parce qu'on
compte dessus.

## Lot J : les options

Une question par option, dans cet ordre. Chacune s'active plus tard sans rien réinstaller :
on passe `actif` à `true`, puis on relance `/harness-install`.

| # | Question | Clé | Sous-questions si oui |
|---|---|---|---|
| J1 | **personas** : veux-tu qu'un panel d'utilisateurs types lise le brief avant la spec, puis regarde le rendu réel avant le merge ? | `options.personas.actif` | où ranger les fiches (`options.personas.dossier`) ; qui sont tes deux à quatre utilisateurs types (une fiche chacun, rédigée d'après le modèle) |
| J2 | **valeur** : veux-tu qu'un arbitre décide, pour chaque défaut trouvé en review, s'il se corrige maintenant, se note pour plus tard, ou se jette ? | `options.valeur.actif` | quels documents disent où en est le projet (`options.valeur.fichiers_situation[]`) ; le plancher te convient-il (`plancher[]`) |
| J3 | **note_story** : veux-tu une note par story, écrite avant la gate de merge, et un index de toutes les notes ? | `options.note_story.actif` | où vit l'index (`options.note_story.index`) |
| J4 | **creneaux** (expérimentale) : veux-tu mener deux stories en même temps, dans deux arbres de travail ? | `options.creneaux.actif` | le port de chaque arbre (`ports.a`, `ports.b`) ; ce qu'un seul chantier peut porter à la fois (`ressources_exclusives[]`) ; ce qu'il faut relier dans le second arbre (`liens[]`) |
| J5 | **mistral** : veux-tu qu'un second service, Mistral, relise la sécurité de chaque PR (la gate l'exigera), arbitre les désaccords et tranche ceux qui durent ? (prérequis : `vibe` 2.13 ou plus et ripgrep ; les motifs de H2 en segments entiers) | `options.mistral.actif` | **l'accord d'envoi à ce second service** (`options.mistral.accord_envoi_externe`, posé comme H1) ; les trois gestes voulus (`securite_pr`, `arbitre`, `tranche_finale`) ; le budget d'une relecture (`plafonds.budget_revue_usd`) ; les fichiers que la relecture sécurité ne relit pas (`exclusions[]`) |
| J6 | **jev** : veux-tu qu'un modèle de décision, Jev (TypeSafe AI), reconnaisse un finding que le relecteur a reformulé, pour que la persistance monte et que l'escalade se déclenche ? (prérequis : une clé TypeSafe AI) | `options.jev.actif` | **l'accord d'envoi à ce service** (`options.jev.accord_envoi_externe`, posé comme H1) ; où est la clé si ce n'est ni `TYPESAFE_API_KEY` ni le fichier par défaut (`options.jev.fichier_cle`) ; garder le modèle et les seuils mesurés (`modele`, `seuil_haut`, `seuil_bas`), ou les re-mesurer d'abord |

Quelques repères pour répondre :

- **personas** vaut pour un produit que des gens regardent. Pour une bibliothèque ou un
  outil interne, la réponse est le plus souvent non.
- **valeur** vaut dès que les reviews trouvent plus de défauts que tu ne veux en corriger.
  Sans elle, tout défaut sérieux devient une tâche. Elle demande au moins un document de
  situation tenu à jour, sinon l'arbitre juge dans le vide. Le plancher (`plancher[]`) liste
  ce qui ne se diffère jamais : relis-le, c'est lui qui rend l'option sûre.
- **note_story** vaut si quelqu'un d'autre que toi doit comprendre dans six mois pourquoi une
  story a été faite ainsi.
- **mistral** demande quatre choses sur la machine : ripgrep (`rg`, exigé : sans lui, l'outil de
  recherche de vibe ne sait plus exclure un dossier interdit), le CLI `vibe` en version 2.13 ou plus, une
  clé Mistral posée par `vibe --setup` (ou `MISTRAL_API_KEY`), et l'accord d'envoyer le diff à
  ce fournisseur. Cet accord est distinct de H1 : c'est un autre service, et un « oui » à H1 ne
  vaut pas ici. L'installateur ne croit pas l'installation sur parole : il lance
  `mistral-preflight.sh`, puis un appel réel de quelques centimes si tu l'acceptes. Le budget
  est un plafond par relecture (la relecture refuse de démarrer au-delà), pas une estimation.
  Les exclusions par défaut écartent le Markdown et les verrous de dépendances : retire
  `**/*.md` si ton dépôt porte des instructions pour agents en Markdown, elles peuvent cacher
  une consigne dangereuse.
- **jev** vaut quand la boucle de review tourne sans converger parce que le relecteur réécrit ses
  titres : sans elle, c'est toi qui reconnais le défaut reformulé. Elle envoie le titre et le
  corps des findings à TypeSafe AI, hébergé aux États-Unis, sans durée de conservation fixée :
  son accord est distinct de H1 et de celui de `mistral`. Elle ne ferme rien et ne bloque rien
  (une panne la fait taire, elle le dit). Ses seuils ont été mesurés sur un autre dépôt, avec
  une version précise du modèle : le modèle est épinglé, jamais un alias, et
  `harness/options/jev.md` dit comment re-mesurer.
- **creneaux** : réponds non à la première installation. Active-la quand une story longue
  bloque les petites. Pour `liens`, les candidats sont le dossier des dépendances installées
  et les réglages locaux de l'outil ; **jamais** un fichier d'environnement qui pointe vers
  la production.

## Lot K : les permissions

Le harness lance beaucoup de commandes. Sans liste d'autorisations, chacune te demande ton
accord et la boucle n'avance pas seule. L'installateur CALCULE une liste depuis la
configuration : les scripts du harness, les gestes Git sur les branches de story, et rien
d'autre. Il y ajoute des interdictions : merge d'une PR, push forcé, push direct vers la
branche d'intégration ou de production, lecture des fichiers d'environnement, et tes
commandes de E5.

| # | Question | Clé | Où l'installateur regarde |
|---|---|---|---|
| K1 | Où appliquer cette liste ? | aucune clé : c'est un geste | `.claude/settings.local.json` (personnel, non partagé), `.claude/settings.json` (partagé, commité), ou nulle part |
| K2 | Les branches d'intégration et de production sont-elles protégées sur la forge ? | aucune clé de configuration : la réponse va au compte rendu (`protection_branche` dans un fichier de réponses) | les règles de protection, si le CLI de la forge y donne accès |

Deux choses à savoir avant de répondre :

- La liste est écrite dans un fichier de proposition, contrôlée, et montrée. Elle n'est
  appliquée que sur ta réponse explicite, et l'application n'enlève rien de ce que ton
  fichier contient déjà.
- Une interdiction compare l'écriture d'une commande à un motif. Elle arrête le geste
  habituel, pas une variante écrite autrement. **Le vrai verrou est la protection de branche
  sur la forge**
  (K2) : c'est elle qui garantit que personne, agent compris, ne merge sans toi.

## Lot L : la prose du projet, puis le récapitulatif

L'installateur rédige un premier jet de `harness/PROJET.md` d'après ce qu'il a lu, et te le
soumet. Tu corriges, tu complètes.

| # | Question | Section de `harness/PROJET.md` |
|---|---|---|
| L1 | Où en est le produit : en construction, ouvert, vendu ? | En trois phrases |
| L2 | Qui s'en sert, et dans quelle situation ? | Les utilisateurs |
| L3 | Y a-t-il des mots du métier à employer, et d'autres à éviter ? | Le vocabulaire |
| L4 | Quels environnements existent, et que peut y faire le harness ? | Les environnements |
| L5 | Qu'est-ce qui a déjà coûté une demi-journée à quelqu'un sur ce dépôt ? | Les pièges connus |
| L6 | Quels sujets te reviennent toujours ? | Ce qui ne se décide pas ici |

L5 est la question la plus rentable du questionnaire. Trois pièges notés aujourd'hui sont
trois demi-journées que les agents ne perdront pas.

Vient ensuite le récapitulatif : toutes les réponses, lot par lot, avec pour chacune sa
source (trouvée dans tel fichier, donnée par toi, valeur par défaut). C'est le dernier moment
pour corriger avant que la configuration soit écrite. Rien n'est écrit dans le dépôt avant ta
confirmation, à part les fichiers de travail de l'installation (`harness/install/`).

## Répondre d'avance, sans dialogue

`/harness-install --reponses <fichier>` prend les réponses dans un fichier JSON au lieu de
les demander. Sa forme est celle de `harness/install/reponses.json`, que l'installateur
écrit lui-même pendant un dialogue normal :

```json
{
  "sans_question": false,
  "config": {
    "projet": { "nom": "..." },
    "git": { "branche_integration": "..." },
    "commandes": { "tests": { "cmd": "..." }, "statique": [{ "nom": "...", "cmd": "..." }] }
  },
  "prose": {
    "en_trois_phrases": "...",
    "utilisateurs": "...",
    "vocabulaire": "...",
    "environnements": "...",
    "pieges": ["..."],
    "ne_se_decide_pas_ici": ["..."]
  },
  "allowlist": ".claude/settings.local.json",
  "protection_branche": "non vérifiée",
  "notification_recue": null
}
```

Toutes les clés sont facultatives.

- `config` a la forme de `harness/projet.json`, en entier ou en partie. Ce qui y figure n'est
  pas redemandé. Une commande s'y donne par son seul `cmd` : les champs de preuve sont
  ajoutés vides par l'installateur, et remplis par l'essai de la commande, jamais à la main.
- `prose` : une clé par question du lot L, dans l'ordre L1 à L6. Une clé absente laisse sa
  rubrique de `harness/PROJET.md` à compléter, et le compte rendu la nomme.
- `sans_question: true` : ce qui manque prend la valeur détectée, à défaut la valeur de
  l'exemple, et le compte rendu liste chaque valeur ainsi prise sans confirmation. Deux
  listes de l'exemple ne sont que des illustrations et restent vides sans réponse : les
  règles de style (G5) et les déclencheurs de rigueur (F1). À réserver aux essais et aux
  installations en série.
- `allowlist` : le fichier où appliquer la liste, ou `"non"`.
- `protection_branche` : ta réponse à K2, en une phrase.
- `notification_recue` : `false`, ou `null` pour que la question soit posée. Un `true` écrit
  d'avance ne prouve rien, puisque le message n'était pas encore parti : le compte rendu
  dira « réception non vérifiée ».

Le plus simple pour obtenir un tel fichier : faire une première installation en dialogue,
puis reprendre son `harness/install/reponses.json` pour le projet suivant.
