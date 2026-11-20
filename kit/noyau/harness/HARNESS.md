# Le harness : ce qu'il est, et pourquoi il est fait ainsi

Ce document explique. Il ne dit pas quoi faire, ni avec quelles valeurs :

| Tu cherches | C'est dans |
|---|---|
| quoi faire à chaque pas | `.claude/commands/harness.md` (la seule procédure) |
| une valeur : branche, commande, seuil, chemin | `harness/projet.json` (la seule configuration) |
| ce qu'est le projet | `harness/PROJET.md` |
| où en est une story | `<chemins.etat>/<id>.json`, écrit par `harness/scripts/etat.mjs` |
| pourquoi une règle existe | ici |

Une règle écrite à deux endroits finit par dire deux choses. Si tu trouves une procédure ou
un seuil dans ce fichier, c'est un défaut : corrige-le.

## En une minute

Le harness fait avancer une **story** (une unité de travail livrable seule) le long d'une
chaîne de stages, en confiant chaque stage à un agent spécialisé et chaque relecture à un
**autre modèle** que celui qui a écrit. Un superviseur enchaîne les stages tout seul et
s'arrête dès qu'une décision revient à un humain.

```
INIT -> SPEC -> CHALLENGE -> (gate de spec) -> PLAN -> PLAN_REVIEW -> CODE -> QA
     -> PR -> REGARD -> NOTE -> (gate de merge) -> DONE
```

| Stage | Qui travaille | Ce qui en sort |
|---|---|---|
| INIT | le superviseur | l'état, la branche, `brief.md` |
| SPEC | l'analyste (`harness-ba`) | `spec.md` |
| CHALLENGE | le relecteur, puis l'analyste | `codex-challenge.json`, `challenge.md`, la spec révisée |
| PLAN | l'architecte (`harness-archi`) | `plan.md`, `tasks.md` |
| PLAN_REVIEW | le relecteur | `codex-plan-review.json` (rigueur complète seulement) |
| CODE | le codeur (`harness-codeur`), une tâche à la fois | des commits ; en rigueur complète, la boucle de review |
| QA | le testeur (`harness-qa`) | `qa-rapport.md`, GO ou NO-GO |
| PR | le superviseur et le relecteur | la PR, `review-pr.json` et `review-pr.md` |
| REGARD | le superviseur, devant le rendu réel | `regard-aval.md`, des captures (si un utilisateur voit le résultat) |
| NOTE | l'option `note_story` | la note de la story (si l'option est active) |
| gate de merge | l'approbateur | le merge, puis `DONE` |

Trois façons de s'arrêter, et seulement trois : une **attente** (`waiting_gate_*`, une
décision humaine est demandée), un **arrêt** (`stopped_*`, un plafond ou une panne), ou
`DONE`.

## Pourquoi une passe s'arrête au premier point humain

Un agent qui continue après une question sans réponse choisit à la place de quelqu'un. Le
harness est fait pour avancer seul sur tout ce qui est mécanique, et pour rendre la main
exactement là où le jugement d'un humain change le résultat : une question de produit, un
désaccord tenace entre deux modèles, un périmètre sensible, le merge. Entre deux de ces
points, il ne demande rien.

L'inverse est vrai aussi : une question posée pour se couvrir est du temps volé. Le
superviseur tranche ce qu'il peut trancher, note sa décision dans l'état, et la liste à la
gate suivante. L'approbateur relit des décisions prises, il ne débloque pas des hésitations.

Une question posée ne se perd pas en route. Un accord donné sans réponse laisserait croire
que tout est tranché, et le code s'écrirait sur un point que personne n'a décidé. Chaque
réponse est donc notée avant l'accord, la spec est révisée avec elle, et l'état refuse
d'ouvrir le stage CODE tant que la spec porte une question marquée.

## Pourquoi deux cadrans, et pourquoi le léger par défaut

Le pipeline complet paraît toujours plus prudent. C'est le piège : appliqué partout, il
transforme une page qui affiche quatre nombres en quarante exigences et une matinée de
relectures, et personne ne lit plus rien.

D'où deux réglages indépendants :

- **La rigueur** répond à « qu'est-ce qui casse si on se trompe ? ». Elle ne monte que sur un
  fait lisible : un fichier touché sous un chemin déclaré sensible. Pas « au jugé », pas « par
  prudence ». La charge de la preuve est du côté de la lourdeur.
- **Le regard client** répond à « un utilisateur le voit-il ? ». Il est indépendant du
  premier : un texte d'écran peut être sans risque technique et faux pour celui qui le lit.

Les deux ne font que monter. Redescendre après avoir dépensé, c'est décider que le risque
nommé a disparu parce qu'on est fatigué.

Le **budget** du régime léger est une limite et non un conseil pour la même raison : rien
n'empêche un rédacteur consciencieux d'ajouter une exigence de plus, sauf un plafond. Une
story qui déborde est mal découpée ; la couper est un meilleur geste que d'allonger sa spec.

## Pourquoi un autre modèle relit

Le modèle qui a écrit un texte ou un code relit avec les mêmes angles morts qu'il avait en
l'écrivant. Un second modèle, d'un autre fournisseur, ne les partage pas. C'est la raison
d'être du relecteur, et c'est pourquoi il intervient quatre fois : sur la spec, sur le plan,
sur le diff en cours de code (rigueur complète), et sur la PR.

Six précautions l'entourent, chacune née d'un incident réel :

- **Lecture seule, imposée et vérifiée.** Un CLI de relecture lancé dans un dépôt de confiance
  peut y écrire. Les scripts imposent la lecture seule, puis comparent le dépôt avant et
  après. S'il a bougé, la sortie est écartée et rien n'est annulé à l'aveugle : annuler « pour
  nettoyer » détruirait aussi le travail en cours.
- **Un relecteur à la fois, et aucun écrivain pendant qu'il lit.** Le contrôle d'empreinte ne
  sait pas QUI a écrit. Un codeur qui écrit pendant une relecture, ou un second relecteur qui
  pose son artefact, ferait écarter une relecture saine, ou pire, inviterait à « réparer » en
  détruisant un travail en cours. Chaque script de relecture prend donc le même verrou du
  checkout, et le superviseur ne délègue rien au codeur pendant qu'un relecteur tourne.
- **Une sortie vide est un échec.** Un relecteur en panne, hors quota ou non authentifié rend
  parfois un code de succès et rien d'autre. Si on pose ce rien dans un fichier, il se lit
  ensuite comme « aucun défaut ». La sortie s'écrit donc dans un fichier temporaire, se
  valide, et ne remplace l'ancienne que si elle est exploitable.
- **« Aucun défaut » se prouve.** Un relecteur qui n'a rien pu lire peut finir poliment par
  « je n'ai pas pu relire », et cette phrase ressemble à une review propre. Une review sans
  finding n'est donc acceptée que si le journal du relecteur montre deux faits : il est allé
  au bout de son tour, et au moins une de ses commandes dans le dépôt a réussi. La règle ferme
  le refus sans lecture ; elle ne juge pas la qualité d'une lecture.
- **Ses objections ne sont pas des ordres.** Un relecteur trouve toujours quelque chose. C'est
  le superviseur qui décide ce qui entre, et il écrit ce qu'il écarte : une objection écartée
  sans trace revient au tour suivant.
- **L'accord d'envoi est explicite.** Relire, c'est envoyer du code à un service externe. La
  configuration porte cet accord, et une liste de chemins à ne jamais envoyer. Cette liste est
  une consigne donnée au relecteur et un refus de partir quand le diff touche ces chemins ; ce
  n'est pas une barrière technique sur ce que le CLI peut lire dans le dépôt.

## Pourquoi les commandes se prouvent avant de servir

Une commande de test supposée (« ce doit être `npm test` ») échoue pour une raison qui n'a
rien à voir avec la story, et le harness passe sa première journée à déboguer son installation.
Chaque commande déclarée est donc lancée une fois à l'installation ; son code et sa durée
sont notés dans la configuration. Une commande jamais prouvée est refusée avec un code à
part, pour qu'on ne la confonde ni avec un test rouge ni avec un test vert.

Et les vérifications se lancent **sans pipe**. Derrière un pipe, le code de sortie est celui
de la dernière commande : un filtre d'affichage qui réussit masque un test qui échoue. C'est
arrivé, et une PR est partie avec une gate rouge. La même règle vaut pour une commande
déclarée qui contient elle-même un pipe : la gate la lance de façon que l'échec de n'importe
quel maillon la rende rouge.

## Pourquoi un seul script écrit l'état

L'état d'une story est ce qui permet de reprendre après une coupure, de savoir qui attend
quoi, et de prouver qu'une gate a été franchie par la bonne personne. Écrit à la main, il
dérive : un champ change de forme d'une story à l'autre, une clé de circonstance s'ajoute, et
au bout de quelques mois plus aucun outil ne peut le lire sans cas particuliers.

`etat.mjs` est donc le seul écrivain. Il valide contre un schéma fermé, écrit de façon
atomique, et refuse les transitions qui n'ont pas de sens : sauter un stage, franchir une
gate en attente, déclarer `DONE` sans preuve du merge. Un refus de sa part est une règle qui
s'applique. Les options ont leur tiroir (`extensions`), pour ne jamais avoir à ouvrir le
schéma.

## Pourquoi un registre des findings, et une échelle d'escalade

Sans mémoire, une boucle de review ne converge pas : le relecteur reformule le même défaut,
le codeur le réfute de nouveau, et chaque tour ressemble au premier. Le registre donne à
chaque finding une **clé stable** (le fichier et le titre, jamais le numéro de ligne, qui
bouge à chaque correctif) et compte combien de fois il a survécu.

Un finding qui survit n'est plus un défaut à corriger, c'est un **désaccord**. Continuer la
boucle ne le résout pas. L'échelle est alors :

1. **l'arbitre** : le même relecteur, mais dans un contexte neuf, sans le débat. Il lit le
   code et les deux positions ;
2. **l'humain**, si l'arbitre ne suffit pas.

Avec l'option `mistral`, l'arbitre est un modèle d'un autre fournisseur, et un étage de plus
s'insère avant l'humain : la **tranche finale**, une décision contraignante d'un troisième
avis, pour un désaccord qui a survécu à l'arbitrage et à un round de correction. Elle ne
s'applique jamais à un défaut critique, ni à un cas du plancher, ni à un périmètre interdit :
ceux-là restent à l'humain.

L'arbitre a une portée bornée : il peut fermer seul un défaut mineur qu'il juge faux, pas un
défaut grave. Sur un défaut grave, deux modèles en désaccord sont une information que
l'approbateur doit avoir.

Un finding tranché le reste. S'il est re-signalé, on le note et on passe : rouvrir le débat à
chaque tour annule l'intérêt de l'avoir tranché.

## Pourquoi la review de PR est un fichier commité

Attendre qu'un service poste sa review sur la PR, c'est dépendre d'un tiers qui peut se taire
sans prévenir, et un silence ressemble à « rien à dire ». Un connecteur de review est déjà
resté muet un mois sans que personne ne le voie.

La review de PR est donc lancée sur la machine, et son résultat est un **artefact commité avec
la branche**. La gate relit ce fichier et répond par trois codes : propre, findings ouverts,
ou review absente ou périmée. L'artefact porte le commit qu'il a relu ; dès que du code bouge
après, il est périmé et la gate se ferme. Les documents de la story, son état et ses captures
ne le périment pas : ce ne sont pas eux qu'on certifie.

La gate ne répond « propre » que si le fichier qu'elle lit est celui que porte le commit. Un
statut posé sur le disque et pas encore commité ne certifie rien : la personne qui approuve
lirait, sur la branche, un finding encore ouvert.

Le statut d'un finding est un **champ énuméré**, posé par un script, jamais une phrase
interprétée. Une gate qui cherche un mot dans un commentaire se ferme par accident le jour où
quelqu'un écrit « ce n'est pas corrigé ».

## Pourquoi la boucle de review a une règle d'arrêt

Chaque correctif est du code neuf, donc une surface neuve pour le relecteur. Passé un certain
point, les défauts trouvés viennent des correctifs et non de la story, et ils sont de plus en
plus étroits. Tourner encore coûte plus que ce qui reste à trouver. La règle d'arrêt demande
de le reconnaître, de le dire à l'approbateur avec le compte des rounds, et de lui laisser le
dernier mot.

## Pourquoi on regarde le rendu réel

Un diff dit ce qui a changé dans le code. Il ne dit pas ce que voit l'utilisateur : un texte
tronqué, un chiffre faux affiché avec assurance, un message d'erreur incompréhensible, deux
écrans qui se contredisent. Seul un lecteur placé devant le rendu le voit. Le stage REGARD
exige donc une capture du produit en marche, et refuse de la remplacer par la lecture du diff
ou par une adresse : si le rendu n'a pas pu être regardé, on l'écrit tel quel.

## Pourquoi une gate est toujours notifiée

Le harness d'origine n'envoyait que les alertes graves. Résultat : des stories prêtes
attendaient des jours une approbation que personne ne savait devoir donner. Une attente que
l'approbateur n'apprend pas est une panne silencieuse. Le niveau `gate` part donc toujours,
sans filtre ; seules les alertes répétées sont espacées.

La notification dit aussi ce qui **n'a pas** été vérifié. Un compte rendu qui ne liste que
les succès se lit comme « tout a été vérifié ».

## Pourquoi la boucle est bornée

En mode autonome, une story peut tourner sans témoin. Deux bornes l'empêchent de brûler du
temps et des crédits : un plafond de tours par story, et un seuil d'échecs consécutifs du
même pas. Les deux mènent à un arrêt nommé, avec une alerte, et la reprise est un geste
humain.

« Échec » a un sens étroit : un composant n'a pas fait son travail. Un test rouge, un NO-GO,
des findings sont des résultats, et ils ont chacun leur chemin. Les confondre mène soit à
s'arrêter pour rien, soit à maquiller une panne en résultat.

## Pourquoi des périmètres interdits et une garde de production

Certains fichiers engagent plus que du code : des textes légaux, des prix, des migrations
déjà appliquées, des clés. Aucun agent n'y écrit sans une approbation notée dans l'état.
S'en approcher n'est pas une faute : c'est une attente comme une autre.

Le banc local, lui, charge parfois par défaut la configuration de production. Un exercice de
QA a déjà écrit dans une base réelle de cette façon. Avant de démarrer quoi que ce soit,
`banc.sh` lit donc les variables d'environnement déclarées et refuse si l'une vise une cible
de production. Il n'arrête que ce qu'il a lancé, par son identifiant exact : arrêter « tout ce
qui porte ce nom » a déjà coupé le service d'un autre projet.

## Pourquoi les permissions ne suffisent pas

L'installateur propose une liste de permissions : les scripts du harness sont autorisés, le
merge et le push vers les branches protégées sont refusés. C'est une ceinture, pas un verrou :
une règle de permission compare l'écriture d'une commande à un motif, et une même action peut
s'écrire de plusieurs façons. Le vrai verrou est sur la forge : **la protection de la branche
d'intégration et de la branche de production**, avec une approbation humaine obligatoire.
Sans elle, « le harness ne merge jamais » est une consigne. Avec elle, c'est un fait.

## Les options

Le noyau suffit. Cinq options s'y branchent sans le modifier, par des points d'extension
que le superviseur nomme dans sa procédure. Chacune s'explique dans son propre fichier,
`harness/options/<nom>.md` :

| Option | La question à laquelle elle répond |
|---|---|
| `valeur` | ce défaut est réel, mais vaut-il d'être corrigé maintenant ? |
| `personas` | que dirait un utilisateur type devant ce brief, puis devant cet écran ? |
| `note_story` | dans six mois, où lira-t-on ce que cette story a décidé ? |
| `creneaux` | peut-on mener deux stories en même temps sans qu'elles se marchent dessus ? |
| `mistral` | un second service relit-il la sécurité de chaque PR, et départage-t-il les désaccords ? |

N'en active aucune avant d'avoir mené quelques stories avec le noyau seul : une option répond
à un problème qu'on a eu, pas à un problème qu'on imagine.

## Opérer

- `/harness init <id> "<titre>" "<brief>"` ouvre une story.
- `/harness <id>` joue une passe. `/loop /harness <id>` les enchaîne jusqu'à la prochaine
  attente : c'est le mode normal.
- `/harness-status` montre toutes les stories et ce qui est attendu de qui.

| La story est en | Ce que ça veut dire | Le geste |
|---|---|---|
| `waiting_gate_spec` | des questions de produit sont posées | y répondre, puis `/harness approve <id>` |
| `waiting_gate_plan` | le plan porte un risque à valider | lire `plan.md`, puis approuver ou renvoyer |
| `waiting_gate_scope` | la story touche un périmètre sensible, ou déborde | autoriser en donnant la limite, ou renvoyer |
| `waiting_gate_arbitrage` | deux modèles sont en désaccord | trancher, puis approuver |
| `waiting_gate_merge` | la PR est prête | la relire, la merger, puis `/harness approve <id>` |
| `stopped_max_tours` | le plafond de tours est atteint | lire le dernier blocage, puis `/harness resume <id>` |
| `stopped_error` | le même pas a échoué plusieurs fois | réparer la cause, puis `/harness resume <id>` |

`/harness renvoyer <id> <STAGE> "<motif>"` remplace une approbation quand le travail est à
reprendre : le motif devient la consigne du stage visé.

**Après le merge, il reste un geste.** `/harness approve <id>` constate que la PR est
réellement mergée, passe la story en `DONE`, et ouvre une petite PR de clôture depuis une
branche neuve : elle ne porte que l'état et les documents de la story. Un commit ajouté à la
branche déjà mergée n'arriverait nulle part. Tant que cette PR de clôture n'est pas mergée,
les autres branches voient encore la story en attente.

## Limites connues

- **Un seul relecteur de code.** Si son CLI est en panne, le harness s'arrête au lieu de
  continuer sans relecture. C'est voulu, et c'est une dépendance. L'option `mistral` ajoute un
  second service pour la sécurité et l'arbitrage, pas une seconde review de code ; elle ajoute
  aussi une seconde dépendance : son CLI en panne bloque la gate de PR.
- **Deux modèles peuvent avoir tort ensemble.** La relecture croisée réduit les angles morts,
  elle ne les supprime pas. La QA sur le produit en marche et le regard sur le rendu existent
  pour cette raison.
- **La review certifie un commit, et le relecteur lit l'arbre de travail.** La review de PR
  refuse donc de partir tant qu'un fichier suivi est modifié sans être commité : un correctif
  resté dans l'arbre cacherait au relecteur un défaut du commit certifié. Un fichier jamais
  ajouté à Git n'arrête pas la review, parce qu'un arbre de travail en porte presque toujours :
  elle le signale seulement, et le relecteur peut l'avoir lu.
- **Un chemin exclu est une consigne, pas une barrière.** Chaque appel au relecteur la porte,
  et une review de diff refuse de partir si le diff touche un de ces chemins. Mais le relecteur
  lit l'arbre de travail : un fichier qui ne doit jamais sortir de la machine n'a pas sa place
  dans le dépôt.
- **La garde des questions ne voit que les marques de la spec.** Une question du relecteur
  qui n'y est pas reportée n'est tenue que par la procédure.
- **Le kit a été vérifié sous Linux.**
- **Le harness ne choisit pas les stories.** Décider quoi construire reste un geste humain.

## Mettre à jour le kit

Déposer la nouvelle version (`poser.sh <ce dépôt>`, depuis l'archive), puis relancer
`/harness-install`. Chaque fichier posé a laissé son empreinte dans
`harness/kit-installe.json` : un fichier resté intact est remplacé, un fichier modifié sur
place n'est jamais écrasé, et la nouvelle version arrive à côté, en `<fichier>.nouveau`, à
comparer à la main. Ne sont jamais touchés : `harness/projet.json`, `harness/PROJET.md`, les
états, les dossiers de stories, les reviews.

Activer une option plus tard suit le même chemin : passer son `actif` à `true` dans
`harness/projet.json`, puis relancer `/harness-install`, qui pose ses fichiers et recalcule
les permissions. Une option coupée laisse ses fichiers en place : ils sont signalés, pas
supprimés.
