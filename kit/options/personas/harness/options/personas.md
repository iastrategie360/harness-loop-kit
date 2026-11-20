# Option `personas` : le regard des utilisateurs

Le relecteur lit du code. Personne, dans le noyau, ne lit l'intention ou l'écran avec les yeux
de celui qui s'en servira. Le cadran `regard_client` dit seulement QUAND regarder le rendu ;
cette option dit AVEC QUI : un panel de personas, chacun décrit par une fiche du projet.

Elle ne joue que sur une story dont `regard_client` est vrai. Sur les autres, ses deux points
ne font rien.

Fichiers de l'option : `.claude/agents/harness-persona.md`, et un modèle de fiche,
`harness/personas/_modele.md`. Réglage : `options.personas.dossier` dans `harness/projet.json`.

## Le panel

Le panel est la liste des fichiers `*.md` du dossier des personas dont le nom ne commence pas
par `_`. L'identifiant d'un persona est le nom de son fichier, sans l'extension.

```bash
ls "$(node harness/scripts/lib/config.mjs lire options.personas.dossier)"
```

Panel vide : ne fais aucun appel, et dis-le dans l'historique et dans la notification de gate
(« aucune fiche de persona, regard non mené »). N'incarne jamais toi-même un persona à la
place d'une fiche absente.

Les fiches appartiennent au projet. Tu ne les modifies pas pendant une story.

## Le geste

Un appel `harness-persona` par persona, tous lancés dans le même message pour qu'ils tournent
en parallèle et sans se lire les uns les autres. Chaque prompt porte : `persona`, `mode`,
l'identifiant de la story, et les chemins de ce qu'il doit regarder.

Les personas rendent des **objections**, pas des exigences. C'est toi qui tranches ce qui est
retenu, et tu ÉCRIS ce que tu écartes et pourquoi. Deux repères :

- une objection portée par plusieurs personas pèse plus qu'une objection isolée, mais une
  objection isolée sur une règle du métier pèse plus que tout le reste ;
- un persona qui ne rend pas le format attendu, ou qui dit n'avoir pas pu lire sa fiche ou une
  capture, n'a PAS rendu d'avis : relance-le une fois, sinon note son absence. Ne compte pas
  son silence pour un accord.

## Point d'extension : apres_challenge

Mode `amont`. Les personas lisent le **brief** (`<specs>/<id>/brief.md`), jamais la spec.

1. Lance le panel.
2. Écris `<specs>/<id>/regard-amont.md` : pour chaque persona son verdict et ses objections,
   recopiés sans les adoucir ; puis ta synthèse (ce qui revient chez plusieurs).
3. Les objections rejoignent celles du relecteur : elles sont recensées dans `challenge.md`,
   retenues ou écartées, avec le motif. Une objection retenue devient une révision de la spec,
   dans la limite du budget de la story : si elle le fait déborder, c'est un découpage à
   proposer, pas une spec à gonfler.

## Point d'extension : au_regard

Mode `aval`. Les personas regardent le **rendu réel** : les captures prises au premier pas du
stage REGARD (`<specs>/<id>/captures/`). Donne à chacun les chemins des captures et celui du
brief, pour qu'il puisse juger la promesse.

1. Pas de capture, pas de panel : le stage REGARD dit déjà quoi écrire dans ce cas. Ne remplace
   pas le rendu par un diff ni par une description.
2. Lance le panel.
3. Leurs constats vont dans `regard-aval.md`, avec les tiens : par persona, le verdict et les
   objections ; puis ce que tu retiens et ce que tu écartes, avec le motif. Un défaut retenu
   suit le chemin du stage REGARD (une tâche, retour au stage CODE).
4. Compare avec `regard-amont.md` : une objection d'amont que tu avais retenue et qui revient
   en aval n'a pas été traitée. Elle est retenue d'office.
