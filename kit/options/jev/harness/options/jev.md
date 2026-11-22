# Option `jev` : reconnaître un défaut reformulé

Le registre des findings donne à chaque défaut une clé stable : son fichier et son titre
normalisé. Le titre, c'est le relecteur qui l'écrit, et il ne l'écrit pas deux fois pareil.
Quand il **reformule** un défaut déjà connu, la clé change, et le défaut passe pour neuf : sa
persistance (`survived`) repart à zéro, l'échelle d'escalade ne le voit jamais atteindre
`boucle.seuil_survie`, et la boucle de review tourne sans converger. Pire, au stage PR, le
défaut connu, absent sous son ancien titre, est tenu pour **corrigé**.

Sans l'option, c'est au superviseur de réconcilier les clés à la main (stage CODE, geste 2), et
rien ne le fait au stage PR. L'option confie la question à **Jev**, de TypeSafe AI : un modèle
de décision, à qui l'on pose une question oui ou non et qui répond par une probabilité.

Fichiers de l'option : `harness/scripts/jev-rattacher.mjs` (les deux registres, le journal, le
préflight), `jev-defaire.mjs` (défaire un rattachement), `jev-mesurer.mjs` (re-mesurer les
seuils), `lib/jev.mjs` (le seul endroit qui appelle Jev, et les règles de décision). Réglage :
`options.jev` dans `harness/projet.json`.

## Ce que fait l'option

Pour chaque finding **neuf** (sa clé est inconnue du registre), elle pose à Jev la question
« ce finding est-il le même défaut que tel finding connu, reformulé ? », contre chaque finding
connu **du même fichier**, et seulement de celui-là. Chaque paire est posée **dans les deux
ordres**, et le score retenu est le **minimum** des deux : un ordre convaincu et l'autre non ne
font pas un doublon.

| Score | Bande | Ce qui se passe |
|---|---|---|
| `score >= seuil_haut` contre un connu **non tranché** (ouvert ou corrigé) | re-détection | le finding est **rattaché** à la clé du connu : celui-ci survit un round de plus, et l'échelle d'escalade le voit |
| `score >= seuil_haut` contre un connu **tranché** | re-détection d'un tranché | **jamais rattaché** : le finding reste neuf et bloquant, et il est **signalé** (« doublon probable de `<clé>` tranchée ») |
| `seuil_bas <= score < seuil_haut` | douteux | rien n'est rattaché, le finding est neuf, il est signalé avec son meilleur candidat |
| `score < seuil_bas` | neuf | rien |

C'est le **sens sûr** : un rattachement ne ferme rien. Le finding reste ouvert et bloquant, il
est seulement reconnu pour ce qu'il est, et la boucle converge plus tôt vers l'arbitre. Le sens
dangereux serait de faire taire un finding en le rattachant à un défaut déjà tranché ; c'est
précisément ce que l'option ne fait jamais d'office.

Les cas limites :

- deux connus au-dessus du seuil : le meilleur score gagne ; **ex aequo, aucun rattachement**,
  le finding est signalé ;
- deux findings neufs du même round visent le même connu : le meilleur score le prend,
  l'égalité ne le donne à personne, et les autres restent neufs, signalés ;
- un connu re-signalé dans le même round sous sa propre clé n'est pas un candidat : deux
  findings d'un round ne partagent jamais une clé ;
- la sévérité retenue est la **plus grave** des deux : un rattachement ne baisse jamais une
  sévérité.

## Ce que l'option ne fait jamais

- fermer un finding, baisser une sévérité, ou toucher la gate de PR ;
- rattacher un **P0**, ni comme finding neuf ni comme cible : il reste neuf et visible tel quel.
  Un P3 non plus (il ne bloque rien) ;
- comparer deux findings de fichiers différents, ou un finding sans fichier ;
- envoyer un finding dont le chemin sort du dépôt, est vide ou ne se canonise pas. Chaque chemin
  passe par UN point de canonicalisation (`canoniser` de `lib/jev.mjs`, même règle que l'option
  `mistral`) : relatif à la racine, « ./ », « .. » et barres doublées résolus, chemin absolu dans
  le dépôt ramené au relatif, liens symboliques suivis (un lien pendant aussi, par sa cible
  écrite). C'est aussi sur cette forme que se jugent « même fichier » et les paires de la
  re-mesure ;
- envoyer un finding dont le fichier, ou la cible de son lien, est couvert par `relecteur.chemins_exclus` (même
  fonction que celle qui garde le relecteur, `chemin_exclu` de `codex-common.sh`, donc même
  sens des motifs), ni un finding dont le titre ou le corps porte un motif de secret (les motifs
  de `allowlist-verifier.mjs`, les mêmes que pour la liste de permissions). Ces findings restent
  neufs, sans appel, et leur corps n'est pas gardé dans l'état ;
- envoyer autre chose que le **titre et le corps** des deux findings : pas de diff, pas de
  chemin, pas de note, pas de commit. Un corps est coupé à 12 000 caractères (l'API refuse au-delà
  d'environ 32 000 jetons d'état) ;
- afficher, journaliser ou écrire la clé ailleurs que dans l'en-tête de la requête.

## Les données partent chez un tiers

Jev est un service hébergé par TypeSafe AI, **aux États-Unis**, et sa durée de conservation des
requêtes **n'est pas fixée** à la date où l'option a été écrite. Le titre et le corps d'un finding
décrivent un défaut du code : c'est de l'information sur le projet, parfois sur sa sécurité.

C'est pourquoi l'option exige son **propre accord d'envoi**
(`options.jev.accord_envoi_externe`), distinct de celui du relecteur et de celui de l'option
`mistral` : c'est un autre service. Sans lui, l'option se tait (voir « Panne »), et le registre
suit la règle de 1.1.0. L'installateur pose la question telle quelle, sans la pré-remplir.

## Les réglages

| Clé | Ce qu'elle dit |
|---|---|
| `actif` | l'option tourne |
| `accord_envoi_externe` | l'accord d'envoyer titres et corps des findings à TypeSafe AI |
| `modele` | la version EXACTE du modèle (défaut `jev-1.14.0`) |
| `seuil_haut` | à partir de ce score, re-détection (défaut 0,8) |
| `seuil_bas` | à partir de ce score, douteux et signalé (défaut 0,5) ; strictement sous `seuil_haut` |
| `delai_ms` | le délai d'UN appel HTTP ; dépassé, l'option se tait pour ce round |
| `fichier_cle` | le fichier de la clé quand `TYPESAFE_API_KEY` est absente (défaut `~/.config/typesafe/api_key`), hors du dépôt |

La configuration refuse `0 < seuil_bas < seuil_haut <= 1` non tenu, un délai hors de 100 à
60 000 ms, et un nom de modèle sans numéro de version.

**Pourquoi un modèle épinglé, et jamais un alias comme `jev-latest`.** Les seuils ont été mesurés
sur une version précise, avec une formulation précise de la question. Un autre modèle range les
mêmes paires autrement : 0,8 peut y tenir le rôle de 0,6, ou laisser passer un faux « même ». Un
alias changerait de modèle sans que personne le décide, et les seuils mentiraient en silence.
Changer de version est un geste : on re-mesure (plus bas), puis on écrit la nouvelle version ET
les nouveaux seuils ensemble.

`TYPESAFE_BASE_URL` remplace l'adresse de l'API (`https://api.typesafe.ai`) : elle sert aux tests,
qui parlent à un faux serveur local. `HARNESS_JEV_PAUSE_MS` règle la pause avant un nouvel essai
(400 ms, puis le double) ; les tests la raccourcissent.

## La mesure qui fonde les seuils

Mesurée sur Riposte : 417 paires candidates (même fichier, deux premiers commits différents),
modèle `jev-1.14.0`, la formulation de `lib/jev.mjs` (état à clés nommées `finding_a` et
`finding_b`, jamais un tableau indexé : les index positionnels se sont montrés peu fiables).
Hors artefacts de review :

| Seuil | Vrais doublons reconnus | Nouveaux défauts pris pour un doublon |
|---|---|---|
| 0,8 | 20 sur 25 | 0 |
| 0,6 | 23 sur 25 | 0 |

Le plus proche faux « même » est à 0,52. D'où les défauts : 0,8 pour rattacher (une marge nette
au-dessus du pire faux « même »), 0,5 pour signaler (tout ce qui s'en approche passe sous les
yeux du superviseur).

**Les limites de cette mesure**, à garder en tête :

- les étiquettes « même » et « différent » ont été posées par **deux modèles**, pas par des
  humains ;
- **un seul dépôt**, un seul relecteur de code ;
- **25 vrais doublons** seulement hors artefacts de review : « 0 faux même » sur cet effectif ne
  prouve pas qu'il n'y en aura jamais ;
- les findings qui portent sur les artefacts de review eux-mêmes (un `head_sha` en retard sur
  HEAD, par exemple) sont un bruit connu du relecteur : la mesure se lit sans eux.

## Point d'extension : avant_ledger_round

Au stage CODE, dans la boucle de review, entre `codex-diff-review.sh` et le geste qui réconcilie
les clés. Avec l'option active, `codex-diff-review.sh` écrit aussi le corps des findings, à côté
du fichier de findings (`<rapport>.findings.corps.json`). Puis :

```bash
node harness/scripts/jev-rattacher.mjs code <id> --findings <rapport>.findings.json
```

- Il réécrit, dans le fichier de findings, la clé de chaque finding rattaché (celle du connu, le
  titre du relecteur reste), avec une sévérité jamais plus basse. Le fichier garde sa forme
  fermée : `ledger-round` le lit tel quel.
- Il écrit dans l'état, sous `extensions.jev` : le corps des findings envoyables (pour comparer
  au round suivant), les `rattachements` et les `signalements`, chacun avec son round, son score
  et le modèle qui a réellement répondu. Chaque rattachement et chaque signalement a aussi sa
  ligne d'historique.
- Code 0 dans tous les cas, sauf fichier illisible (1). Une panne de Jev se dit sur la sortie
  d'erreur et dans l'historique ; le fichier de findings n'est pas touché.

Ensuite, la procédure du noyau reprend telle quelle : réconcilie à la main ce qui reste (les
signalements t'y aident), puis `ledger-round`.

Un finding **signalé** comme doublon probable d'un tranché reste neuf : `ledger-round` le range
dans `a_corriger`. Si tu confirmes le doublon, ne crée pas de Tfix, et pose après `ledger-round`
le MÊME statut que celui du tranché, avec la note qui le relie :
`etat.mjs finding <id> <clé> <statut du tranché> --note "doublon de <clé tranchée> (jev <score>) : <la décision d'origine>"`.
Si tu ne le confirmes pas, c'est un finding comme un autre.

## Point d'extension : apres_review_pr

Au stage PR, rien à lancer : `review-pr-fusionner.mjs` (appelé par `review-pr-locale.sh`)
appelle l'option AVANT la fusion. Un finding rattaché entre dans l'artefact sous la clé du connu :
le connu n'est donc plus tenu pour corrigé par absence, sa persistance monte, et il porte la
trace (`rattachements` : titre, score, modèle, clé source, persistance ajoutée). Le fichier
`review-pr.md` l'affiche (« Rattachement (option jev) »).

Ton geste : **lire les signalements**, après la relecture sécurité si l'option `mistral` est
active. Ils sont dans la sortie de `review-pr-locale.sh`, dans `review-pr.md` (« Signalement
(option jev) ») et dans le journal :

```bash
node harness/scripts/jev-rattacher.mjs journal <id>
```

- doublon probable d'un **tranché** : relis les deux findings. Même défaut : pose le MÊME statut
  délibéré que le tranché,
  `review-statut.mjs <id> <clé> <statut du tranché> --note "doublon de <clé tranchée> (jev <score>) : <la décision d'origine>"`,
  puis commite l'artefact. Autre défaut : traite-le comme un finding neuf ;
- **douteux**, **ex aequo**, **conflit** : un finding neuf comme un autre. Si tu juges que c'est
  le même défaut qu'un connu non tranché, dis-le dans la réfutation ou le correctif ; le registre,
  lui, ne se réécrit pas à la main.

## Défaire un rattachement

Un humain juge que la reformulation reconnue était un AUTRE défaut. Défaire, c'est la **rouvrir
comme neuve** : elle reprend sa propre clé, ouverte, persistance à zéro, et bloque comme tout
finding neuf. Le connu perd la persistance que le rattachement lui avait ajoutée. Son statut ne
bouge pas : s'il avait été rouvert par le rattachement, il reste ouvert (rien ne se ferme seul :
pose toi-même `corrige` après vérification). Le rattachement n'est pas effacé, il est marqué
défait, avec la note. Une même reformulation rattachée à plusieurs rounds se défait d'un seul
geste : toutes ses traces, et la plus récente donne ce qui est rouvert. Au stage CODE, un connu
remis à zéro depuis (absent d'un round, donc tenu pour corrigé) ne perd pas la persistance gagnée
après : la trace porte alors `remis_a_zero`. Si un round a été joué sans l'option depuis le
rattachement, la persistance est incertaine, et défaire n'en retire rien (l'escalade n'est
jamais retardée).

```bash
node harness/scripts/jev-defaire.mjs pr <id> <clé du connu> <clé source> --note "<qui, pourquoi>"
node harness/scripts/jev-defaire.mjs code <id> <clé du connu> <clé source> --note "<qui, pourquoi>"
```

La clé source est dans le rattachement (`cle_source`). Au stage PR, commite ensuite les deux
fichiers de l'artefact, comme après tout statut posé. Au stage CODE, le geste vient APRÈS le
`ledger-round` du round qui a rattaché.

## Panne : l'option se tait, et le dit

Clé absente, accord absent, réseau coupé, réponse HTTP non réessayable (429 et 5xx se
réessaient, le reste non, dont `400 max_tokens_exceeded`), réponse mal formée, délai dépassé,
contrôle des chemins exclus impossible : **aucun rattachement**, et le registre suit exactement
la règle de 1.1.0. Le message commence toujours par `option jev indisponible : <motif>`, sur la
sortie d'erreur, avec une ligne d'historique au stage CODE et une ligne au journal. La review ne
s'arrête jamais à cause de l'option : c'est une aide à la convergence, pas une garde.

Une panne qui dure se voit donc, mais ne bloque rien : la boucle revient au comportement sans
l'option, où le superviseur réconcilie les clés à la main.

## Activer, et prouver

1. Une clé TypeSafe AI, posée dans `TYPESAFE_API_KEY` ou dans le fichier `fichier_cle`, hors du
   dépôt (un fichier de clé DANS le dépôt est refusé : il partirait avec lui).
2. Dans `harness/projet.json` : `options.jev.actif` à `true`, et l'accord d'envoi.
3. `/harness-install`, qui pose les fichiers, puis :

```bash
node harness/scripts/jev-rattacher.mjs preflight            # accord et présence de la clé, sans rien envoyer
node harness/scripts/jev-rattacher.mjs preflight --appel    # plus un appel réel, sur une paire d'exemple
```

Le second seul prouve que la clé et le réseau marchent. Il affiche le modèle qui a réellement
répondu : s'il n'est pas celui de la configuration, les seuils ne valent pas, re-mesure.

## Re-mesurer

**Quand** : à chaque changement de modèle (même une version mineure), de formulation de la
question (`QUESTION` dans `lib/jev.mjs`), ou de relecteur de code (un autre relecteur reformule
autrement). Et une fois, sur ton propre dépôt, avant de faire confiance aux défauts : ils
viennent d'un autre projet.

**Le protocole** :

```bash
node harness/scripts/jev-mesurer.mjs paires --sortie harness/.travail/jev/paires.json
node harness/scripts/jev-mesurer.mjs interroger --paires harness/.travail/jev/paires.json --scores harness/.travail/jev/scores.json [--modele <version>]
node harness/scripts/jev-mesurer.mjs tableau --scores harness/.travail/jev/scores.json --etiquettes <etiquettes.json> [--seuils 0.5,0.6,0.7,0.8,0.9]
```

1. `paires` construit les paires candidates depuis les artefacts de review de PR du projet :
   deux findings du même fichier, d'un même artefact, vus pour la première fois à deux commits
   différents. Les exclusions de l'option s'appliquent (chemin exclu, motif de secret). Aucun
   appel.
2. **Deux étiqueteurs indépendants** étiquettent chaque paire, sans voir les scores ni l'avis de
   l'autre : `{ "<id>": "meme" | "different" }`. « Même » veut dire : même défaut au même endroit,
   un seul correctif ferme les deux. La même classe de défaut sur un autre chemin, l'autre côté,
   une autre forme d'entrée, ou un défaut créé par le correctif du premier, c'est « différent ».
3. Les **désaccords sont exclus** : le fichier d'étiquettes ne garde que les paires où les deux
   étiqueteurs disent la même chose.
4. `interroger` pose chaque paire dans les deux ordres et garde le minimum (il exige l'accord
   d'envoi et la clé, pas `actif` : on mesure avant d'activer). Il reprend là où il s'est
   arrêté.
5. `tableau` imprime, par seuil, les doublons reconnus et les nouveaux défauts tus, avec et sans
   les artefacts de review, et le plus proche faux « même ». Choisis `seuil_haut` avec zéro
   nouveau défaut tu et une marge au-dessus du plus proche faux « même » ; `seuil_bas` sous ce
   dernier. Écris dans la configuration la version mesurée ET les seuils, ensemble.

## Ce que l'option ne garantit pas

- **Un score n'est pas une preuve.** La mesure est petite (voir ses limites) : un faux « même »
  rattacherait un défaut neuf à un défaut connu. Le dommage est borné par construction : le
  finding reste ouvert et bloquant, il monte seulement plus tôt à l'arbitre, et le rattachement
  se lit dans l'état ou l'artefact, et se défait.
- **Un doublon d'un tranché n'est que signalé.** Si le superviseur ne lit pas les signalements,
  le défaut tranché revient comme neuf, exactement comme sans l'option.
- **L'exclusion protège des chemins, pas du contenu** : un finding d'un fichier permis peut citer
  du code d'un fichier exclu dans son corps. Le filtre des secrets reconnaît des motifs, pas
  toutes les formes d'un secret ; il écarte aussi, par prudence, toute longue suite de lettres et
  de chiffres (un SHA de commit dans un corps, par exemple).
- **Un relecteur qui change de fichier** en reformulant (le défaut cité dans l'appelant plutôt
  que dans l'appelé) n'est pas reconnu : la comparaison ne se fait que dans le même fichier.
