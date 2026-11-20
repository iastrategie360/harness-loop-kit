# Rapport de QA : <titre de la story>

Story `<id>` · branche `<branche>` · commit `<sha court>` · le <date>

## Verdict

**<GO | NO-GO>** : <une phrase.>

## Gates

| Gate | Code | Remarque |
|---|---|---|
| statique | <code> | |
| tests | <code> | |
| build | <code> | <« absente » si le projet n'en déclare pas> |

## Critères d'acceptation

| Critère | Geste fait | Attendu | Observé | Tenu |
|---|---|---|---|---|
| C1 | <ce qui a été lancé ou cliqué> | <...> | <...> | oui / non |

## Cas d'erreur

| Cas | Geste | Observé |
|---|---|---|
| <entrée vide, accès refusé, ...> | <...> | <...> |

## Non-régression

<Ce qui a été rejoué parmi ce que le plan disait pouvoir casser, et le résultat.>

## Rendu

<Les captures, par leur chemin, ou « rien de visible par un utilisateur ».>

## Bugs

<!-- Un bug se décrit pour être reproduit. « Aucun » si rien. -->

1. **<titre>** : étapes <...> ; attendu <...> ; observé <...> ; fichier suspect `<chemin>`.

## Observations hors critères

<!-- Ce que tu as constaté et qu'aucun critère ne couvre. Le verdict n'en dépend pas, le
     superviseur tranche chacune. « Aucune » si rien. -->

- <fait constaté> : <comment le reproduire>.

## Non vérifié

<Ce qui n'a pas pu être joué, et pourquoi. « Rien » si tout a été joué.>

## Nettoyage

<Banc arrêté, données de test retirées. Scripts de preuve gardés : `preuves/<nom>`.>
