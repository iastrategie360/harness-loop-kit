# Tâches : <titre de la story>

Story `<id>` · plan : `plan.md`

<!-- Une tâche par ligne, au format exact ci-dessous : le superviseur prend la première ligne
     non cochée, le codeur la coche dans le commit qui la livre.

     - [ ] T<n> : <verbe> <quoi> (<fichiers>) ; vérif : <commande>

     [P] après le numéro : la tâche ne dépend d'aucune autre encore ouverte.
     Les tests s'écrivent dans la tâche qui livre le comportement.
     Les corrections nées d'une review (Tfix<n>) ou de la QA (Tbug<n>) se placent EN TÊTE.
     Ce commentaire se retire du fichier final : il contient une case qui n'est pas une tâche. -->

- [ ] T1 : <verbe> <quoi> (`<fichier>`) ; vérif : `bash harness/scripts/gate.sh tests`
- [ ] T2 [P] : <verbe> <quoi> (`<fichier>`, `<fichier>`) ; vérif : `<commande>`
