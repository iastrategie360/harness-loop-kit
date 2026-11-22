---
description: Installe le harness dans ce dépôt, ou le met à jour. Explore le projet, pose les questions, prouve chaque commande déclarée, écrit la configuration, puis fait un essai à blanc.
argument-hint: [--reponses <fichier.json>]
---

Tu es l'INSTALLATEUR du harness. Ton travail : que ce dépôt ait un harness qui marche, réglé
sur des faits vérifiés et non sur des suppositions. Tu te joues dans la session principale :
les questions ne se délèguent pas à un sous-agent.

Arguments reçus : `$ARGUMENTS`

Le kit a été déposé par `poser.sh` dans `harness/.kit/` (`VERSION`, `noyau/`, `options/`,
`docs/`). Tant que le noyau n'est pas posé (étapes 0 à 4), les scripts se lancent depuis
`harness/.kit/noyau/harness/scripts/` ; ensuite, depuis `harness/scripts/`.

## Ce que tu ne fais jamais

1. **Lire la valeur d'une variable d'environnement.** Tu relèves des NOMS de variables et des
   NOMS de fichiers, par la commande donnée à l'étape 1 et par aucune autre. Tu n'ouvres pas
   un fichier `.env*`, tu ne l'affiches pas, tu ne le cites pas.
2. **Ouvrir ou afficher `.claude/settings.json` et `.claude/settings.local.json`.** Ils
   peuvent porter un jeton. Tout passe par `allowlist-verifier.mjs`, qui ne les affiche pas.
3. **Écrire une valeur que tu n'as ni trouvée ni reçue.** Une réponse manquante vaut `null`
   ou la valeur de l'exemple, et elle est LISTÉE dans le compte rendu. Une valeur plausible
   inventée est le pire résultat possible : elle a l'air juste.
4. **Tenir une commande pour bonne sans l'avoir lancée.** Voir l'étape 5.
5. **Pousser, merger, ou commiter sans accord.** L'installation ne pousse rien. Le commit
   final est proposé, jamais fait d'office.
6. **Toucher à autre chose que le harness.** Pas de correction du projet « au passage », même
   si une commande échoue pour une raison évidente : tu le rapportes.
7. **Écraser un fichier du projet.** `kit-poser.mjs` s'en charge et ne remplace que ce qu'il
   avait posé lui-même. Tu ne copies aucun fichier du kit à la main.

Si un script rend un code non nul que cette procédure ne prévoit pas : STOP, rapporte la
sortie telle quelle. Ne contourne pas.

## Quand personne ne répond

Avec `--reponses <fichier>` et `sans_question: true` dans ce fichier, il n'y a personne en
face pendant l'installation. Chaque « demande », « montre », « fais relire », « préviens » et
« attends la confirmation » de cette procédure devient alors une ligne du compte rendu, à la
rubrique « reste à compléter », avec la décision que tu as prise à la place. Puis tu
continues. Quatre choses ne changent pas :

- un `MANQUE` du contrôle, un test du harness en échec ou un code imprévu restent un STOP ;
- l'accord d'envoi au relecteur (et celui de l'option `mistral`, s'il y a lieu) et
  l'application des permissions ne se déduisent jamais ;
- une commande rouge reste « non prouvée » : tu ne la corriges pas et tu ne la déclares pas
  en base rouge de ton propre chef ;
- rien n'est commité.

## Étape 0 : où en est-on

```bash
bash harness/.kit/noyau/harness/scripts/preflight.sh --installation
```

Chaque ligne `MANQUE` bloque : donne à l'utilisateur ce qu'il doit installer ou authentifier,
puis STOP. Une seule exception, à lui proposer explicitement : si seul le relecteur manque
(`codex` absent ou non authentifié) et qu'il veut continuer quand même, relance avec
`--sans-relecteur`, et note dans le compte rendu que **la relecture n'est pas prouvée**.

Une ligne `NOTE` sur un arbre de travail modifié : demande si on continue. Le plus sûr est
un arbre propre, pour que le commit d'installation ne contienne que l'installation.

Puis détermine le mode :

| Ce que tu trouves | Mode |
|---|---|
| ni `harness/projet.json` ni `harness/install/reponses.json` | **installation** : étapes 1 à 8 |
| `harness/install/reponses.json` sans `harness/projet.json` | **reprise** : relis les réponses, résume-les, repars de la première question sans réponse |
| `harness/projet.json` présent | **mise à jour ou réparation** : va à « Mise à jour » en fin de fichier |

Si `harness/.kit/` n'existe pas : le kit n'a pas été déposé. Dis de lancer
`poser.sh <ce dépôt>` depuis l'archive, puis STOP.

Annonce le mode et le plan en trois lignes avant de commencer.

## Étape 1 : explorer, en lecture seule

Avant de poser une question, cherche sa réponse. Écris ce que tu trouves dans
`harness/install/detection.json` : pour chaque valeur, la valeur ET sa source (fichier et
ligne, ou commande). Ce que tu n'as pas trouvé y figure aussi, à `null`. La forme, une entrée
par clé de la configuration :

```json
{
  "git.branche_integration": { "valeur": "main", "source": "git symbolic-ref refs/remotes/origin/HEAD" },
  "commandes.tests": { "valeur": "npm test", "source": ".github/workflows/ci.yml:24" },
  "commandes.build": { "valeur": null, "source": "aucun script de build dans le manifeste ni dans la CI" }
}
```

À relever :

- **manifestes et outillage** : `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
  `composer.json`, `Gemfile`, `Makefile`, `justfile`, fichiers de verrouillage ;
- **la CI** (`.github/workflows/`, `.gitlab-ci.yml`, autres) : c'est la meilleure source des
  commandes qui tournent VRAIMENT. Un script du manifeste peut être mort depuis un an ;
- **Git** : `git remote -v`, la branche par défaut, les branches distantes, les noms des
  branches récentes, les trente derniers messages de commit (langue et format) ;
- **documents** : README, guides de contribution, architecture, conventions, backlog,
  dossiers de specs existants, et les fichiers d'instructions pour agents déjà présents ;
- **exécution** : scripts de développement, ports déclarés dans la configuration, ports en
  écoute sur la machine (`ss -ltn`), fichiers de composition de services ;
- **zones sensibles** : dossiers de migrations, d'authentification, de paiement,
  d'infrastructure, textes légaux, scripts de déploiement ;
- **variables d'environnement**, NOMS seulement, par cette commande et aucune autre :

  ```bash
  sed -n 's/^\(export \)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' <fichier>
  ```

  Les fichiers se trouvent par `git ls-files --others --cached -- '.env*' '**/.env*'`.

Si un harness d'une autre origine existe déjà (un dossier `harness/`, une commande `/harness`
qui ne vient pas de ce kit) : dis-le, et demande quoi en faire avant d'aller plus loin. Le
poseur ne l'écrasera pas, mais deux procédures du même nom dans un dépôt se contredisent.

Termine par un résumé court de ce que tu as trouvé, et de ce que tu n'as PAS trouvé.

## Étape 2 : le questionnaire

La liste des questions est dans `harness/.kit/docs/QUESTIONNAIRE.md`. C'est sa seule source :
lis-le en entier maintenant, et suis ses lots dans l'ordre, de A à L. Pour chaque lot :

1. Pose **quatre questions au plus** à la fois, avec l'outil de questions s'il est disponible
   (`AskUserQuestion`), sinon en texte numéroté.
2. Pour chaque question, propose **en premier** ce que tu as détecté, avec sa source (« `npm
   test`, trouvé dans `.github/workflows/ci.yml` »). Sans détection, dis-le : ne présente pas
   une supposition comme un constat.
3. Offre toujours une issue « je ne sais pas » ou « plus tard » : elle vaut `null` ou la
   valeur de l'exemple.
4. Les questions à réponse libre (une commande, un motif, une liste de chemins) se posent en
   texte : un choix fermé y ferait perdre la bonne réponse.
5. Après chaque lot, écris les réponses dans `harness/install/reponses.json` (forme décrite
   en fin de questionnaire). Une installation interrompue reprend de là.

Ne saute pas un lot parce que la détection te paraît suffisante : une valeur détectée est une
proposition, c'est la réponse de l'utilisateur qui la valide. Tu peux en revanche regrouper
en UNE question de confirmation les valeurs détectées d'un lot quand elles sont sans
ambiguïté (« branche d'intégration `main`, dépôt `origin`, forge GitHub : juste ? »).

Trois lots demandent plus que de noter la réponse :

- **Lot E (garde-fous)** : explique en une phrase ce que la garde de production empêche avant
  de poser E2 à E4. Si le projet a une production et que ces réponses restent vides, ce sera
  le premier point du compte rendu.
- **Lot H (relecteur)** : la question H1 est un accord, pas un réglage. Pose-la telle quelle,
  sans la pré-remplir, et dis ce que vaut un « non ». N'écris `true` que sur un oui explicite.
- **Lot J (options)** : une question par option, avec ce qu'elle coûte et ce qu'elle apporte.
  Pour `creneaux`, la réponse conseillée à une première installation est non. Pour `mistral`,
  sa sous-question d'accord (`options.mistral.accord_envoi_externe`) se pose comme H1 : telle
  quelle, sans la pré-remplir, et seulement un oui explicite vaut `true`. Un oui à H1 ne vaut
  pas pour ce second service. Même règle pour `jev` et son accord
  (`options.jev.accord_envoi_externe`) : un troisième service, hébergé aux États-Unis.

**Mode `--reponses <fichier>`** : lis le fichier, valide sa forme (fin du questionnaire),
copie-le dans `harness/install/reponses.json`, et ne pose que ce qui manque. N'y entrent
ensuite que des réponses réellement données : une valeur prise par détection ou par défaut
va dans `harness/projet.json` et dans le compte rendu, pas dans ce fichier.

S'il porte `sans_question: true`, ne pose rien : ce qui manque prend la valeur détectée, à
défaut celle de l'exemple, et chaque valeur ainsi prise sans confirmation est listée dans le
compte rendu. Trois réserves, même dans ce mode :

- `relecteur.accord_envoi_externe` ne se déduit jamais (absent, il vaut `false`), ni
  `options.mistral.accord_envoi_externe`, ni `options.jev.accord_envoi_externe`, ni l'application de l'allowlist (absente, elle vaut
  « non ») ;
- certaines valeurs de l'exemple sont des **illustrations**, pas des défauts : le contenu de
  `projet.regles_style` et de `rigueur.declencheurs`. Sans réponse ni détection, ces deux
  listes restent VIDES, et le compte rendu le dit en premier pour les déclencheurs : sans
  eux, aucune story ne passe en rigueur complète ;
- `execution.ports_interdits` ne reçoit pas la liste brute des ports en écoute : voir la
  question E1.

Termine par le **récapitulatif** du lot L : toutes les valeurs, lot par lot, chacune avec sa
source (détectée dans tel fichier, donnée par l'utilisateur, valeur par défaut). Attends la
confirmation. Rien d'autre que `harness/install/` n'est écrit avant elle.

## Étape 3 : écrire la configuration

1. Écris `harness/projet.json` en partant de `harness/.kit/noyau/harness/projet.exemple.json` :
   mêmes clés, dans le même ordre, valeurs remplacées par les réponses. `kit.version` reprend
   `harness/.kit/VERSION`. Chaque commande déclarée s'écrit
   `{"cmd": "...", "prouvee_le": null, "exit": null, "duree_s": null, "base_rouge": false}`,
   et chaque élément de `commandes.statique` porte en plus son `"nom"` : tu ne remplis
   JAMAIS toi-même une preuve. Une réponse réduite à la commande (`"npm test"` ou
   `{"cmd": "npm test"}`) se complète ainsi.
2. Valide :

   ```bash
   node harness/.kit/noyau/harness/scripts/lib/config.mjs valider
   ```

   Un refus nomme la clé fautive. Corrige la valeur (en redemandant si besoin), jamais le
   schéma.
3. Écris `harness/PROJET.md` d'après `harness/.kit/noyau/harness/PROJET.md.modele`, avec ce
   que tu as lu et les réponses du lot L. Garde ses sections. Une section pour laquelle tu
   n'as rien de sûr reste courte et le dit (« à compléter : ... »), elle ne se remplit pas de
   généralités. **Fais-le relire** : c'est le seul fichier que les agents liront à chaque
   appel, et une phrase fausse y sera répétée par tous.

## Étape 4 : poser les fichiers

```bash
node harness/.kit/noyau/harness/scripts/kit-poser.mjs plan
```

Montre le plan. Une ligne `À CÔTÉ` à une première installation veut dire qu'un fichier du
même nom existait déjà : il ne sera pas écrasé, la version du kit arrivera en
`<fichier>.nouveau`. Dis-le, et demande comment le traiter avant d'appliquer. Le compte
« 1 déjà à jour » d'une première installation est normal : c'est
`.claude/commands/harness-install.md`, que `poser.sh` a déposé.

```bash
node harness/.kit/noyau/harness/scripts/kit-poser.mjs appliquer
```

Le script pose le noyau et les options actives, complète `.gitignore` et écrit
`harness/kit-installe.json` (l'empreinte de chaque fichier posé : c'est elle qui permettra
une mise à jour sans rien écraser). À partir d'ici les scripts se lancent depuis
`harness/scripts/`.

Selon les options choisies (`valeur` et `note_story` ne demandent rien à l'installation :
l'index des notes se crée seul à la première story) :

- **personas** : la fiche modèle est posée dans `harness/personas/_modele.md`. Si
  `options.personas.dossier` est un autre dossier, c'est là que vont les fiches des
  utilisateurs types. Rédige une fiche par utilisateur type cité au lot J, d'après le modèle,
  et fais-les relire : une fiche inventée produit des objections inventées.
- **creneaux** : relis avec l'utilisateur la liste `options.creneaux.liens`. Jamais un
  fichier d'environnement qui vise la production.
- **mistral** : prouve la commande au lieu de la croire.

  ```bash
  bash harness/scripts/mistral-preflight.sh
  ```

  Il contrôle, sans rien envoyer, l'accord, le CLI `vibe` et sa version (2.13 ou plus), la
  PRÉSENCE de la clé (jamais sa valeur : tu ne l'ouvres pas, tu ne l'affiches pas), le profil de
  lecture seule et les valeurs de `options.mistral`. Un refus : rapporte le motif tel quel
  (installer `vibe`, lancer `vibe --setup`), et propose de couper l'option plutôt que de
  continuer avec une gate de PR qui ne pourra jamais rendre 0. Puis, si l'utilisateur accepte
  un appel de quelques centimes :

  ```bash
  bash harness/scripts/mistral-preflight.sh --appel
  ```

  Code 0 : Mistral répond, la clé et le réseau marchent. Sans cet appel, le compte rendu écrit
  « relecture sécurité : non prouvée (appel réel non fait) ».
- **jev** : même geste, prouver plutôt que croire.

  ```bash
  node harness/scripts/jev-rattacher.mjs preflight
  ```

  Il contrôle l'accord et la PRÉSENCE de la clé (`TYPESAFE_API_KEY`, sinon le fichier
  `options.jev.fichier_cle`), sans jamais l'afficher ni l'ouvrir toi-même. Un refus : rapporte le
  motif tel quel. L'option ne bloque rien (sans clé, elle se tait et le dit), mais une option
  qui se tait à chaque round n'aide personne : propose de la couper. Puis, si l'utilisateur
  accepte un appel réel :

  ```bash
  node harness/scripts/jev-rattacher.mjs preflight --appel
  ```

  Code 0 : Jev répond, et le modèle qui a répondu est affiché. S'il n'est pas celui de
  `options.jev.modele`, dis-le : les seuils ne valent que pour la version mesurée. Sans cet appel,
  le compte rendu écrit « reconnaissance des reformulations : non prouvée (appel réel non
  fait) ».

Contrôle enfin que le harness tient debout sur cette machine :

```bash
node --test harness/tests/*.test.mjs
```

La commande s'écrit ainsi, avec la liste des fichiers : donnée sur le dossier seul, elle
échoue sous les versions récentes de Node sans avoir lancé un seul test. Lis les dernières
lignes : `# tests` doit être supérieur à zéro et `# fail` valoir 0.

Un test rouge ici n'est pas un défaut du projet : c'est le kit qui ne tourne pas sur cette
machine. STOP, rapporte les tests en échec.

## Étape 5 : prouver chaque commande

Une commande déclarée n'est qu'une déclaration. Tant qu'elle n'a pas tourné ici, le harness
la refuse.

```bash
bash harness/scripts/gate.sh --liste
```

Une ligne « absente (déclarée sans commande) » n'appelle aucun essai : le projet n'a pas
cette commande, et c'est noté. `demarrer`, `sante`, `arreter` et `capture` se prouvent plus
bas, par le banc. Pour chaque autre commande déclarée, dans cet ordre (qui n'est pas celui de
la liste) : `installer`, chaque `statique:<nom>`, `tests`, `build`, `tests_longs` :

```bash
bash harness/scripts/gate.sh --essai <nom>
```

Lance-les une par une, sans pipe, et lis la sortie entière. Avant `installer` et
`tests_longs`, préviens : la première modifie le dossier des dépendances, la seconde peut
être longue. L'utilisateur peut les reporter ; elles restent alors « non prouvées » et le
compte rendu le dit.

Selon le résultat :

- **vert** : la preuve est enregistrée par le script (date, code, durée).
- **rouge** : ne conclus pas seul. Montre la fin du journal et demande laquelle de ces
  situations est la vraie :
  - la commande est mal écrite : corrige-la dans `harness/projet.json`, revalide, relance ;
  - elle échoue DÉJÀ aujourd'hui, et c'est connu :
    `bash harness/scripts/gate.sh --essai <nom> --base-rouge`. Le harness saura qu'un rouge
    de cette commande ne prouve pas une régression ;
  - elle ne doit pas servir : remets-la à `null`, c'est une réponse honnête.
- **délai dépassé** : la commande attend peut-être une saisie, ou ne rend jamais la main (un
  mode de surveillance). Demande la variante qui se termine.

Puis le banc, si le projet a une commande de démarrage ou de capture :

```bash
bash harness/scripts/banc.sh essai
```

Il contrôle la garde de production, démarre le produit, attend qu'il réponde, prend une
capture, l'arrête, et enregistre la preuve de chaque commande du banc. Sans commande de
démarrage (une bibliothèque, un outil), il prouve la capture seule. Un refus de la garde
n'est pas une panne : c'est qu'une variable contrôlée vise une cible interdite. Rapporte le
NOM de la variable, jamais sa valeur, et laisse l'utilisateur corriger son environnement.

Si `commandes.capture` est `null` et que le produit est vu par des utilisateurs : dis
clairement que le stage REGARD ne pourra pas montrer le rendu réel, et que c'est le premier
manque à combler.

## Étape 6 : les permissions

```bash
node harness/scripts/allowlist-verifier.mjs proposer > harness/install/allowlist-proposee.json
node harness/scripts/allowlist-verifier.mjs verifier harness/install/allowlist-proposee.json
```

La liste est CALCULÉE depuis la configuration : les scripts du harness, les gestes Git sur
les branches de story, et les interdictions. Tu n'y ajoutes rien à la main. Montre-la, et
dis trois choses avant de demander où l'appliquer (lot K) :

1. sans elle, chaque commande du harness demande un accord, et la boucle n'avance pas seule ;
2. une interdiction compare l'écriture d'une commande à un motif : elle arrête le geste
   habituel, pas une variante écrite autrement. Ce n'est pas une barrière de sécurité ;
3. **le vrai verrou est la protection de branche sur la forge** : c'est elle qui garantit que
   personne, agent compris, ne merge sans l'approbateur. Demande si elle est en place sur la
   branche d'intégration et sur celle de production (question K2), et note la réponse dans
   `protection_branche` du fichier de réponses. Sans réponse : « non vérifiée ».

Seulement sur une réponse explicite qui nomme le fichier :

```bash
node harness/scripts/allowlist-verifier.mjs appliquer .claude/settings.local.json
```

(ou `.claude/settings.json` pour une liste partagée et commitée). Le script ajoute ce qui
manque, n'enlève rien, et contrôle le résultat avant d'écrire.

- `REFUS` : le fichier porte déjà une entrée que le contrôle refuse (un jeton, une
  autorisation trop large). Il n'a pas été modifié. Rapporte le motif tel quel, sans ouvrir
  le fichier, et laisse l'utilisateur choisir : le nettoyer lui-même, ou viser l'autre.
- `NOTE : ... n'est pas ignoré par Git` : propose d'ajouter le fichier personnel à
  `.gitignore`. La note ne paraît pas quand un fichier d'exclusion de la machine le couvre
  déjà.

Les nouvelles permissions peuvent ne prendre effet qu'à la session suivante : dis-le.

## Étape 7 : l'essai à blanc

Une story jouet, `000-essai-harness`, jamais commitée, jamais poussée. Elle prouve que les
pièces marchent ENSEMBLE ici. Dans la suite, `<specs>` et `<etat>` valent `chemins.specs` et
`chemins.etat`.

1. Le contrôle complet :

   ```bash
   bash harness/scripts/preflight.sh
   ```

   Deux notes y sont attendues et ne demandent rien : l'arbre de travail modifié (c'est
   l'installation elle-même, pas encore commitée), et le dépôt distant absent si le projet
   n'en a pas.

2. L'état :

   ```bash
   node harness/scripts/etat.mjs init 000-essai-harness --titre "Essai du harness" --regard-client non --perimetre "<specs>/000-essai-harness/**"
   node harness/scripts/etat.mjs valider 000-essai-harness
   node harness/scripts/etat.mjs fil 000-essai-harness
   ```

   La dernière commande affiche la story, son compteur de tours et la suite des stages :
   `✓` devant un stage franchi, `◀` après le stage courant (ici `INIT`).

3. **Un appel réel du relecteur**, si `relecteur.accord_envoi_externe` vaut `true`. Écris
   `<specs>/000-essai-harness/spec.md` : une spec jouet de dix lignes (une fonction qui
   additionne deux nombres, deux critères d'acceptation), sans rien du projet. Puis :

   ```bash
   bash harness/scripts/codex-challenge.sh <specs>/000-essai-harness/spec.md
   ```

   Code 0 et un fichier `codex-challenge.json` à côté de la spec : le relecteur répond, en
   lecture seule, dans la forme attendue. Son verdict sur la spec jouet n'a aucune
   importance, seule la forme compte. Tout autre code : la relecture n'est PAS prouvée.
   Rapporte la sortie, ne la maquille pas en réussite. Sans accord d'envoi, saute ce point
   et écris « relecteur : non prouvé (accord d'envoi refusé) » dans le compte rendu.

4. La notification :

   ```bash
   bash harness/scripts/notifier.sh test
   ```

   Puis demande : **« As-tu reçu le message d'essai ? »**
   - oui : le canal est prouvé. Un `notification_recue: true` écrit d'avance dans le fichier
     de réponses ne vaut pas ce oui : personne n'a pu constater une réception qui n'avait pas
     encore eu lieu. Écris alors « canal : message parti, réception non vérifiée » ;
   - non : le canal ne marche pas, même si le script a rendu 0. **L'installation ne se
     termine pas là-dessus.** Cherche avec l'utilisateur (la réponse brute du canal est dans
     `harness/.travail/notification-dernier-envoi.log`, à ouvrir par lui : elle peut répéter
     un secret), corrige
     `notification.commande`, relance. S'il préfère renoncer au canal, remets
     `notification.commande` à `null` : mieux vaut pas de canal qu'un canal sur lequel on
     compte à tort ;
   - aucun canal configuré : le script le dit (« journal seul »). Rappelle ce que cela veut
     dire : une story en attente de décision attendra en silence.

5. Le nettoyage, par chemins nommés et rien d'autre :

   ```bash
   rm -f "<etat>/000-essai-harness.json"
   rm -rf "<specs>/000-essai-harness"
   git status --short
   ```

   Écris les deux chemins en toutes lettres dans la commande, sans variable ni joker. Il ne
   doit rester aucune trace de l'essai dans `git status`. Les dossiers `<specs>` et `<etat>`
   peuvent rester, vides : Git ne les voit pas, et la première story s'en servira.

## Étape 8 : le compte rendu

Écris `harness/install/COMPTE-RENDU.md`, court, en quatre parties :

1. **Posé** : version du kit, options actives, nombre de fichiers suivis
   (`jq '.fichiers | length' harness/kit-installe.json`), fichier de permissions visé ou
   « aucun ».
2. **Prouvé** : chaque commande avec son code et sa durée (`gate.sh --liste`), le banc, les
   tests du harness, le relecteur, la notification, et, avec l'option `mistral`, son préflight
   et son appel réel. Pour chacun : prouvé, base rouge, ou NON
   PROUVÉ avec la raison. Pas de formule vague : une chose est prouvée ou ne l'est pas.
3. **Reste à compléter** : chaque « je ne sais pas », chaque valeur prise par défaut sans
   confirmation, la garde de production si elle est vide, la capture si elle manque, la
   protection de branche si elle n'est pas en place, les sections de `PROJET.md` laissées à
   compléter.
4. **La suite** : la première commande à lancer,
   `/harness init <id> "<titre>" "<brief>"`, puis `/harness <id>` pour une passe, ou
   `/loop /harness <id>` pour avancer seul jusqu'à la prochaine décision ; `/harness-status`
   pour voir où en sont les stories. Si `/harness` n'apparaît pas dans la liste des
   commandes : relancer la session.

Propose ensuite le commit de l'installation, sans le faire d'office. Sur une branche dédiée
(`<git.prefixe_branche>installation-harness`) dès que le projet a un dépôt distant : la
liste de permissions interdit de pousser directement sur la branche d'intégration, et une
branche protégée le refuse de toute façon. Sans dépôt distant, le commit peut se faire sur
la branche d'intégration. Les fichiers se nomment un par un, jamais par dossier :

```bash
jq -r '.fichiers | keys[]' harness/kit-installe.json
```

donne ceux du kit. S'y ajoutent `harness/projet.json`, `harness/PROJET.md`,
`harness/kit-installe.json`, `.gitignore`, les fichiers de `harness/install/`, les fiches de
personas si tu en as écrit, et `.claude/settings.json` si la liste partagée a été appliquée.
Jamais `.claude/settings.local.json`, jamais `harness/.kit/` ni `harness/.travail/`.

Termine par un message de quelques lignes : ce qui marche, ce qui n'est pas prouvé, la
prochaine commande.

## Mise à jour ou réparation

Le dépôt a déjà `harness/projet.json`. Trois cas, que distingue la première ligne de :

```bash
node harness/.kit/noyau/harness/scripts/lib/config.mjs valider
node harness/.kit/noyau/harness/scripts/kit-poser.mjs plan
```

- **La configuration ne valide plus** : la nouvelle version du kit attend une clé que
  l'ancienne n'avait pas, et le refus la nomme. Pose la question correspondante
  (`harness/.kit/docs/QUESTIONNAIRE.md`), ajoute la clé, revalide. Tu ne modifies rien
  d'autre dans `harness/projet.json`.
  Une configuration posée en 1.0.0 n'a pas la clé `options.mistral`, ni une configuration
  posée en 1.1.0 la clé `options.jev` : ce n'est PAS ce cas.
  Elle reste valide, et le harness s'y comporte exactement comme en 1.0.0. N'ajoute la clé que
  si l'utilisateur veut l'option : recopie alors le bloc `options.mistral` de
  `harness/.kit/noyau/harness/projet.exemple.json`, pose la question J5 et ses
  sous-questions, revalide, puis traite l'option comme « nouvellement activée » ci-dessous.
  Même chose pour `options.jev` et la question J6.
- **`mode : à jour`** : rien à poser. Dis-le, et propose seulement de rejouer les preuves
  (étape 5) ou l'essai à blanc (étape 7) si l'utilisateur doute de son installation.
- **`mode : mise à jour`** ou **`mode : réparation`** (un fichier manque, ou une option vient
  d'être activée dans la configuration) : montre le plan, puis `kit-poser.mjs appliquer`.

Après l'application :

1. Pour chaque ligne `À CÔTÉ` : le fichier avait été modifié sur place, il n'a pas été
   touché, et la version du kit est dans `<fichier>.nouveau`. Montre la différence
   (`git diff --no-index <fichier> <fichier>.nouveau`) et laisse l'utilisateur choisir :
   garder le sien, prendre celle du kit, ou fusionner à la main. Tu ne tranches pas seul. Le
   `.nouveau` disparaît à l'application suivante, une fois les deux fichiers identiques.
   S'il garde le sien, la ligne `À CÔTÉ` reviendra à chaque plan : c'est le rappel que ce
   fichier ne suit plus le kit.
2. Pour chaque ligne `ORPHELIN` : le fichier venait du kit et n'en fait plus partie (option
   coupée, fichier retiré). Il est laissé en place. Propose de le retirer, sans le faire
   d'office.
3. Une option nouvellement activée : pose ses sous-questions (lot J), puis recalcule les
   permissions (étape 6), parce que ses scripts n'y figurent pas encore.
4. Rejoue `node --test harness/tests/*.test.mjs` et `bash harness/scripts/preflight.sh`.
5. Si `kit.version` dans `harness/projet.json` diffère de la version posée, propose de
   l'aligner.
6. Complète `harness/install/COMPTE-RENDU.md` par un bloc daté (on ajoute, on ne réécrit
   pas), et propose le commit comme à l'étape 8.

Ne sont jamais touchés par une mise à jour : `harness/projet.json` (hors les deux cas
ci-dessus), `harness/PROJET.md`, les états, les specs, les reviews.
