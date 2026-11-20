---
description: Tableau de bord du harness. Affiche l'état de toutes les stories (stage, tours, attentes, PR) sans rien modifier.
---

Tu es en LECTURE SEULE : tu n'écris et ne modifies rien, tu ne lances aucune relecture.

1. `node harness/scripts/etat.mjs liste` rend toutes les stories en JSON. Liste vide : dis-le
   et arrête-toi. Une story marquée `invalide` se signale telle quelle, avec la commande
   `node harness/scripts/etat.mjs valider <id>` pour voir pourquoi.
2. Compose un tableau, une ligne par story :
   `| story | titre | stage | tours/max | attendu | PR | dernier pas |`
3. Les stories en `waiting_gate_*` viennent EN PREMIER. Pour chacune, dis ce que l'approbateur
   (`node harness/scripts/lib/config.mjs lire projet.approbateur`) doit lire et la commande à
   taper : `/harness approve <id>` ou `/harness renvoyer <id> <STAGE> "<motif>"`. Le motif de
   l'attente se lit par `node harness/scripts/etat.mjs lire <id> gates`.
4. Les stories en `stopped_*` viennent ensuite, avec leur dernier blocage
   (`node harness/scripts/etat.mjs lire <id> blocages`) et la commande de reprise
   `/harness resume <id>`.
5. Pour une story au stage PR ou après : l'état de sa review par
   `node harness/scripts/review-locale.mjs <id> --json` (`a_jour`, `open_p0_p2`, `rounds`).
   Le code de sortie 2 ou 3 de cette commande est une information, pas une erreur.
6. Pour la story la plus avancée qui n'est pas terminée, ajoute son fil d'Ariane :
   `node harness/scripts/etat.mjs fil <id>`.
7. Termine par trois lignes au plus : le nombre de stories par stage, et le geste le plus
   urgent pour l'approbateur.

Des phrases courtes, sans vocabulaire du pipeline dans la synthèse.
