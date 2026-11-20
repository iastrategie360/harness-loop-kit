# Leçons de quatre mois de boucle multi-agents

Ces leçons viennent de quatre mois d'usage réel d'une boucle multi-agents : un superviseur, des sous-agents, un relecteur externe, des gates humaines.
Chacune a coûté quelque chose : des heures perdues, une fusion à défaire, une préproduction à restaurer.
Chaque leçon dit le piège, ce qui est arrivé, puis la règle à appliquer.
Elles sont classées par thème. La dernière section donne les dix à lire en premier.

## Mesurer et prouver

**1. Lire la sortie entière**
- Le piège : ne lire que la fin d'une sortie, ou la fouiller avec un motif trop étroit.
- Ce qui est arrivé : un `tail` court a coupé la ligne des erreurs et une vérification de types a été annoncée verte sur une CI rouge ; ailleurs, un motif ancré en début de ligne n'a pas vu vingt-cinq échecs préfixés de codes de couleur.
- La règle : juger sur le code de sortie ou la ligne du verdict, dépouiller les codes de couleur avant de chercher, et vérifier que réussis, échoués et sautés s'additionnent au total.

**2. Terminaison n'est pas réussite**
- Le piège : prendre « la commande a rendu la main » pour « la commande a réussi ».
- Ce qui est arrivé : une dernière ligne « N réussis » coiffait cinq échecs, et une veille sortie sur une erreur de permission a été lue comme « terminé ».
- La règle : faire nommer à l'outil ce qu'il a mesuré (code, compte, ligne de verdict citée) avant de rapporter un résultat.

**3. Verdict plus précis que la mesure**
- Le piège : un message d'échec qui affirme une cause que le code n'a pas mesurée.
- Ce qui est arrivé : un utilitaire de test rendait « faux » sur simple délai et affichait deux causes supposées ; deux sessions ont cherché deux heures une régression qui était une lenteur.
- La règle : un message d'échec nomme ce qui a été observé et sur quel périmètre, jamais une cause devinée.

**4. Mesure juste, conclusion trop large**
- Le piège : étendre une mesure locale à tout le système.
- Ce qui est arrivé : « aucun appel dans ce fichier » est devenu « la règle n'existe nulle part », et un brief fondé sur cette absence a engagé tout l'aval.
- La règle : écrire ce que la mesure ne dit pas ; devant « l'étape a tourné », demander ce qu'elle a fait.

**5. Ne pas avaler l'erreur de l'outil**
- Le piège : remplacer l'erreur d'origine par un message maison, puis empiler des reprises silencieuses.
- Ce qui est arrivé : huit passages en préproduction sans aucun défaut du produit, parce que le message maison masquait la cause (un clic posé avant que l'interface soit prête) ; ailleurs, une reprise muette a fait durer quinze minutes un contrôle de trente secondes pendant des semaines.
- La règle : relayer l'erreur d'origine, lire le message avant le titre du test, chercher la condition d'attente avant d'ajouter une reprise ; une reprise dit ce qu'elle a mesuré à chaque tentative.

**6. Preuve par mutation**
- Le piège : croire qu'une suite verte prouve que l'effet est gardé.
- Ce qui est arrivé : l'effet entier d'une story a été annulé à la main, et près de trois mille tests sont restés verts.
- La règle : couper la valeur à chaque frontière et exiger qu'un témoin nommé rougisse, sinon le témoin manque ; restaurer ensuite et le prouver par un diff vide.

**7. Compter n'est pas identifier**
- Le piège : une garde qui exige N éléments sans dire lesquels.
- Ce qui est arrivé : un fichier renommé a gardé le compte juste et créé un objet hors catalogue chez un service tiers.
- La règle : énumérer l'ensemble attendu et exiger l'égalité d'ensemble, manquants et inattendus nommés, sur toutes les voies d'entrée.

**8. Mesurer aux bornes**
- Le piège : la bonne propriété, vérifiée au mauvais endroit.
- Ce qui est arrivé : le témoin « l'en-tête ne déborde pas » tournait à une largeur confortable ; la page débordait sur les plus petits écrans.
- La règle : pour toute grandeur continue, mesurer aux extrêmes (plus petit écran, jeu vide, plus ancien enregistrement).

**9. Une valeur absente passe la comparaison**
- Le piège : `abs(a - b) > tolérance` vaut faux quand un des termes n'est pas un nombre.
- Ce qui est arrivé : une colonne renommée a rendu une garde muette et verte.
- La règle : rejeter le non-fini avant de comparer ; une garde de présence n'est pas une garde d'exactitude.

**10. Mesurer dans le harnais de test**
- Le piège : une sonde lancée à la main n'a pas les conditions du test.
- Ce qui est arrivé : deux sondes manuelles contredisaient un test rouge, et c'est le test qui avait raison.
- La règle : instrumenter le vrai test sous sa vraie configuration ; pour un « avant », rejouer la suite d'avant contre le code d'avant.

**11. Valeur recopiée au lieu d'être lue**
- Le piège : un littéral copié d'une source qui continue de bouger.
- Ce qui est arrivé : une borne figée, des dimensions recopiées de la commande, une garde qui citait « l'autorisation de tel jour » : toutes fausses dès que la source a changé.
- La règle : devant tout littéral, demander où vit la source et la lire ; si la copie est voulue, la commenter et poser un témoin qui la compare à la source.

**12. Une affirmation sur l'état se mesure**
- Le piège : rapporter un état depuis sa mémoire ou depuis une note de la veille.
- Ce qui est arrivé : « c'est déjà au backlog » et « la tâche planifiée est posée » ont été annoncés à tort, alors que vérifier coûtait trois secondes.
- La règle : mesurer avant de rapporter ; rejouer tout remède tiré d'une note avant de l'appliquer, et corriger la note à la source.

**13. Artefact de banc ou défaut**
- Le piège : classer une anomalie « propre au banc local » sans lire le code.
- Ce qui est arrivé : un point d'entrée répondait sans authentification sur le banc ; le code acceptait tout quand le secret manquait.
- La règle : demander ce que fait le code quand la chose est absente ; un rapport de QA dit pourquoi chaque échec serait dû à l'environnement.

**14. Dans un balayage, la borne doit suivre**
- Le piège : garder un plafond figé pendant qu'on fait varier une grandeur.
- Ce qui est arrivé : le plafond a fabriqué une inflexion, publiée comme un rendement décroissant ; la conclusion s'est inversée une fois la borne corrigée.
- La règle : faire varier planchers et plafonds avec la grandeur balayée ; quand la ressource pilote la dépense qui la consomme, résoudre par point fixe ou écrire « vaut pour une dotation de X ».

**15. Tests accrochés à la présentation**
- Le piège : viser un élément par son libellé ou par sa classe de style.
- Ce qui est arrivé : trois échecs sur quatre d'une refonte venaient de ces sélecteurs, et un contrôle a refusé une amélioration.
- La règle : poser des identifiants de test dédiés, lire les rôles dans l'arbre d'accessibilité calculé, et corriger tous les points d'accroche d'un coup.

**16. Un nettoyage se prouve sur les résidus du run**
- Le piège : comparer les effectifs globaux des tables avant et après un test.
- Ce qui est arrivé : le contrôle rougissait dès qu'un autre fichier de tests tournait en parallèle.
- La règle : compter les lignes rattachées au run, puis prouver le contrôle en concurrence et par mutation.

**17. Saturation ou régression**
- Le piège : lire une cascade de délais dépassés comme un défaut du code.
- Ce qui est arrivé : une suite locale lourde tournait sur la machine qui servait la cible d'un test distant ; deux runs indépendants échouaient aux mêmes endroits.
- La règle : mesurer la charge avant d'accuser, poser une condition de relance mesurée, et se méfier d'un chiffre de capacité retenu de mémoire.

## Gates et codes de sortie

**18. Une gate dans un pipe ne garde rien**
- Le piège : `gate | tail -1 || exit 1` teste `tail`, pas la gate.
- Ce qui est arrivé : une demande de fusion est passée avec deux défauts bloquants ouverts.
- La règle : lancer une gate sans pipe, ou sous `set -o pipefail` ; séparer la revue et la fusion en deux gestes.

**19. Revalider la revue juste avant de fusionner**
- Le piège : prendre une CI verte pour une revue soldée, ou une revue propre pour une CI verte.
- Ce qui est arrivé : un défaut est entré sans statut, et une gate a été présentée « revue propre » avec un workflow rouge depuis plusieurs commits.
- La règle : tout script qui fusionne rappelle la gate de revue juste avant, liste les runs de la branche et exige le vert sur le commit de tête.

**20. Une gate lit le disque, pas la branche**
- Le piège : une gate locale lit les fichiers présents, commités ou non.
- Ce qui est arrivé : une gate est passée grâce à un fichier modifié qui n'était pas dans le commit.
- La règle : exiger un arbre propre sur les fichiers lus, puis vérifier le résultat sur la branche distante.

**21. Marqueurs détectés par sous-chaîne**
- Le piège : fermer un défaut, ou bloquer une release, sur la simple présence d'un mot.
- Ce qui est arrivé : répondre « non corrigé » fermait le défaut, et un paragraphe qui nommait un marqueur pour expliquer son absence a bloqué une mise en production.
- La règle : utiliser un marqueur explicite et ancré, relire sa propre réponse contre le motif, ne jamais écrire le motif littéral dans la prose.

**22. Garde qui se désactive, erreur jetée**
- Le piège : une garde qui passe quand sa référence manque, et un `2>/dev/null` sur la commande qui décide.
- Ce qui est arrivé : deux heures de diagnostic sur un job arrêté sans message.
- La règle : échouer fermé quand la référence manque ; ne jamais jeter la sortie d'erreur d'une commande dont l'échec arrête un job.

**23. Un refus doit avoir une issue**
- Le piège : chaque garde ajoutée crée une nouvelle façon de refuser un travail correct.
- Ce qui est arrivé : sept correctifs de suite ont porté sur des refus sans issue d'un artefact valide.
- La règle : tout refus nomme l'action à faire ; à chaque durcissement, rejouer un parcours nominal réel.

**24. La liste vide dans une boucle d'attente**
- Le piège : une requête mal formée rend une liste vide et un code de succès.
- Ce qui est arrivé : une attente filtrée sur un identifiant de commit abrégé a tourné seize minutes sur une CI déjà verte.
- La règle : passer l'identifiant complet, traiter le vide comme un cas distinct, sortir sur « terminé et conclusion non nulle ».

## Boucles de revue

**25. La boucle ne converge pas vers le vide**
- Le piège : attendre une revue sans aucune remarque pour s'arrêter.
- Ce qui est arrivé : douze rounds sans jamais une revue vide ; les derniers défauts venaient tous des correctifs précédents, et la preuve exigée coûtait dix fois le correctif.
- La règle : écrire la règle d'arrêt avant de lancer (ni bloquant ni faux vert au dernier round, reste déjà tranché ou plus étroit) ; corriger l'atteignable, différer le reste par écrit, dire à l'approbateur combien de rounds ont tourné.

**26. Deux relecteurs, et pas d'arrêt trop tôt**
- Le piège : un seul relecteur, ou l'arrêt au premier round calme.
- Ce qui est arrivé : sur sept rounds, cinq défauts bloquants sont venus du second relecteur, et le pire du premier au sixième round.
- La règle : croiser deux relecteurs (l'un vérifie que cela marche, l'autre que cela dit vrai) et continuer tant qu'un round produit un bloquant réel. Le kit n'en livre qu'un pour le code : c'est une limite connue, dite dans `harness/HARNESS.md`. L'option `mistral` ajoute un second service pour la sécurité et l'arbitrage (leçons 71 à 74).

**27. Vérifier l'arbitre contre sa propre justification**
- Le piège : appliquer à la lettre le correctif suggéré par un arbitre.
- Ce qui est arrivé : un correctif suggéré ouvrait pire que ce qu'il fermait, et un report s'appuyait sur une promesse de la spec que le plan ne tenait pas.
- La règle : confronter justification et correctif, relire les items entre eux, vérifier que l'exigence invoquée est bien implémentée.

**28. Vérifier le relecteur avant de corriger**
- Le piège : corriger sans tester l'affirmation, ou laisser l'artefact de revue dans le diff.
- Ce qui est arrivé : deux défauts ont été réfutés par un test de trente secondes ; un relecteur lisait son propre rapport du passage précédent, le trouvait périmé, et la boucle s'entretenait.
- La règle : tester l'affirmation ; expliquer le mécanisme dans l'artefact pour tarir un faux positif ; exclure les artefacts de revue du diff soumis.

**29. Lecture seule forcée à chaque appel**
- Le piège : supposer qu'un relecteur ne peut pas écrire.
- Ce qui est arrivé : sur un dépôt marqué de confiance, le relecteur avait l'écriture par défaut ; il a lancé une construction qui a figé des secrets de production dans un artefact.
- La règle : forcer le bac à sable en lecture seule dans la commande elle-même et lire dans le journal la politique réellement appliquée.

**30. Aucun écrivain pendant un relecteur**
- Le piège : la garde de lecture seule compare l'arbre avant et après, sans savoir qui a écrit.
- Ce qui est arrivé : une remise à zéro de l'arbre a détruit l'édition en cours d'un codeur, puis celle du superviseur.
- La règle : committer et pousser, puis ne rien écrire jusqu'à la sortie du relecteur ; les relecteurs tournent en parallèle entre eux, jamais avec un codeur dans le même répertoire.

**31. Revue fraîche, périmée ou refusée**
- Le piège : lire « relu » sans regarder de quand date la revue.
- Ce qui est arrivé : l'outil affichait les défauts de la revue précédente pendant que la nouvelle demande était refusée pour quota ; une veille lancée en tâche détachée n'a réveillé personne.
- La règle : comparer l'horodatage de la revue à celui de la dernière demande, donner un état distinct au refus, faire suivre la veille par le harnais.

**32. Arbitres indisponibles, relecteur muet**
- Le piège : dimensionner une boucle sur des relecteurs qui ne répondent pas.
- Ce qui est arrivé : deux arbitres sur trois étaient hors service, et un relecteur a tourné dix heures sur un gros diff pour rendre zéro octet.
- La règle : vérifier que chacun répond avant de lancer, le dire dans l'état, borner le diff soumis, donner une échéance, surveiller le processus et non la taille du fichier de sortie.

**33. La lettre contre le fond**
- Le piège : le critère est vert, l'intention est manquée ; le filtre retient l'objection la mieux formulée, pas la plus grave.
- Ce qui est arrivé : l'auteur d'une objection a répondu que la garde était verte et son problème entier ; un lecteur placé devant le rendu a vu ce que la revue et la QA avaient manqué.
- La règle : montrer le rendu à l'auteur de l'objection, et demander à l'arbitre ce que le lot retenu ne traite pas.

## Correctifs

**34. La jumelle mécanique**
- Le piège : une règle vit dans un paragraphe de principe et dans une liste d'étapes ; c'est l'étape qui est suivie.
- Ce qui est arrivé : une règle a été corrigée quatre fois dans le principe seul, et un même énoncé a été poursuivi sur six surfaces pendant cinq rounds.
- La règle : recenser toutes les occurrences avant de corriger, corriger l'étape avant le principe ; la surface la plus critique est celle qu'une machine lit.

**35. Un chemin fermé par plusieurs couches**
- Le piège : corriger une garde quand trois se succèdent sur le même parcours.
- Ce qui est arrivé : deux correctifs verts et relus sont restés inertes ; leurs témoins lisaient la source au lieu d'exercer le parcours.
- La règle : recenser toutes les couches, puis exiger un témoin qui joue le parcours de bout en bout dans l'état fautif.

**36. Une garde a deux côtés**
- Le piège : durcir la preuve positive ou la contre-preuve, jamais les deux.
- Ce qui est arrivé : dix rounds et vingt-quatre correctifs sur une garde sans test.
- La règle : une dérivation unique partagée par les deux côtés, un test de la garde elle-même ; une liste fermée qui produit un défaut par round se remplace par un invariant.

**37. Le correctif étroit crée le défaut suivant**
- Le piège : rendre un défaut rare au lieu de le rendre inexprimable.
- Ce qui est arrivé : cinq fois en deux jours, le correctif d'un round a produit le défaut du round suivant.
- La règle : porter la précondition dans l'écriture elle-même (comparer puis échanger), tenir la règle à un seul endroit consommé par toutes les surfaces, demander si les surfaces voisines ont le même défaut.

**38. Une règle sans appelant ne garde rien**
- Le piège : une règle centrale bien écrite, appelée sur une seule surface.
- Ce qui est arrivé : un terme banni est sorti sur une surface non couverte, et la garde surveillait l'écran interne, pas celui où l'offre est présentée à l'acheteur.
- La règle : lister les appelants et les surfaces non couvertes, en commençant par celle où le client paie.

**39. Une liste de points d'attache est une hypothèse**
- Le piège : corriger d'après une liste dressée de mémoire ou d'après une première recherche.
- Ce qui est arrivé : six recensements, six sous-estimations (un trouvé pour quatre réels, sept pour quinze).
- La règle : balayer le dépôt entier au moment d'agir : code, tests, scripts, workflows, documents, surveillance, configuration.

**40. Lire l'effet, pas la signature**
- Le piège : appeler une fonction d'après son nom, ou corriger un champ qu'un autre réécrit.
- Ce qui est arrivé : un appel d'écriture a laissé une trace indélébile dans une table d'audit ; un correctif vidait des champs que le service d'authentification remplissait juste après.
- La règle : lire le corps (ce qu'il exige, ce qu'il écrit ailleurs), mesurer qui écrit en dernier, passer par l'interface du propriétaire de la donnée.

**41. Hors dépôt, non gardé**
- Le piège : croire qu'un objet qui vit chez un fournisseur est couvert par les gardes du dépôt.
- Ce qui est arrivé : des réglages n'existaient que chez le fournisseur, et l'outil d'envoi en amputait le début sans erreur.
- La règle : relire l'objet distant après l'envoi, pas le code de sortie ; faire entrer l'artefact dans le dépôt, ou écrire que la garde ne le couvre pas.

**42. Les événements entrants suivent le réglage du fournisseur**
- Le piège : croire que la forme d'un événement reçu dépend de la version du kit installé.
- Ce qui est arrivé : chaque renouvellement envoyé par le fournisseur de paiement était rejeté sans trace.
- La règle : ne lire que l'enveloppe stable, relire l'objet par le kit épinglé, passer au moins une fois par un événement réel.

## Environnements et déploiement

**43. Le contrôle de périmètre ne voit que les fichiers**
- Le piège : croire que deux chantiers sans fichier commun ne se gênent pas.
- Ce qui est arrivé : deux créneaux parallèles partageaient la base locale et la préproduction ; une remise à neuf a vidé la base du voisin en plein test.
- La règle : prévenir avant toute opération sur une ressource partagée ; devant un rouge inexplicable, regarder d'abord chez le voisin.

**44. Un déploiement de branche laisse trois traces**
- Le piège : déployer une branche en préproduction, puis ne remettre que le code.
- Ce qui est arrivé : schéma, code servi et historique des migrations sont restés décalés, chaque trace masquant la suivante.
- La règle : écrire la restauration depuis un relevé, la prouver sur une base jetable et la faire autoriser avant le déploiement ; restaurer à l'identique, jamais « en plus permissif ».

**45. La relance partielle teste un environnement périmé**
- Le piège : relancer seulement les jobs échoués.
- Ce qui est arrivé : trois relances rouges ont visé un conteneur que la relance ne reconstruisait pas.
- La règle : relancer tout dès qu'on doute de ce que la cible sert, et comparer ce qui est servi à ce que la branche contient.

**46. Un job s'arrête à la première rouge**
- Le piège : lire la première rouge comme l'ampleur du problème, ou annuler un job long sans point de comparaison.
- Ce qui est arrivé : cinq défauts se masquaient dans un même job, le premier vieux de plusieurs jours, aucun dû au changement en cours.
- La règle : dater le dernier vert, lire les étapes sautées, dire que l'ampleur reste inconnue ; avant d'annuler, comparer à la durée du dernier run réussi.

**47. Chercher ce qui a lancé, pas qui**
- Le piège : régler une collision par une convention entre personnes.
- Ce qui est arrivé : deux fusions rapprochées ont lancé deux constructions concurrentes sur la même machine.
- La règle : poser un verrou de machine ; vérifier qu'un groupe de concurrence commun n'annule pas un déploiement de production en attente.

**48. L'arbre de travail ne doit pas être la cible du déploiement**
- Le piège : déployer dans le répertoire où l'on travaille.
- Ce qui est arrivé : le déploiement a remis l'arbre à zéro, déplacé la branche et détruit un travail non commité.
- La règle : séparer les deux répertoires ; à défaut, committer et pousser avant toute fusion, et lire l'état distant par `git ls-remote`.

**49. Une release bute d'abord sur ce qui n'est pas le code**
- Le piège : chercher la cause dans le diff quand le tuyau ou un tiers a lâché.
- Ce qui est arrivé : quatre échecs en un jour sans lien avec le code (réseau intermittent, limite de téléchargement anonyme, session distante coupée en pleine construction).
- La règle : exclure le diff en dix secondes, détacher la construction et journaliser côté serveur, lire l'ordre des étapes pour savoir si la base est à moitié migrée.

**50. Migration : base peuplée, transaction unique**
- Le piège : valider une migration sur une base vide.
- Ce qui est arrivé : rejouée dix fois sans erreur sur base vide, elle a échoué en préproduction.
- La règle : semer un état réaliste, rejouer en une seule transaction, geler les migrations entre la répétition et la mise en production.

**51. Le prochain numéro de migration a trois sources**
- Le piège : compter sur la branche d'intégration seule.
- Ce qui est arrivé : le numéro vivait déjà sur une branche en vol, appliquée en préproduction ; la seconde migration du même numéro n'a jamais été exécutée et la commande est sortie verte.
- La règle : regarder la branche d'intégration, les branches en vol et les environnements, puis renommer avant d'écrire.

**52. Rejouer une migration, c'est rejouer sa queue**
- Le piège : rejouer une migration ancienne sur une base à jour.
- Ce qui est arrivé : un test a annulé en silence les migrations suivantes sur les mêmes objets ; quatre diagnostics faux ont suivi.
- La règle : rejouer toute la queue qui touche les mêmes objets, ou travailler sur une base jetable.

**53. « Fait en préproduction » reste à faire en production**
- Le piège : vérifier des pages, jamais un parcours complet.
- Ce qui est arrivé : une ouverture au public avec un segment entier inopérant, ses réglages n'existant qu'en préproduction.
- La règle : avant toute ouverture, jouer le parcours de bout en bout par segment en production et comparer les réglages des deux environnements.

**54. Ne jamais tuer un processus par son nom**
- Le piège : prendre pour des restes de test tout ce qui porte un nom familier.
- Ce qui est arrivé : trois processus « orphelins » étaient la production, la préproduction et un autre site.
- La règle : cibler un identifiant de processus ou un port exact, après avoir vérifié à quoi il appartient.

**55. Trois verts qui ne couvrent pas la même chose**
- Le piège : additionner types verts, tests verts et préproduction verte.
- Ce qui est arrivé : un module serveur importé dans un composant client cassait le paquet client, et aucun des trois ne le voyait.
- La règle : faire une construction réelle sur le banc ; se rappeler que le banc a souvent plus d'outils installés que la CI.

## Git et forge

**56. Paginer l'API de la forge**
- Le piège : `gh api` rend trente éléments par défaut, les plus anciens d'abord.
- Ce qui est arrivé : « aucune réponse du relecteur » a été annoncé deux fois, puis une fusion recommandée avec trois défauts majeurs ouverts.
- La règle : passer par un seul script de référence qui pagine, ne jamais compter à la main, lire les deux canaux de commentaires.

**57. Relire ce que le commit emporte**
- Le piège : `git add` d'un dossier, et un message passé entre guillemets doubles.
- Ce qui est arrivé : trente-sept fichiers non suivis d'une autre personne sont partis dans l'historique ; le shell a exécuté les accents graves d'un message et l'a amputé sans rien de rouge.
- La règle : ajouter par chemins nommés, écrire le message dans un heredoc quoté, relire `git show --name-only HEAD` avant de pousser.

**58. La clôture écrite après la fusion reste orpheline**
- Le piège : fusionner, puis écrire l'état « terminé » sur la branche.
- Ce qui est arrivé : l'état partagé a annoncé « en attente » pendant deux jours.
- La règle : un commit ajouté à une branche déjà fusionnée n'arrive nulle part ; écrire la clôture sur une branche neuve partie de la branche d'intégration, la fusionner à son tour, et vérifier par `git merge-base --is-ancestor` ; ce qui n'est pas poussé n'existe que pour son auteur.

**59. Regarder les demandes de fusion ouvertes avant d'écrire**
- Le piège : commencer un correctif sans regarder ce qui dort.
- Ce qui est arrivé : une heure passée à réécrire un correctif qui attendait depuis trois semaines, en mieux ; un faux positif relevé par une autre session a failli être relayé tel quel.
- La règle : lister demandes et branches avant d'écrire, vérifier avant de relayer, lister cette dette à chaque release.

**60. Jetons et secrets**
- Le piège : chercher un refus dans les mauvaises permissions, ou passer une clé en clair dans une commande.
- Ce qui est arrivé : l'outil d'agent a enregistré neuf fois une clé de production dans sa liste de commandes autorisées ; il a fallu la révoquer.
- La règle : lire la clé depuis un fichier d'environnement ; sur GitHub, lire l'en-tête `X-Accepted-Github-Permissions` pour un jeton à portée fine ; toute clé exposée est compromise.

## Délégation et sous-agents

**61. Valider une tâche sur la suite entière**
- Le piège : valider la tâche d'un codeur sur son seul fichier de tests.
- Ce qui est arrivé : la suite entière était rouge, et c'est le codeur suivant qui l'a découvert.
- La règle : lancer la suite unitaire entière à chaque tâche, et porter le compte des verts et des rouges dans le rapport.

**62. Le rapport d'un sous-agent est une hypothèse**
- Le piège : relayer un rapport, ou une affirmation sur un service tiers, sans les vérifier.
- Ce qui est arrivé : une tâche a été créée sur une prémisse fausse à propos d'une interface externe ; à l'inverse, un codeur qui signalait une conséquence imprévue a évité une panne.
- La règle : vérifier ce qui est rapporté (dans la documentation ou le kit installé, source citée), et prendre au sérieux ce qui est remonté.

**63. Plafond de sous-agents : session fraîche**
- Le piège : quand le plafond de délégation est atteint, le superviseur se met à tout coder.
- Ce qui est arrivé : plafond atteint en pleine story, le superviseur a fini par écrire lui-même le code qu'il devait contrôler.
- La règle : proposer une session fraîche, sur un état propre : branche poussée, état annoté (fait, reste, blocages).

**64. Un répertoire de travail parallèle partage plus qu'il n'y paraît**
- Le piège : croire qu'un second répertoire de travail est isolé du premier.
- Ce qui est arrivé : les deux partageaient le dossier des dépendances par un lien ; une installation d'un côté aurait changé l'autre, et une dépendance manquante restait invisible avant la CI.
- La règle : ne jamais installer depuis le répertoire secondaire, ne pas construire des deux côtés à la fois, ne pas conclure « la dépendance est déclarée » d'un run local.

**65. Un panel de lecteurs n'a ni navigateur ni réseau**
- Le piège : demander un avis sur un rendu à des agents qui ne peuvent pas le voir.
- Ce qui est arrivé : les lecteurs n'avaient accès qu'aux fichiers, pas au rendu servi.
- La règle : c'est au superviseur de monter le banc, de capturer le rendu et de le fournir.

## Documents et preuves

**66. Un document de preuve se date**
- Le piège : réécrire une preuve quand l'état change, ou y glisser une déduction.
- Ce qui est arrivé : deux documents commités donnaient deux états finaux incompatibles ; un plan affirmait « aucun croisement possible », faux vingt minutes plus tard.
- La règle : dater chaque mesure, ajouter un bloc daté au lieu de réécrire (ce qui était affirmé, ce qui est vrai, d'où vient l'écart), séparer mesures et déductions.

**67. Prose générée ou périmée**
- Le piège : commenter à la main des tableaux régénérés par un script.
- Ce qui est arrivé : sur huit tours de revue, presque tous les défauts étaient dans la prose écrite sous les tableaux.
- La règle : générer classements et comparaisons depuis la source, prouver l'idempotence (deux exécutions, diff vide).

**68. Une capture d'écran est une affirmation qui se périme**
- Le piège : traiter une capture comme un décor.
- Ce qui est arrivé : quatre lecteurs ont dépensé une objection sur un défaut déjà corrigé ; un terme banni est revenu par l'image ; des pages très hautes étaient illisibles pour un lecteur automatique.
- La règle : capturer après le dernier commit qui touche la surface, lire la capture comme une phrase, corriger à la source et recapturer, découper à la taille de la fenêtre.

## Communication avec la personne qui décide

**69. Points courts, mots de tous les jours**
- Le piège : parler le vocabulaire du pipeline à quelqu'un qui décide du produit, et répéter la même liste à chaque message.
- Ce qui est arrivé : la personne qui décide a répondu qu'elle ne comprenait pas ce qui lui était dit.
- La règle : trois lignes (ce qui avance, ce qui bloque, ce qui est attendu d'elle), ne signaler que ce qui change ; les mauvaises nouvelles se disent quand même, le détail vit dans l'état.

**70. Trancher, noter, lister à la gate**
- Le piège : interrompre pour une incohérence mineure et réversible, ou remonter une décision déjà prise.
- Ce qui est arrivé : une question a été remontée pour une incohérence sans enjeu, et une objection a rouvert une décision de marque ancienne.
- La règle : trancher et noter le motif ; ne remonter que ce qui change le périmètre, engage de l'argent, touche un accès ou ne peut pas être défait.

## Relecteurs externes, coût et décisions contraignantes

**71. Des lots plus petits, et un budget calculé avant de démarrer**
- Le piège : envoyer un gros diff en quelques gros morceaux, et découvrir le coût sur la facture.
- Ce qui est arrivé : des appels sur de gros lots ont duré plusieurs minutes, plusieurs ont été coupés par le réseau, un lot a dépassé vingt minutes ; une seule relecture d'un diff d'un million d'octets a coûté plusieurs dollars et près de deux heures.
- La règle : découper en lots plus petits (des appels plus courts, des reprises moins chères), plafonner chaque session, et refuser de démarrer si lots x plafond de session x essais dépasse le budget de la relecture.

**72. Un nouvel essai pour un hoquet, jamais pour un plafond**
- Le piège : relancer tout échec, ou n'en relancer aucun.
- Ce qui est arrivé : un seul lot tombé sur une erreur réseau, parmi une vingtaine, a fait échouer toute la relecture et repayer tous les autres ; ailleurs, relancer une session qui avait atteint son plafond de coût a payé deux fois la même impasse.
- La règle : un nouvel essai sur un échec transitoire seulement (lu sur les dernières lignes du journal, jamais sur le contenu relu), aucun sur un plafond, un délai ou un refus d'authentification ; et une reprise qui ne relance que les lots sans réponse, sur un instantané identique.

**73. Deux producteurs, deux artefacts**
- Le piège : ranger la relecture d'un second relecteur dans le même artefact que la première.
- Ce qui est arrivé : la fusion ferme d'elle-même un défaut absent d'une nouvelle relecture ; dans un artefact partagé, une relecture sécurité propre aurait fermé tous les défauts ouverts de la review de code.
- La règle : un artefact par producteur, lus par la même gate, le plus prudent l'emporte ; écrire l'un ne périme pas l'autre, et une relecture absente bloque.

**74. Jamais de décision contraignante sur un contexte amputé**
- Le piège : tronquer un prompt trop gros pour qu'il passe, puis appliquer la réponse.
- Ce qui est arrivé : un prompt borné par la taille d'un argument du système coupait le diff en silence ; un modèle sans outil ne voyait plus le morceau qui comptait, et sa décision allait être appliquée telle quelle.
- La règle : un prompt n'est jamais tronqué ; au-delà de la borne, c'est un refus. Une décision qui s'applique sans relecture humaine exige un contexte complet, ou elle n'a pas lieu.

## Les dix à retenir d'abord

1. Juger sur le code de sortie et la ligne du verdict, jamais sur un extrait de sortie (leçons 1 et 2).
2. Une gate ne passe jamais dans un pipe, et se rejoue juste avant la fusion (18 et 19).
3. Un témoin ne vaut que s'il rougit quand on coupe la valeur : le prouver par mutation (6).
4. Exiger l'égalité d'ensemble, pas un décompte (7).
5. Écrire la règle d'arrêt de la boucle de revue avant de la lancer (25).
6. Forcer la lecture seule du relecteur, et n'avoir aucun écrivain pendant qu'il lit (29 et 30).
7. Recenser toutes les occurrences d'une règle avant de corriger, les étapes d'abord (34 et 39).
8. Rendre l'état fautif inexprimable plutôt que rare ; une garde a deux côtés (36 et 37).
9. Ce qui est partagé hors des fichiers (base, préproduction, dépendances) n'est gardé par personne (43, 44 et 64).
10. Toute affirmation sur l'état se mesure et se date : un verdict faux coûte plus cher qu'un échec (12 et 66).
