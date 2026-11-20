# Option `note_story` : une note par story, et un index

Une story laisse une dizaine de documents de travail. Six mois plus tard, personne ne les
relit : on veut savoir en une minute ce que la story a changé, ce qui a été décidé en route et
ce qu'on y a appris. Cette option impose cette note, `<specs>/<id>/README.md`, et tient un
index de toutes les stories.

Elle est **bloquante** : c'est le stage NOTE, précondition de la gate de merge. Une note qu'on
se promet d'écrire après le merge ne s'écrit pas.

Fichiers de l'option : `harness/gabarits/note-story.md`, `harness/scripts/note-index.mjs`,
`harness/scripts/note-valider.sh`. Réglage : `options.note_story.index` dans
`harness/projet.json` (le chemin de l'index).

## Ce qui est généré, ce qui s'écrit

Deux parties de la note se DÉDUISENT de l'état et ne s'écrivent jamais à la main : l'en-tête
(entre les deux lignes `---`) et la liste des documents (entre les deux marqueurs
`documents`). L'index est généré en entier.

```bash
node harness/scripts/note-index.mjs note <id>     # crée la note au besoin, régénère ses deux parties
node harness/scripts/note-index.mjs index         # régénère l'index
bash harness/scripts/note-valider.sh <id>         # 0 conforme, 1 refus avec toutes les causes
```

Le reste de la note t'appartient : le résumé, les décisions, ce qu'on a appris. Écris-le pour
quelqu'un qui n'a pas suivi la story, à partir de l'état (`etat.mjs lire <id> decisions`, les
blocages, l'historique) et des documents, pas de mémoire. Une décision, c'est un choix ET sa
raison ; ce qui a été écarté compte autant que ce qui a été fait.

Un conflit de merge sur l'index ne se résout pas à la main : garde n'importe quelle version,
puis relance `note-index.mjs index`.

## Point d'extension : a_l_init

```bash
node harness/scripts/note-index.mjs note <id>
node harness/scripts/note-index.mjs index
```

La note est un squelette, c'est voulu : elle se complète au stage NOTE. Ajoute les deux
fichiers au commit de l'init.

## Point d'extension : au_stage_note

1. Complète la note : chaque passage « À COMPLÉTER » devient du texte. Trois phrases de
   résumé, les décisions avec leur raison, ce qu'on a appris.
2. Régénère : `note-index.mjs note <id>` puis `note-index.mjs index`.
3. `bash harness/scripts/note-valider.sh <id>`.
   - Code 0 : commit de la note et de l'index, la story peut avancer.
   - Code 1 : corrige chaque cause nommée et relance. **La story reste au stage NOTE** tant
     que le script refuse. Un document attendu qui manque n'est pas un défaut de la note :
     c'est un stage qui n'a pas produit son document, et c'est là qu'il faut retourner.

Tu ne passes jamais ce stage en notant que « la note sera complétée plus tard ».

## Point d'extension : a_la_cloture

L'état vient de passer à `DONE` sur la branche de clôture.

```bash
node harness/scripts/note-index.mjs note <id>
node harness/scripts/note-index.mjs index
bash harness/scripts/note-valider.sh <id>
```

L'en-tête porte maintenant la date de fin, et l'index dit « terminée ». Ajoute la note et
l'index au commit de clôture. Si le script refuse ici, corrige avant de pousser : la clôture
est le dernier passage sur cette story.
