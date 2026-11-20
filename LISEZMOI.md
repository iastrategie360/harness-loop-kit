# Harness loop : le kit

Un harness de développement multi-agents pour **Claude Code**, à poser dans un dépôt Git.

Il mène une story (une modification limitée, livrable seule) du brief jusqu'à une demande de
fusion relue : spec, relecture contradictoire par un autre modèle, plan, code tâche par
tâche, tests, relecture du diff, puis **arrêt devant un humain**. Il ne fusionne jamais et ne
met jamais en production.

Le mode loop relance la même commande jusqu'au prochain point où une personne doit décider.
Tout ce qui compte est dans des fichiers : une session neuve reprend là où l'autre s'est
arrêtée.

## Ce qu'il faut sur la machine

| Outil | Pourquoi |
|---|---|
| Claude Code | c'est lui qui joue le superviseur et les agents |
| `git`, `bash` 4 ou plus | le harness vit dans le dépôt du projet |
| `node` 18 ou plus | les scripts du harness, même dans un projet sans JavaScript ; aucune dépendance à installer |
| `jq`, `flock`, `timeout`, `setsid`, `sha256sum`, `awk`, `sed` | présents sur toute distribution Linux courante |
| `codex` (CLI), authentifié | le relecteur : un AUTRE modèle que celui qui écrit, toujours en lecture seule |
| `gh`, authentifié | seulement si la forge est GitHub |

Le kit a été vérifié sous **Linux** seulement.

Le relecteur envoie des extraits du code à un service externe. L'installateur demande un
accord explicite avant le premier envoi ; sans accord, les relectures sont refusées, et le
harness le dit au lieu de faire semblant.

## Installer, en deux gestes

```bash
unzip harness-loop-kit-1.0.0.zip
bash harness-loop-kit-1.0.0/poser.sh /chemin/du/projet
```

`poser.sh` dépose le kit dans `<projet>/harness/.kit/` et la commande d'installation dans
`<projet>/.claude/commands/harness-install.md`. Il n'installe rien, ne règle rien, ne commite
rien. Le dossier `harness/.kit/` est un dépôt de passage : l'installateur l'ajoute à
`.gitignore` quand il pose les fichiers. D'ici là, il paraît dans `git status`, sans gêner.

Puis, **dans le projet**, ouvrir une session Claude Code et taper :

```
/harness-install
```

L'installateur, dans l'ordre de ses étapes :

0. contrôle la machine et le dépôt ;
1. explore le projet en lecture seule (manifestes, CI, branches, ports, noms des variables
   d'environnement, jamais leurs valeurs) ;
2. pose ses questions par petits lots, la valeur qu'il a trouvée proposée en premier avec sa
   source ;
3. écrit la configuration et la fiche du projet ;
4. pose les fichiers du harness et rejoue leurs tests sur ta machine ;
5. **lance chaque commande déclarée** (tests, build, démarrage) et note son code de sortie et
   sa durée : une commande jamais lancée ne sert pas de vérification ensuite ;
6. propose une liste de permissions, appliquée seulement si tu dis oui ;
7. fait un essai à blanc, envoie une notification d'essai et te demande si tu l'as reçue ;
8. écrit un compte rendu : ce qui est posé, ce qui est prouvé, ce qui reste à compléter.

Les réponses peuvent aussi se donner d'avance dans un fichier :
`/harness-install --reponses <fichier>` (forme décrite à la fin de `docs/QUESTIONNAIRE.md`).

Compte une demi-heure à une heure, surtout selon la durée des tests du projet. La liste
complète des questions est dans `docs/QUESTIONNAIRE.md` : la lire avant permet de préparer
les réponses, et même de les donner d'avance dans un fichier.

## Ensuite

```
/harness init 001-ma-story "Titre" "Le brief, en quelques phrases"
/harness 001-ma-story          une passe : avance jusqu'au prochain point humain
/loop /harness 001-ma-story    le mode loop : relance la passe
/harness-status                où en sont toutes les stories, et ce qui t'attend
/harness approve 001-ma-story  ton geste, devant une attente
```

Pour la première story, en choisir une **petite et réversible**, et rester devant : lire la
spec, le plan, le rapport de test, la relecture. Le mode loop vient après.

## Ce que contient l'archive

```
LISEZMOI.md          ce fichier
VERSION              la version du kit
MANIFESTE.json       la liste des fichiers et leurs empreintes
poser.sh             dépose le kit dans un projet
verifier-kit.sh      contrôle l'archive elle-même (syntaxe, tests, cohérence)
docs/
  METHODE.md         la méthode, indépendamment de l'outil, et comment la porter ailleurs
  QUESTIONNAIRE.md   toutes les questions de l'installateur, par lots
  LECONS.md          70 leçons tirées de l'usage réel, classées par thème
kit/noyau/           le harness : commandes, agents, scripts, schémas, gabarits, tests
kit/options/         quatre options, proposées une par une à l'installation
```

Après installation, le projet porte :

| Emplacement | Ce que c'est | À toi ou au kit |
|---|---|---|
| `harness/projet.json` | toutes les valeurs : branches, commandes, seuils, options | à toi |
| `harness/PROJET.md` | la prose : domaine, utilisateurs, pièges | à toi |
| `harness/HARNESS.md` | pourquoi chaque pièce est faite ainsi, comment opérer | au kit |
| `.claude/commands/harness*.md`, `.claude/agents/harness-*.md` | la procédure et les rôles | au kit |
| `harness/scripts/`, `harness/schemas/`, `harness/gabarits/`, `harness/tests/`, `harness/options/` | l'outillage | au kit |
| `harness/kit-installe.json` | la liste des fichiers posés et leur empreinte | au kit |
| `harness/install/` | les réponses données et le compte rendu d'installation | à toi |
| l'état des stories et leurs documents | le travail lui-même | à toi |
| `harness/.kit/`, `harness/.travail/` | le dépôt de passage et les fichiers de travail, ignorés par Git | ni l'un ni l'autre : jetables |

« Au kit » veut dire : remplacé à la mise à jour. Si tu modifies un de ces fichiers, la mise à
jour ne l'écrase pas : elle pose la nouvelle version à côté, en `<fichier>.nouveau`, et te le
dit.

## Les quatre options

| Option | Ce qu'elle ajoute | Quand l'activer |
|---|---|---|
| `personas` | un panel d'utilisateurs types : ils lisent le brief, puis regardent le rendu réel | le produit a des utilisateurs dont tu sais décrire trois ou quatre profils |
| `valeur` | un arbitre qui dit si un défaut trouvé vaut d'être corrigé maintenant, avec un plancher qu'il ne peut pas franchir | les relectures produisent plus de correctifs que tu n'en veux |
| `note_story` | une note durable par story, exigée avant la gate de merge | tu veux retrouver dans six mois pourquoi une décision a été prise |
| `creneaux` | deux stories en parallèle, dans deux arbres de travail | **expérimentale**, à laisser éteinte au début |

Conseil : commencer sans aucune. Une option s'active plus tard en passant son `actif` à
`true` dans `harness/projet.json`, puis en relançant `/harness-install`.

## Mettre à jour

Même geste qu'à l'installation : `bash poser.sh /chemin/du/projet` avec la nouvelle archive,
puis `/harness-install` dans le projet. La configuration, les états et les documents des
stories ne sont jamais touchés.

## Ce que le kit garantit, et ce qu'il ne garantit pas

Garanti par l'outillage, et couvert par les tests livrés :

- l'état d'une story est écrit par un seul script, validé contre un schéma fermé ;
- une vérification se lance sans pipe et rend son vrai code de sortie ; une commande jamais
  prouvée est refusée, elle ne passe pas pour verte ;
- le relecteur tourne en lecture seule ; s'il écrit quand même, sa sortie est écartée et la
  story s'arrête ;
- une sortie de relecteur vide ou mal formée est un échec visible, jamais « rien à signaler » ;
- la relecture d'une demande de fusion est un fichier commité, périmé dès que le code bouge ;
- la boucle est bornée (plafond de tours, seuil d'échecs), et chaque attente est notifiée.

**Pas garanti**, à savoir avant de s'y fier :

- **La liste de permissions n'est pas un verrou.** Une interdiction compare l'écriture d'une
  commande à un motif : elle arrête une erreur, pas une volonté. Le vrai verrou est sur la
  forge :
  protéger la branche de production et exiger une approbation humaine.
- **Un seul relecteur.** Le harness d'origine en croisait deux, et le second trouvait des
  défauts que le premier manquait. Ici, un désaccord qui dure remonte à toi plus souvent.
- **L'option `creneaux` sépare des fichiers et des ports, rien d'autre** : une base locale ou
  un compte de test partagés restent un seul service.
- **La mise en production n'est pas dans le harness.** Une story finit à la fusion dans la
  branche d'intégration.
- **Linux seulement** : rien n'a été essayé sous macOS ni sous Windows.

## Vérifier l'archive

```bash
bash verifier-kit.sh
```

Il contrôle la syntaxe de chaque script, rejoue les tests du kit sur un assemblage du noyau et
des options, compare les fichiers au manifeste, et cherche les pièges connus. Il ne touche à
rien hors d'un dossier temporaire. Code 0 : l'archive est saine.

## Désinstaller

Le harness ne s'accroche à rien. La liste des fichiers posés est dans
`harness/kit-installe.json` : les supprimer, avec ce registre, `harness/projet.json`,
`harness/PROJET.md`, les dossiers `harness/install/`, `harness/.kit/` et `harness/.travail/`,
leurs deux lignes dans `.gitignore`, et les règles ajoutées au fichier de permissions. Les
documents des stories et leur état restent utiles sans lui.
