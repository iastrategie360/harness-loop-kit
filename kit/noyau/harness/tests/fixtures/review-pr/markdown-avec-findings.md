The fixture makes the timestamp assertion permanently vacuous, and cleanup failures can leave persistent test data while reporting success. Both undermine the guarantees this change is intended to add.

Full review comments:

- [P2] Seed a transcript so timestamps remain covered — /srv/projet/tests/integration/jeu-de-donnees.sql:3772-3773
  Because this patch now always opens its own seeded report, leaving `transcript` null guarantees that every timestamp is suppressed. The conditional timestamp assertion therefore always skips, so layout or click regressions pass unnoticed despite the [proof requirement](docs/stories/001-jouet/tasks.md#L10-L13) asking for visible timestamps.

- [P2] Fail the suite when cleanup cannot remove the seed — /srv/projet/tests/parcours/parcours.test.py:181-183
  If the direct delete fails and the fallback cleanup also fails, for example during a transient database error, both errors are reduced to warnings and the suite still passes with the synthetic record left behind. Propagate the cleanup failure after attempting both paths.
