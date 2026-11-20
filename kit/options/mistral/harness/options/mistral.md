# Option `mistral` : un second service pour la sécurité et les désaccords

Le noyau a un relecteur. Il relit tout, et il a ses angles morts. L'option ajoute un **second
service**, Mistral, appelé par son CLI `vibe`, pour trois gestes et rien d'autre :

1. **la relecture sécurité de chaque PR**, à côté de la review de code, jamais à sa place.
   Elle a son propre artefact, et la gate de PR exige les deux ;
2. **l'arbitre** d'un finding contesté : un juge d'un autre fournisseur que le relecteur qui
   a signalé le défaut, donc sans ses angles morts ;
3. **la tranche finale** d'un désaccord qui survit à l'arbitrage : une décision
   contraignante, prise par un troisième avis (un autre modèle que l'arbitre), avant de
   déranger l'approbateur.

Mistral ne relit PAS le code au stage CODE : une relecture générale d'un gros diff par un
second service coûte cher et ajoute peu à celle du relecteur de code. Son mandat est étroit,
c'est ce qui le rend utile.

Fichiers de l'option : `harness/scripts/mistral-commun.sh` (le seul endroit qui appelle
`vibe`), `mistral-securite.sh`, `mistral-arbitrer.sh`, `mistral-trancher.sh`,
`mistral-preflight.sh`, `decouper-diff.mjs`, `lib/decoupe-diff.mjs`, `lib/profil-vibe.mjs`,
`harness/vibe/agents/relecteur.toml`, `harness/schemas/simplification.json`. Réglage :
`options.mistral` dans `harness/projet.json`.

## Les réglages

| Clé | Ce qu'elle dit |
|---|---|
| `actif` | l'option tourne |
| `accord_envoi_externe` | l'accord d'envoyer le diff et des extraits du dépôt à Mistral. C'est un AUTRE service que le relecteur de code : son accord ne vaut pas ici. Sans lui, chaque script refuse net |
| `securite_pr` | la gate de PR exige aussi la relecture sécurité |
| `arbitre` | l'étage arbitre de l'échelle passe par Mistral au lieu du relecteur de code |
| `tranche_finale` | un étage de tranche finale s'insère avant l'humain (exige `arbitre`) |
| `modeles.relecture`, `modeles.tranche` | deux modèles distincts : le second ne doit pas rendre le même avis que l'arbitre |
| `prix` | les prix catalogue, en USD par million de jetons. Ils rendent le plafond de coût effectif : un prix nul le rendrait inerte |
| `plafonds` | par session (coût, tours, délai), par relecture (budget global), essais, parallélisme, taille d'un lot |
| `exclusions` | les fichiers du diff que la relecture sécurité ne relit pas, parce qu'ils ne changent aucun comportement. Ils sont nommés dans l'artefact |

Chaque valeur se surcharge pour une invocation par une variable d'environnement
(`MISTRAL_BUDGET_REVUE`, `MISTRAL_REVIEW_MODEL`, ...), listées en tête de
`mistral-commun.sh`. La surcharge sert aux essais et aux reprises : la référence reste la
configuration. Ne surcharge jamais le budget sans le dire dans l'historique.

## Ce qui tient la lecture seule

- **Par construction** : la session ne contient que `read_file` et `grep` (profil
  `harness/vibe/agents/relecteur.toml`, et `--enabled-tools` à chaque appel). La tranche
  finale n'a aucun outil.
- **Les secrets** : le profil interdit les fichiers de secrets aux deux outils, avec la même
  liste. Le préflight refuse un profil qui ouvrirait autre chose, ou dont les deux listes
  diffèrent.
- **Le contrôle après coup** : empreinte du dépôt avant et après. Si elle a bougé, la sortie
  est écartée et le script rend **5**, exactement comme le relecteur de code. Rien n'est
  annulé : alerte, `etat.mjs arreter <id> error`, STOP.
- **Le verrou** : chaque script de relecture, du noyau comme de l'option, prend le même verrou
  du checkout. Deux relecteurs ne tournent donc jamais ensemble dans le même arbre de travail.
  Et tu ne délègues **jamais** une tâche au codeur pendant qu'un relecteur tourne : commit
  d'abord, relecture ensuite.
- **Une seule liste de chemins interdits** : les secrets du profil livré (sa denylist) et les
  chemins exclus du projet (`relecteur.chemins_exclus`), réunis par `lib/profil-vibe.mjs`. Tout
  en dérive : les denylists des deux outils, le parcours de grep (généré, plus écrit à la main),
  le contrôle du diff de la relecture sécurité, la détection des copies et déplacements, le
  contexte de l'arbitre et de la tranche.
- **Les chemins exclus du projet sont des interdits des outils**, pas une consigne : avant
  chaque session, un profil EFFECTIF est écrit dans `harness/.travail/mistral/vibe-agents/` (le
  profil livré, plus chaque motif de `relecteur.chemins_exclus` ajouté aux deux denylists et aux
  exclusions du parcours de grep), contrôlé comme le livré, et c'est lui que vibe charge.
- **Les chemins exclus du projet** (`relecteur.chemins_exclus`) ne partent jamais : la
  relecture sécurité refuse un diff qui les touche, et l'arbitre comme la tranche les retirent
  du diff qu'ils envoient (repli sur le diff de la branche compris), du contenu complet des
  fichiers, et de ce qui en a été déplacé ou copié. Un finding qui ne porte que sur un chemin
  exclu ne s'arbitre pas chez Mistral : il monte à l'humain. Chaque chemin d'un finding est
  canonisé avant ce contrôle (« ./ », « .. », liens symboliques résolus) ; un chemin qui sort
  du checkout fait refuser le finding entier.
- **La tranche décide sur des fichiers identifiés** : un finding sans `fichier`, ou dont un
  fichier n'existe pas, est refusé ; un fichier supprimé par la branche est nommé comme tel
  dans le prompt.
- **Les fichiers de secrets ne partent jamais**, même sans chemin exclu : la liste interdite du
  profil livré (`.env`, clés privées, réglages locaux) s'applique aussi à ce que le harness met
  lui-même dans un prompt. Un finding qui les nomme, ou nomme un lien vers eux, est refusé ; ils
  sont retirés du diff envoyé à l'arbitre et à la tranche ; une relecture sécurité dont le diff
  les touche refuse de partir.
- **Une copie ou un déplacement d'un chemin interdit sur la branche** fait refuser l'arbitre et
  la tranche entièrement, comme la relecture sécurité : retirer la copie du diff ne suffirait pas,
  l'arbitre pourrait la lire avec ses outils sous son nom permis.
- **Les motifs de `relecteur.chemins_exclus` ont un sens unique.** La denylist de vibe et ripgrep
  ne lisent pas les jokers pareil ; un motif ambigu est REFUSÉ au préflight et à chaque session,
  jamais traduit. Permis : des segments littéraux (`secrets/`, `docs/notes.md`), `*` en dernier
  segment (`a/*`), `**` en premier ou en dernier (`**/fixtures/**`, `private/**`), et une
  extension seule (`*.pem`). Refusés : `private*.json`, `docs/*.md`, `a/*/b`, `a/b?.txt` ; les
  réécrire en segments entiers (`**/fixtures/**`) ou en extension seule.
- **La tranche n'est jamais l'arbitre** : avec le même modèle (configuration ou surcharge),
  `mistral-trancher.sh` refuse, et le préflight aussi quand la tranche finale est active.
- **Rien n'entre d'office dans le prompt système.** Sans profil, vibe chargerait de lui-même le
  contexte du dépôt (état Git), les instructions `AGENTS.md` de l'utilisateur (`~/.vibe`) et du
  projet, la liste des compétences et un éventuel prompt personnel. Les deux profils du kit
  (`relecteur`, et `sans-outils` pour la tranche et l'appel du préflight) coupent tout cela
  (`include_project_context`, `include_prompt_detail`, `system_prompt_id`), les variables
  `VIBE_*` de chaque appel aussi, et le préflight refuse un profil qui le rouvrirait. Seule
  exception connue : quand le relecteur lit un fichier d'un dossier qui porte un `AGENTS.md`,
  dans un dépôt que l'utilisateur a déclaré de confiance pour vibe, vibe joint ce fichier au
  résultat de la lecture ; c'est du contenu du dépôt relu, pas des instructions personnelles.
- **Le modèle se choisit à l'invocation** (`VIBE_MODELS`, `VIBE_ACTIVE_MODEL`,
  `VIBE_AGENT_PATHS`) : rien n'est écrit dans `~/.vibe`. La clé est lue par `vibe` lui-même,
  dans `~/.vibe/.env` ou `MISTRAL_API_KEY`, et n'est jamais affichée.

## Les codes

| Script | 0 | 1 | 5 | 64 |
|---|---|---|---|---|
| `mistral-securite.sh <id>` ou `--branche` | relecture menée, artefact écrit | relecture NON aboutie : aucun artefact, la gate reste à 3 | le relecteur a écrit | usage |
| `mistral-arbitrer.sh <finding.json>` | verdict écrit | échec, rien d'écrit | idem | usage |
| `mistral-trancher.sh <finding.json>` | décision écrite | refus (P0, pas d'arbitrage précédent, contexte tronqué) ou échec | idem | usage |
| `mistral-preflight.sh [--appel]` | prêt | il manque quelque chose | idem | usage |

Un code 1 n'est jamais « rien à signaler » : c'est un échec réel du pas (voir « Échecs » dans
la procédure).

## Point d'extension : apres_review_pr

Au stage PR, juste APRÈS `review-pr-locale.sh` et le commit de son artefact, si
`options.mistral.securite_pr` est vrai. Jamais en même temps : la review de code écrit son
artefact dans l'arbre en fin de course, et le contrôle d'empreinte de la relecture sécurité le
prendrait pour une écriture de Mistral.

```bash
bash harness/scripts/mistral-securite.sh <id>
```

- Code 0 : commit et push de `<specs>/<id>/review-securite.json` et `review-securite.md`,
  nommés un par un. Commiter l'un des deux artefacts ne périme pas l'autre.
- Code 1 : lis la cause. Un lot tombé sur un hoquet de l'API (le message le dit) se reprend
  sans repayer les autres : `MISTRAL_REPRISE=1 bash harness/scripts/mistral-securite.sh <id>`,
  une fois. Seuls les lots sans réponse, sur un instantané identique, repartent. Budget dépassé :
  ne le relève pas toi-même, c'est une décision de l'approbateur (`attendre <id> scope`,
  motif : le coût annoncé). Sinon, échec réel du pas.
- Un diff entièrement exclu (documentation seule) rend 0 avec un artefact explicite à zéro
  finding, qui nomme chaque fichier exclu.

La gate `review-locale.mjs <id>` combine alors les deux verdicts, le plus prudent l'emporte :
une relecture sécurité absente, périmée ou pas commitée rend 3. Son `--json` porte un bloc
`securite`, et chaque finding ouvert dit sa `source` (`code` ou `securite`).

**Les findings sécurité suivent l'échelle de la review de PR**, avec deux différences :

- leur statut se pose dans LEUR artefact :
  `review-statut.mjs <id> <clé> <statut> --securite --note "..."` ;
- après un correctif, les DEUX relectures sont périmées : relance la review de code, puis la
  relecture sécurité, dans cet ordre.

Un finding sécurité tombe presque toujours dans le **plancher** (accès ou identité, effet
irréversible). Il ne part donc pas chez l'arbitre de valeur : il se corrige. Le réfuter
(`refute`) exige la preuve, fichier et ligne, comme partout.

## Point d'extension : a_l_arbitrage

Quand l'échelle (stage CODE ou stage PR) envoie un finding à l'arbitre, et si
`options.mistral.arbitre` est vrai : le même fichier d'entrée
(`{cle, titre, detail, severite, refutation_codeur, fichier}`), mais

```bash
bash harness/scripts/mistral-arbitrer.sh harness/.travail/relecteur/arbitrage-<clé>.json
```

à la place de `codex-arbitrer.sh`. La sortie a le même schéma (`arbitration.json`), et elle
s'applique avec les mêmes règles que dans la procédure : `finding_valide` ou
`resolution_recommandee` donnent un Tfix avec le `correctif_suggere` ; `faux_positif` ne ferme
seul qu'un P2. **Un P0 ou un P1 que l'arbitre dit faux monte toujours à l'humain.** Puis
`etat.mjs escalade <id> <clé> arbitre --verdict <verdict>` (stage CODE), ou
`review-statut.mjs ... --escalade arbitre` (stage PR, avec `--securite` pour un finding
sécurité). Une ligne d'historique nomme l'arbitre : « arbitre Mistral ».

## Point d'extension : avant_escalade_humaine

Si `options.mistral.tranche_finale` est vrai. Au stage CODE, `ledger-round` rend alors
`vers: "tranche"` pour un finding déjà arbitré qui survit encore à un round de correction :
c'est ce point. Au stage PR, c'est le même cas lu sur l'artefact (`escalation` vaut
`arbitre` et `survived` a encore monté depuis).

**Avant tout appel, trois bornes**, tenues par toi :

1. le finding est un **P0** : pas de tranche, l'humain (le ledger ne propose d'ailleurs jamais
   la tranche pour un P0, et le script la refuse) ;
2. le finding, ou le remède que les deux parties envisagent, tombe dans le **plancher**
   (`plancher` de la configuration) : pas de tranche, l'humain. Une décision contraignante d'un
   modèle ne ferme jamais un cas que le projet a déclaré non négociable ;
3. le remède touche un **périmètre interdit** : `attendre <id> scope`, comme partout.

Dans ces trois cas : `etat.mjs escalade <id> <clé> humain --verdict "en attente"` (ou
`--escalade humain`), `etat.mjs attendre <id> arbitrage`, notification, STOP. La procédure du
noyau reprend.

Sinon, réécris le fichier du finding en y ajoutant l'avis de l'étage précédent
(`arbitrage_precedent` : le verdict et le correctif de l'arbitre, tels quels), puis :

```bash
bash harness/scripts/mistral-trancher.sh harness/.travail/relecteur/arbitrage-<clé>.json
```

- Code 0 : la sortie (`simplification.json` : `diagnostic`, `solution_simple`,
  `fichiers_touches`, `anti_over_engineering`) est **contraignante**. Elle devient une tâche,
  EN TÊTE de `tasks.md` :
  `- [ ] Tfix<n> : appliquer la tranche finale sur <titre> : <solution_simple> (ne pas : <anti_over_engineering>) ; vérif : <commande>`.
  Vérifie d'abord que `fichiers_touches` reste dans le périmètre de la story : sinon, c'est le
  cas 3 ci-dessus. Puis `etat.mjs escalade <id> <clé> tranche --verdict "<solution_simple>"`
  (stage PR : `review-statut.mjs ... --escalade tranche`), et
  `bash harness/scripts/notifier.sh alerte "Harness <id> : tranche finale" "<clé> : <solution_simple>"`.
  L'approbateur apprend la décision, il n'a pas à la prendre.
- Code 1 : la tranche n'a pas eu lieu (contexte tronqué, prompt trop gros, échec). Ne la
  remplace pas par ton avis : escalade vers l'humain, comme sans l'option.

Le codeur applique la solution telle quelle. Si le relecteur re-signale ENCORE le finding
après ce correctif, le ledger rend `vers: "humain"` : deux modèles et une décision n'ont pas
suffi, c'est une information que l'approbateur doit avoir.

## Installer, et prouver

Prérequis : ripgrep (`rg`) dans le PATH, exigé (vibe choisit son outil de recherche par sa
présence ; sans lui il retombe sur GNU grep, dont les exclusions ne portent que sur le nom de
base, et un dossier interdit ne serait plus exclu : chaque session refuse alors de partir), le
CLI `vibe` en version 2.13 ou plus, une clé Mistral posée par `vibe --setup`
(ou `MISTRAL_API_KEY` dans l'environnement), et l'accord d'envoi. Puis :

```bash
bash harness/scripts/mistral-preflight.sh           # tout ce qui se contrôle sans rien envoyer
bash harness/scripts/mistral-preflight.sh --appel   # plus un appel réel, sans outil, plafonné à quelques centimes
```

Le second seul prouve que la clé et le réseau marchent. Sans lui, la relecture sécurité n'est
pas prouvée, et le compte rendu le dit.

## Ce que l'option ne garantit pas

- **Deux services ne voient pas tout.** La relecture sécurité est étroite : elle ne juge que
  ce qui est dans le diff et ce qu'elle va vérifier avec ses outils, dans un budget de lectures.
- **L'exclusion protège des CHEMINS, pas du contenu.** Un fichier exclu, son déplacement et sa
  copie (même d'un exclu que la branche ne touche pas) ne partent pas. Mais une copie retouchée
  sous le seuil de similarité de Git, ou un contenu recollé à la main dans un autre fichier,
  n'est pas détecté. Un fichier qui ne doit jamais sortir de la machine n'a pas sa place dans le
  dépôt.
- **Les exclusions sont des choix.** Un fichier exclu (la documentation, les verrous de
  dépendances) n'est pas relu. Un fichier d'instructions pour agents en Markdown, par exemple,
  peut porter une consigne dangereuse : retire `**/*.md` des exclusions si ton dépôt en a.
- **Le coût est plafonné, pas prévu.** Le budget global est un plafond (lots x prix de session
  x essais) ; le coût réel est écrit dans l'artefact.
- **Le plancher est une liste de phrases.** Le ledger ne sait écarter de la tranche que les
  P0 ; les autres cas du plancher sont tenus par toi, avant l'appel.
