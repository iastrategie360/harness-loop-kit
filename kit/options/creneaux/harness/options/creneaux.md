# Option `creneaux` : deux stories en même temps (expérimentale)

Deux stories peuvent avancer en parallèle si elles ne touchent pas les mêmes fichiers. Tout
tient dans ce « si » : l'option ne rend pas le parallèle possible, `git worktree` le fait
déjà. Elle le rend **sûr**, en refusant d'ouvrir un second chantier tant qu'elle ne peut pas
prouver, sur des chemins de fichiers, que les deux ne se croisent pas.

- **Créneau a** : l'arbre de travail principal du dépôt.
- **Créneau b** : un second arbre de travail, créé à côté (`<dossier du dépôt>-creneau-b`),
  sur la branche de sa story. Il se mène depuis **sa propre session**, ouverte dans ce dossier.

Il n'y a pas de créneau c. Deux chantiers se suivent de tête ; au-delà, c'est la relecture
des gates par l'approbateur qui devient le goulot, pas le code.

Fichiers de l'option : `harness/scripts/creneaux.sh`. Réglage : `options.creneaux` dans
`harness/projet.json`.

**Expérimentale** : c'est la version courte d'un outil plus gros. Elle couvre l'ouverture, le
contrôle de croisement, les ports et la fermeture. Elle ne sait pas reprendre un créneau
laissé dans un état bancal : dans ce cas elle refuse en disant pourquoi, et c'est à
l'approbateur de remettre d'aplomb.

## Ce que le script contrôle

Chaque créneau **déclare** sa story et son périmètre (les globs de `perimetre` dans l'état).
À chaque déclaration, face à l'autre créneau :

1. **les ressources exclusives d'abord** (`options.creneaux.ressources_exclusives`) : ce
   qu'un seul chantier peut porter à la fois, même sur des fichiers différents. L'exemple
   type est un dossier de fichiers numérotés : deux chantiers y ajoutent chacun « le
   suivant », aucun fichier n'est commun, et les deux numéros se télescopent au merge ;
2. **les fichiers suivis en commun** : le refus les nomme ;
3. **les périmètres qui peuvent se croiser** sans fichier commun aujourd'hui (l'un contient
   l'autre). Un glob qui commence par un joker est refusé dès qu'il y a deux chantiers : on
   ne prouve rien sur « tous les `.md` du dépôt ».

Le contrôle est prudent : il refuse parfois deux périmètres qui ne se seraient pas croisés.
C'est le bon sens de l'erreur. Un refus se lève en nommant les dossiers plus finement, jamais
en contournant le script.

Avant la gate de merge, `creneaux.sh verifier` compare ce que la branche a **réellement**
touché à ce qui a été déclaré. Sans lui, le périmètre serait une promesse : un fichier touché
sans avoir été déclaré est exactement celui que l'autre chantier n'a jamais vu.

## Ce que l'option ne protège pas

Elle sépare des **fichiers** et des **ports**. Elle ne sépare rien d'autre :

- un service partagé par les deux arbres (une base de données locale, une file, un cache, un
  compte de test chez un fournisseur) reste UN seul service. Deux suites de tests qui le
  remettent à zéro en même temps se détruisent l'une l'autre. Si le projet en a un, les deux
  chantiers ne lancent pas leurs tests en même temps : sers-toi d'une ressource exclusive
  pour l'interdire, ou note la règle dans `harness/PROJET.md` ;
- la configuration non versionnée (fichiers d'environnement, réglages locaux de l'outil)
  n'existe pas dans le second arbre tant qu'elle n'est pas dans `options.creneaux.liens`.
  **N'y mets jamais un fichier qui pointe vers la production** : un lien le rendrait actif
  dans un arbre où personne ne pense à lui ;
- les dépendances installées se relient par `liens` (un lien, pas une copie). N'installe
  jamais de dépendances DANS le second arbre : l'installation traverserait le lien et
  modifierait celles de l'arbre principal pendant que l'autre chantier s'en sert.

## Les ports

Le banc de chaque arbre a le sien : `options.creneaux.ports.a` (à défaut, `execution.port`)
et `options.creneaux.ports.b`. `banc.sh` les lit tout seul selon l'arbre où il tourne, tu
n'as rien à lui passer. Si le projet a un port et que le créneau b n'en a pas, l'ouverture
du créneau b est refusée.

## Quand le périmètre change

Chaque fois que tu modifies `perimetre` dans l'état (`etat.mjs ecrire <id> --patch ...`),
redéclare aussitôt, sans attendre un point d'extension :

```bash
bash harness/scripts/creneaux.sh ouvrir <id>
```

Le périmètre est relu dans l'état et recontrôlé face à l'autre créneau. Un refus ici veut
dire que la story vient de s'étendre sur le terrain de l'autre : voir « Si l'ouverture est
refusée ».

## Point d'extension : avant_la_branche

```bash
bash harness/scripts/creneaux.sh etat
```

- **Tu es dans l'arbre principal et le créneau a est libre** :

  ```bash
  bash harness/scripts/creneaux.sh ouvrir <id> a --perimetre "<glob>" [--perimetre "<glob>" ...]
  ```

  Les mêmes globs que ceux que tu vas donner à `etat.mjs init`. Le script ne crée pas la
  branche dans ce cas : la procédure d'init s'en charge, comme sans l'option.
- **Le créneau a est pris par une autre story et le créneau b est libre** :

  ```bash
  bash harness/scripts/creneaux.sh ouvrir <id> b --perimetre "<glob>" [--perimetre "<glob>" ...]
  ```

  Le script crée le second arbre, la branche de la story, et pose les liens. **STOP** : donne
  à l'approbateur le chemin du second arbre et dis-lui d'y ouvrir une session, puis d'y
  relancer la même commande `/harness init`. Ne mène pas la story b depuis l'arbre principal.
- **Tu es dans le second arbre** (la story y est déjà déclarée, la branche existe) :

  ```bash
  bash harness/scripts/creneaux.sh ouvrir <id> --perimetre "<glob>" [--perimetre "<glob>" ...]
  ```

  La branche est créée : passe directement au point 3 de l'init.
- **Les deux créneaux sont pris** : STOP. Une troisième story attend qu'un créneau se libère.

### Si l'ouverture est refusée

Lis la cause, elle est nommée. Un croisement réel n'est pas un obstacle à contourner : les
deux stories ne peuvent pas avancer en même temps telles qu'elles sont découpées.

- À l'init : STOP, en rapportant le refus tel quel. L'approbateur décide (attendre la fin de
  l'autre story, ou redécouper).
- En cours de story : `etat.mjs attendre <id> scope --motif "croisement avec <autre story> : <cause>"`,
  notification de gate, STOP.

## Point d'extension : apres_plan

Le plan vient de préciser le périmètre dans l'état. Redéclare-le :

```bash
bash harness/scripts/creneaux.sh ouvrir <id>
```

Refus : voir « Si l'ouverture est refusée ».

## Point d'extension : avant_gate_merge

```bash
bash harness/scripts/creneaux.sh verifier
```

Code 1 : la branche a touché des fichiers qu'elle n'avait pas déclarés, et le script les
nomme. Pour chacun, de deux choses l'une :

- il devait être touché : ajoute-le à `perimetre` (`etat.mjs ecrire`), redéclare
  (`creneaux.sh ouvrir <id>`), relance `verifier`. Si la redéclaration est refusée, c'est un
  croisement réel avec l'autre chantier : gate `scope`, comme ci-dessus ;
- il n'aurait pas dû l'être : tâche non cochée dans `tasks.md` pour revenir dessus, retour
  au stage CODE.

Pas de gate de merge tant que `verifier` ne rend pas 0.

## Point d'extension : a_la_cloture

Le créneau se libère **en tout dernier**, après le commit, le push et la PR de clôture : le
script refuse de retirer un arbre qui porte du travail non commité ou non poussé.

- **Créneau a** : `bash harness/scripts/creneaux.sh fermer a`.
- **Créneau b** : il se ferme depuis l'arbre principal, pas depuis le dossier qu'il retire.
  Termine la clôture, puis donne à l'approbateur la commande à lancer dans l'arbre principal :
  `bash harness/scripts/creneaux.sh fermer b`. Le second arbre est retiré, la branche est
  conservée.

Un créneau qu'on oublie de fermer bloque la story suivante : dis-le dans ton dernier message
si la fermeture reste à faire.
