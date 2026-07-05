# services/wx — fixtures only

The Python environmental gateway (`app.py`, the retired :8093 oracle) was DELETED in CLIENT-28:
the C++ `helm-envd` (:8094) proved and replaced the compact grid-pack field contract (WX-20/WX-26),
so the reference oracle's parity job is done.

Only `fixtures/` remains — canonical `helm.env.grid.v1` / bundle / pack-factory-job JSON used by the
web e2e specs (wx26/wx33/client23) and the pack-factory tests. Do not add runtime code here.
