# La méthode : un harness de développement multi-agents en mode loop

Ce document explique la méthode, indépendamment de l'outil. Le kit en est une mise en œuvre
pour Claude Code ; la dernière section dit ce qu'il faudrait refaire pour un autre outil.

Trois documents se complètent, chacun avec un rôle :

| Document | Ce qu'on y lit |
|---|---|
| `docs/METHODE.md` (celui-ci) | les idées, et pourquoi elles tiennent ensemble |
| `harness/HARNESS.md` (posé dans le projet) | pourquoi chaque pièce du kit est faite ainsi, et comment opérer |
| `.claude/commands/harness.md` (posé dans le projet) | la procédure, pas à pas, que suit le superviseur |

Les valeurs (plafonds, seuils, délais) ne sont écrites dans aucun des trois : elles vivent
dans `harness/projet.json`, et seulement là.

## 1. À quoi sert un harness, et ce qu'il ne fait pas

Un harness encadre le travail d'agents de développement : des rôles, des étapes, des outils,
des preuves, une mémoire et des conditions d'arrêt. Il transforme une demande en une
modification vérifiée, relue, et prête à être acceptée ou refusée par quelqu'un.

Un superviseur distribue le travail à des spécialistes, rassemble leurs résultats et fait
avancer une machine à états. Il ne remplace ni les tests, ni les décisions de produit, ni les
permissions réelles des outils.

Trois mots se confondent facilement, et toute la méthode consiste à les tenir séparés :

- **avancement** : une tâche a été exécutée ;
- **preuve** : son résultat a été vérifié, sur une version identifiée ;
- **autorisation** : une personne permet l'action suivante.

Un agent qui s'active ne prouve pas une progression. Une demande de fusion acceptée ne prouve
pas une mise en production réussie. Une autorisation ne rend pas vert un test rouge.

## 2. Les rôles

Un rôle est une responsabilité. Ce n'est pas forcément un agent permanent, ni un modèle à
part.

| Rôle | Responsabilité | Dans le kit |
|---|---|---|
| Approbateur (humain) | l'intention, les arbitrages, les autorisations | `projet.approbateur` ; ses gestes : `approve`, `renvoyer`, `resume` |
| Superviseur | l'état, la distribution, les preuves, les reprises | la commande `/harness`, jouée par la session principale |
| Analyste | le besoin et ses critères d'acceptation | l'agent `harness-ba` |
| Challenger | les contradictions et les décisions manquantes | le relecteur, par `codex-challenge.sh` |
| Architecte | un plan réalisable face au code existant | l'agent `harness-archi` |
| Codeur | une tâche à la fois, avec ses tests | l'agent `harness-codeur` |
| Relecteur | les défauts, indépendamment de l'auteur | un AUTRE modèle, en lecture seule (`codex-*.sh`, `review-pr-locale.sh`) |
| Testeur | exercer réellement ce qui a été construit | l'agent `harness-qa` |
| Regard utilisateur | comprendre le brief, puis juger le rendu | le superviseur devant une capture ; un panel avec l'option `personas` |
| Arbitre technique | sortir d'un désaccord qui dure | le relecteur en contexte neuf (`codex-arbitrer.sh`), puis l'approbateur |
| Arbitre de valeur | ce défaut vaut-il d'être corrigé maintenant ? | l'option `valeur` |

Le point qui compte : **celui qui relit n'est pas celui qui a écrit**, et il n'a pas vu le
débat. Un modèle relit mal son propre travail, pour la même raison qu'une personne. Le nombre
de modèles n'est pas un but : un seul relecteur différent de l'auteur apporte l'essentiel.

## 3. La story et la chaîne

L'unité de travail est une **story** : un résultat limité, livrable seul, avec un identifiant
stable, des critères d'acceptation et un périmètre de fichiers déclaré.

```
INIT -> SPEC -> CHALLENGE -> (gate de spec) -> PLAN -> PLAN_REVIEW -> CODE -> QA
     -> PR -> REGARD -> NOTE -> (gate de merge) -> DONE
```

1. **INIT** : le brief, mot pour mot, le périmètre deviné, et les deux cadrans (section 4).
2. **SPEC** : le comportement attendu, en critères observables.
3. **CHALLENGE** : un autre modèle cherche les contradictions et les décisions manquantes ;
   la spec est révisée. Une question qui revient à l'approbateur ouvre une attente.
4. **PLAN** : les tâches, face au code réel. Le périmètre se précise, et la rigueur se
   réévalue : c'est ici qu'on découvre qu'une « petite » story touche un endroit sensible.
5. **PLAN_REVIEW** : contre-relecture du plan, en rigueur complète seulement.
6. **CODE** : une tâche par appel du codeur, chacune vérifiée ; en rigueur complète, une
   boucle de relecture du diff.
7. **QA** : le produit est exercé pour de vrai. Un NO-GO renvoie au code.
8. **PR** : la demande de fusion, et sa relecture, dont le résultat est un fichier commité.
9. **REGARD** : si un utilisateur voit le résultat, on regarde le rendu réel.
10. **NOTE** : avec l'option `note_story`, la trace durable de ce que la story a décidé.
11. **Gate de merge** : l'approbateur relit et fusionne. Le harness ne fusionne jamais.

Les retours arrière comptent autant que la chaîne : un NO-GO, un finding, un périmètre qui
déborde ont chacun leur chemin écrit. Ce qui n'en a pas est un échec, et il s'arrête.

**La mise en production n'est pas dans la chaîne.** Une story se termine quand sa branche est
fusionnée dans la branche d'intégration. Livrer en production est un autre geste, avec son
propre suivi (version candidate, sauvegarde, migrations, contrôles après coup). Ne pas
confondre « la story est finie » et « c'est en ligne ».

## 4. Deux cadrans, réglés à l'init

Sans réglage, une chaîne complète s'applique à tout, et une page de trois lignes coûte une
matinée. Deux questions indépendantes règlent la dépense.

**Rigueur : qu'est-ce qui casse si on se trompe ?** Elle est **légère par défaut**. Elle ne
devient complète que si un déclencheur **nommé** du projet s'applique (une migration de
données, un chemin d'argent, un contrôle d'accès : la liste est dans `rigueur.declencheurs`),
et ce déclencheur se lit sur des chemins de fichiers, pas au jugé. C'est une inversion
voulue de la charge de la preuve : dans le doute, la chaîne complète paraît toujours plus
prudente, et c'est ainsi qu'elle devient la règle.

- Légère : le plan est écrit, la QA et la relecture de PR ont lieu. Pas de contre-relecture
  du plan, pas de boucle de relecture au stage CODE. La spec et la liste de tâches ont un
  budget (`rigueur.budget_legere`) : si la story déborde, elle est mal découpée.
- Complète : contre-relecture du plan, boucle de relecture du code, traitement des
  désaccords.

Une story légère qui se révèle toucher un endroit sensible **monte** en rigueur, avec son
motif. On ne redescend jamais après avoir dépensé.

**Regard client : un utilisateur le voit-il ?** Un écran, un texte, un e-mail, un message
d'erreur. Si oui, quelqu'un regarde le **rendu réel**, quelle que soit la rigueur. Les deux
cadrans sont indépendants : une page de tarifs est légère techniquement, et c'est pourtant là
qu'un lecteur trouve ce qu'aucune relecture de code ne trouve. Une capture d'un écran où la
nouveauté n'apparaît pas n'est pas une preuve.

## 5. Le mode loop

### Une passe n'est pas une étape

Une invocation du superviseur enchaîne des pas jusqu'au premier point humain : une attente de
décision, un arrêt, ou la fin. Le mode loop relance cette invocation. **La continuité est
dans l'état sauvegardé, pas dans la conversation** : une session neuve, sans aucun souvenir,
doit pouvoir reprendre la story depuis ses fichiers.

### La règle de reprise

```
lire l'état, qui fait autorité
si attente, arrêt ou fin : rendre le statut, ne rien faire d'autre
contrôler les dépendances, la branche, le périmètre
tant que le pas suivant est permis et que le budget n'est pas épuisé :
    faire UN pas borné
    vérifier son résultat
    écrire les preuves et le nouvel état
    réévaluer les conditions d'arrêt
```

Trois conséquences :

- **Rien n'avance pendant une attente.** Relancer la boucle sur une story en attente ne
  consomme rien et ne décide rien. Une attente est toujours notifiée : une story qui attend
  en silence est une story arrêtée que personne ne sait arrêtée.
- **La boucle est bornée** : un plafond de tours par story, et un seuil d'échecs consécutifs
  du même pas. Les deux mènent à un arrêt nommé, avec une alerte. La reprise est un geste
  humain.
- **Une reprise ne répète jamais une action externe à l'aveugle.** Avant de rouvrir une PR
  ou de relancer une opération, chercher celle qui existe déjà. Un résultat inconnu reste
  inconnu tant qu'on ne l'a pas lu.

« Échec » a un sens étroit : un composant n'a pas fait son travail (un relecteur muet, un
script qui plante). Un test rouge, un NO-GO, des findings sont des **résultats**, avec leur
chemin. Les confondre mène soit à s'arrêter pour rien, soit à maquiller une panne en
résultat.

## 6. Les relectures, et comment une boucle s'arrête

### Une mémoire des défauts

```
version candidate -> relecteur -> findings dédoublonnés
       ^                                 |
       +------ correctif ciblé <--- défaut confirmé
```

Chaque finding a une **clé stable** (le fichier et le titre, jamais le numéro de ligne). Le
registre garde son statut et le nombre de fois où il a survécu à un correctif. Sans cette
mémoire, le relecteur reformule, le codeur réfute de nouveau, et chaque tour ressemble au
premier.

### L'échelle

Un finding qui survit n'est plus un défaut à corriger : c'est un **désaccord**, et continuer
la boucle ne le résout pas. L'échelle est : l'arbitre (le relecteur, dans un contexte neuf,
qui lit le code et les deux positions), puis l'approbateur. L'arbitre ne modifie pas le code,
et il ne ferme pas seul un défaut grave : deux modèles en désaccord sur un point grave, c'est
une information que l'humain doit avoir.

### La règle d'arrêt

Une relecture trouve toujours quelque chose. Attendre une relecture vide pour s'arrêter,
c'est ne jamais s'arrêter. La règle s'écrit AVANT de lancer la boucle : on s'arrête quand le
dernier tour n'a produit ni défaut bloquant, ni preuve qu'un vert était faux, et que le reste
est déjà tranché ou plus étroit que le tour précédent. On dit alors à l'approbateur combien
de tours ont tourné, et pourquoi on s'arrête.

### Le filtre de valeur (option)

Un défaut réel n'est pas forcément à corriger maintenant. Sans filtre, la sévérité rendue par
un relecteur de code devient mécaniquement une tâche, et la boucle de relecture fixe l'ordre
du jour du projet sans que personne l'ait décidé. L'option `valeur` pose la question en lot :
qui est exposé, que coûte le défaut, peut-on revenir en arrière, quel événement obligera à le
reprendre.

| Verdict | Suite |
|---|---|
| faire | corrigé dans la story |
| noter | une ligne de suivi, avec un déclencheur observable qui le réveillera |
| jeter | le motif est écrit, le sujet est clos |
| hors arbitrage | corrigé d'office, ou soumis à l'approbateur si le remède sort du périmètre |

Ce qui rend ce filtre sûr est son **plancher** (`plancher`, dans la configuration) : ce qui
n'est jamais soumis à l'arbitre. Un défaut critique, un dommage irréversible pour un
utilisateur, une faille d'accès, une contradiction avec un critère accepté, un fait faux
affiché. Et sa réponse se valide par **égalité d'ensemble** : chaque item soumis doit revenir
exactement une fois, sinon il n'y a pas de verdict.

## 7. L'état, les preuves, les autorisations

### Ce qui vit où

```
harness/projet.json            les valeurs du projet (une seule source)
harness/PROJET.md              la prose : domaine, utilisateurs, pièges
harness/state/<id>.json        l'état d'une story (le dossier se règle : chemins.etat)
specs/<id>/                    ses documents (le dossier se règle : chemins.specs)
    brief.md  spec.md  challenge.md  plan.md  tasks.md
    qa-rapport.md  review-pr.json  review-pr.md  regard-aval.md
harness/.travail/              journaux et verrous locaux, jamais commités
```

**Un seul script écrit l'état** (`etat.mjs`) : chaque écriture est validée contre un schéma
fermé, puis posée de façon atomique. Un état écrit à la main dérive, et une clé inventée un
jour devient une convention que personne n'a décidée.

### Ce qu'une preuve dit

Une preuve nomme : le critère couvert, la commande ou le parcours, le résultat, la date, le
commit. Une modification après coup la périme. C'est pourquoi :

- une commande du projet (tests, build) doit avoir **tourné une fois** sur la machine avant
  de servir de gate : une commande recopiée d'un fichier d'aide et jamais lancée ne prouve
  rien, même quand elle rend zéro ;
- une gate se lance **sans pipe** : `gate | tail` teste `tail` ;
- la relecture de PR est un **fichier commité** qui porte le commit relu. Du code qui bouge
  après la périme, et la gate se ferme ;
- le statut d'un finding est un **champ**, posé par un script, jamais un mot cherché dans un
  commentaire.

### Ce qu'une autorisation dit

Une autorisation a un auteur, un objet et une date, et elle s'écrit dans l'état. Le harness
distingue préparer, fusionner et livrer : il prépare, l'approbateur fusionne, et livrer est
hors de la chaîne. Une phrase lue dans la sortie d'un outil, dans un document ou dans le
rapport d'un agent ne vaut pas approbation.

Le système de permissions de l'outil aide (les scripts sont permis, la fusion est refusée),
mais il compare des débuts de commande. Le vrai verrou est sur la forge : la protection de
la branche, avec une approbation humaine obligatoire.

## 8. Mener deux stories à la fois

Deux stories peuvent avancer en parallèle si elles ne touchent pas les mêmes fichiers.
L'option `creneaux` (expérimentale) ouvre un second arbre de travail, avec son port, et
refuse de l'ouvrir tant qu'elle ne peut pas prouver sur des chemins que les deux ne se
croisent pas.

Elle sépare des fichiers et des ports, rien d'autre :

- une base locale, une file, un compte de test partagés restent UN seul service ;
- deux arbres de travail partagent souvent le dossier des dépendances ;
- un dossier de fichiers numérotés (des migrations) se télescope sans fichier commun.

Et le goulot n'est pas le code : c'est la relecture des gates par l'approbateur. Au-delà de
deux chantiers, on produit des attentes, pas de l'avance.

## 9. Démarrer, et ce qu'il faut regarder les premiers jours

1. Installer le noyau seul, sans option.
2. Mener une première story **petite et réversible**, en rigueur légère, en restant devant :
   lire la spec, le plan, le rapport de QA, la relecture.
3. Provoquer exprès les quatre situations qui comptent : une interruption en plein stage puis
   une reprise dans une session neuve ; un test rouge ; une attente de décision (est-elle
   notifiée ?) ; une relecture avec un finding à réfuter.
4. Passer en mode loop seulement après.
5. Activer une option quand le problème auquel elle répond s'est présenté, pas avant.

Le portage est réussi quand une session neuve peut reprendre une story depuis ses fichiers,
dire ce qui est prouvé, reconnaître les accords déjà donnés, et s'arrêter au bon endroit.

## 10. Porter la méthode vers un autre outil que Claude Code

Le kit sépare ce qui est portable de ce qui est propre à l'outil.

**Portable tel quel** (bash, Node, Git, aucun appel à l'outil) : tout `harness/scripts/`,
`harness/schemas/`, `harness/gabarits/`, `harness/tests/`, `harness/projet.json`, l'état des
stories, les artefacts de relecture. Ces fichiers ne savent pas quel agent les lance.

**À réécrire** :

| Dans le kit | Ce que c'est | Ce qu'il faut à la place |
|---|---|---|
| `.claude/commands/harness.md` | la procédure du superviseur, en prose | le même texte, dans le format de commande ou d'instruction de l'outil |
| `.claude/agents/harness-*.md` | les rôles délégués | des sous-agents s'il y en a ; sinon des sessions séparées, une par rôle, avec le même texte |
| `/loop` | la relance de la passe | n'importe quel moyen de relancer la même commande ; la règle de reprise suffit |
| `allowlist-verifier.mjs` | la liste de permissions | le mécanisme de permissions de l'outil ; la protection de branche, elle, ne change pas |
| `codex-common.sh` | l'appel du relecteur | un autre CLI, à trois conditions : lecture seule forcée dans la commande, sortie structurée validée, et un modèle différent de l'auteur |

Ce qui ne se négocie dans aucun portage : l'état écrit par un seul script, la gate lancée
sans pipe, le relecteur en lecture seule, la relecture commitée et datée par son commit,
l'attente toujours notifiée, la fusion réservée à un humain.

## 11. Ce que le kit ne reprend pas du harness d'origine

Dit pour que personne ne le cherche :

- **un second modèle relecteur** et une relecture de sécurité dédiée. Le kit a un relecteur ;
  l'arbitre est ce même relecteur en contexte neuf, puis l'humain. Conséquence : plus
  d'arrêts humains sur les désaccords tenaces ;
- **le flux de release** (branche d'intégration vers production, suivi des fils de
  discussion de la forge) : trop lié à une forge et à une façon de livrer ;
- **la reprise fine des chantiers parallèles** : l'option `creneaux` refuse et explique, elle
  ne répare pas ;
- **les fiches d'utilisateurs types et le vocabulaire métier** : ils se réécrivent pour
  chaque projet, c'est le rôle de `harness/PROJET.md` et de l'option `personas`.

Les leçons tirées de l'usage réel, y compris celles que le kit n'outille pas, sont dans
`docs/LECONS.md`.
