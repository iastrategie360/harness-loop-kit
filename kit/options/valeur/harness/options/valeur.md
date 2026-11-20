# Option `valeur` : l'arbitre de valeur

Le relecteur dit si un défaut est **réel**. Rien, dans le noyau, ne dit s'il vaut la peine
d'être corrigé **maintenant**. Sans ce filtre, une sévérité rendue par un relecteur de code
devient mécaniquement une tâche, et c'est une boucle de review qui fixe l'ordre du jour du
projet sans que personne ne l'ait décidé.

L'agent `harness-valeur` comble ce manque. Son verdict est **contraignant** : un `ON_LE_NOTE`
ferme l'item sans correctif. Ce qui rend cela sûr, c'est le plancher et la validation par
script, pas la prudence de l'arbitre.

Il n'intervient PAS sur le choix des stories : décider ce qu'on fait reste le geste de
l'approbateur. Il arbitre, en aval de ce choix, les objections, les tâches, les findings et les défauts
relevés devant le rendu.

Fichiers de l'option : `.claude/agents/harness-valeur.md`, `harness/schemas/valeur.json`,
`harness/scripts/valeur-valider.sh`. Réglage : `options.valeur` dans `harness/projet.json`.

## Le geste, identique à tous les points

1. **Filtre le plancher toi-même, d'abord.** Lis `plancher` dans `harness/projet.json`. Un
   item qui tombe dans l'un de ses cas ne part PAS chez l'arbitre : il est à faire. Deux
   verrous valent mieux qu'un : toi en amont, l'arbitre ensuite par son `HORS_ARBITRAGE`.
2. **UN SEUL appel** `harness-valeur` pour tout le lot restant. Jamais un appel par item :
   l'arbitre perdrait la comparaison entre items, qui est ce qui lui permet de dire lequel
   porte la valeur. Si le lot est vide après filtrage, pas d'appel. Le prompt porte :
   - l'identifiant de la story et le stage ;
   - chaque item : sa **clé**, son titre, son détail, sa sévérité s'il en a une, son fichier ;
   - le plancher, recopié cas par cas et **numéroté** depuis `plancher` ;
   - les `perimetres_interdits` du projet ;
   - un instantané de la situation si tu sais quelque chose de plus récent que les documents
     de `options.valeur.fichiers_situation`.
3. **Valide avant de lire.** Écris sa réponse telle quelle dans
   `<specs>/<id>/valeur-<stage>-<n>.json` (`<stage>` en minuscules, `<n>` le numéro du lot à
   ce stage), puis :

   ```bash
   CLES_ATTENDUES=$'<clé1>\n<clé2>' bash harness/scripts/valeur-valider.sh <specs>/<id>/valeur-<stage>-<n>.json
   ```

   Un code non nul veut dire que tu n'as **PAS de verdict** : re-soumets le lot entier, une
   fois. Un second refus : traite tout le lot comme `ON_LE_FAIT` et dis-le dans l'historique.
   N'applique jamais un verdict partiel, ni une réponse lue sans ce passage.
4. **Applique** chaque verdict :

   | Verdict | Ce que tu fais |
   |---|---|
   | `ON_LE_FAIT` | l'item suit son cours (il reste dans le lot) |
   | `HORS_ARBITRAGE` | l'item est à faire, comme si tu l'avais filtré toi-même. **Exception** : si `exposition` nomme le cas « périmètre interdit », ne crée aucune tâche : `etat.mjs attendre <id> scope --motif "<item> : son remède touche <périmètre>"`, notification de gate, STOP |
   | `ON_LE_NOTE` | l'item sort du lot. Recopie `ligne_backlog` **telle quelle** dans `<specs>/<id>/reports-de-valeur.md` (crée le fichier au besoin, une ligne par report), puis pose la décision là où le point le dit |
   | `ON_LE_JETTE` | l'item sort du lot, sans ligne de backlog. Pose la décision là où le point le dit |

5. Une ligne d'historique avec le résumé rendu par le script :
   `etat.mjs historique <id> "valeur <stage> : <ligne VALEUR du script>"`.
6. Commit du fichier de verdict et de `reports-de-valeur.md` avec le reste du pas.

Les deux gabarits de note, à reprendre mot pour mot (c'est ce que lira l'approbateur) :

> Différé par arbitrage de valeur du \<date\>. Ligne de backlog : `<slug>`. Déclencheur de
> réveil : \<fait observable\>.

> Écarté par arbitrage de valeur du \<date\> : \<motif, celui de `cout_si_ca_arrive`\>.

## Trois règles qui tiennent le filtre

**Un item arbitré ne se réarbitre pas.** Un finding qui porte déjà un verdict de valeur et que
le relecteur re-signale ne produit ni appel, ni tâche, ni notification : une ligne
d'historique, et tu passes. Sans cette borne, le même débat se rouvre à chaque round.
`ON_LE_JETTE` est terminal.

**Sauf si son déclencheur de réveil a tiré.** Voir le point `avant_gate_merge` : un report
dont le déclencheur a tiré redevient un item neuf.

**Le renversement est à sens unique.** Tu peux renverser un verdict, mais seulement vers PLUS
de travail : `ON_LE_NOTE` ou `ON_LE_JETTE` vers « à faire », jamais l'inverse. Tu ne
transformes jamais un `ON_LE_FAIT` ni un `HORS_ARBITRAGE` en report, et tu ne rends jamais
toi-même un verdict de report que l'arbitre n'a pas rendu. Le motif d'un renversement va dans
l'historique, et ce n'est jamais « je ne suis pas d'accord » : c'est un fait que l'arbitre
n'avait pas, ou le test du déclencheur (le déclencheur est la première occurrence du défaut
lui-même, et le remède tient en une ligne).

## Point d'extension : apres_challenge

Le lot : les objections que tu t'apprêtes à RETENIR (celles du relecteur dans
`codex-challenge.json`, et celles des autres options actives). Donne à chacune une clé courte
et stable, par exemple `objection-<n>-<deux-ou-trois-mots>`.

Ne soumets pas les `questions_pour_humain` : une question posée à l'approbateur ne s'arbitre
pas.

Effet : une objection `ON_LE_NOTE` ou `ON_LE_JETTE` **n'entre pas dans la spec**. Dans
`challenge.md`, elle figure comme écartée, avec la note du gabarit.

## Point d'extension : apres_plan

Le lot : les tâches de `tasks.md`, clé `T<n>`. Ne soumets pas une tâche dont dépend un critère
d'acceptation de la spec : c'est un cas du plancher.

Effet : une tâche `ON_LE_NOTE` ou `ON_LE_JETTE` **sort de `tasks.md`**. Vérifie ensuite que
les tâches restantes tiennent encore debout (une tâche retirée dont une autre dépend se
renverse en « à faire », motif dans l'historique), et que le périmètre déclaré de la story
ne porte plus de fichier que seule la tâche retirée touchait.

## Point d'extension : avant_tfix

Ce point est appelé à deux stages. Le lot et le support de la décision diffèrent.

**Au stage CODE**, le lot est `a_corriger` du bilan de `ledger-round`. Les clés sont celles du
ledger. Pour un `ON_LE_NOTE` :

```bash
node harness/scripts/etat.mjs finding <id> <clé> differe_valeur --note "<gabarit Différé>"
node harness/scripts/etat.mjs ecrire <id> --patch '{"review_ledger":{"code":{"findings":{"<clé>":{"valeur":{"verdict":"ON_LE_NOTE","date":"<horodatage ISO>","declencheur":"<declencheur_reveil>"}}}}}}'
```

Pour un `ON_LE_JETTE` : statut `ecarte_valeur`, note du gabarit Écarté, et le même patch avec
`"verdict":"ON_LE_JETTE"` et `"declencheur":""`.

**Au stage PR**, le lot est la liste des findings ouverts de
`review-locale.mjs <id> --json`. Les clés sont celles de l'artefact. La décision s'écrit dans
l'artefact, que la gate lit :

```bash
node harness/scripts/review-statut.mjs <id> <clé> differe_valeur --note "<gabarit Différé>"
node harness/scripts/review-statut.mjs <id> <clé> ecarte_valeur --note "<gabarit Écarté>"
```

Dans les deux cas, les findings arbitrés `ON_LE_NOTE` ou `ON_LE_JETTE` sortent du lot : pas
de `Tfix` pour eux. Un finding que le ledger ou l'artefact a déjà escaladé vers l'arbitre de
code ou vers l'humain ne se soumet pas ici : il est en cours de tranche ailleurs.

## Point d'extension : au_regard

Le lot : les défauts que tu t'apprêtes à RETENIR devant le rendu (les tiens, et ceux des
autres options actives), clé `regard-<n>-<deux-ou-trois-mots>`. Un fait faux écrit dans un
écran est un cas du plancher : il ne se soumet pas, il se corrige.

Effet : un défaut `ON_LE_NOTE` ou `ON_LE_JETTE` **ne devient pas une tâche**. Dans
`regard-aval.md`, il figure comme écarté, avec la note du gabarit.

## Point d'extension : avant_gate_merge

Deux gestes, dans cet ordre.

**1. Relis chaque déclencheur de réveil de la story.** Pour chaque ligne de
`<specs>/<id>/reports-de-valeur.md`, regarde si le fait nommé après « Déclencheur : » est
maintenant vrai. C'est un fait observable, donc vérifiable : un appelant qui existe désormais
(une recherche dans le code suffit), un réglage posé, un document de situation qui a changé.

Si le déclencheur a tiré, **ou si tu ne peux pas le déterminer**, le report tombe :

- un finding du stage CODE :
  `etat.mjs finding <id> <clé> ouvert --note "déclencheur de réveil tiré : <fait>"` (rouvrir
  efface son verdict de valeur), puis
  `etat.mjs stage <id> CODE --motif "report de valeur réveillé : <clé>"` ;
- un finding du stage PR :
  `review-statut.mjs <id> <clé> rouvrir --note "déclencheur de réveil tiré : <fait>"`, puis
  `etat.mjs stage <id> PR --motif "report de valeur réveillé : <clé>"` ;
- une tâche, une objection ou un défaut du regard : l'item redevient une tâche de `tasks.md`,
  retour au stage CODE avec le même motif ;
- dans tous les cas : retire la ligne de `reports-de-valeur.md`, et
  `bash harness/scripts/notifier.sh alerte "Harness <id> : report de valeur réveillé" "<clé> : <fait>"`.

L'item réveillé est un item neuf : il repassera par l'arbitre, qui lit la situation à chaque
appel et rendra de lui-même un autre verdict. Sans cette relecture, le déclencheur serait
décoratif : un défaut différé resterait supprimé le jour même où il devient vivant.

**2. Reporte les lignes dans le backlog du projet.** Si `chemins.backlog` est renseigné et
qu'aucune autre story n'est en cours sur ce fichier (pas d'option `creneaux` active, ou le
fichier est dans le périmètre déclaré de la story), ajoute au backlog les lignes de
`reports-de-valeur.md` qui n'y sont pas déjà. Sinon, laisse-les dans le fichier de la story.
Dans les deux cas, **liste-les dans le corps de la notification de gate de merge** :
l'approbateur doit lire ce qui a été différé avant de merger, pas le découvrir après.
