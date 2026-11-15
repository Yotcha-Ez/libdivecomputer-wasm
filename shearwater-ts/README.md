# Anciens portages Shearwater (TypeScript)

Avant de compiler libdivecomputer, DiveLog lisait les ordinateurs Shearwater
en Bluetooth avec ces deux fichiers, écrits d'après les sources de
libdivecomputer. Ils ont été servis aux navigateurs à partir de septembre 2026.

- `shearwaterBle.ts` : transport Bluetooth (SLIP, variantes V1 et V2),
  lecture du manifeste et téléchargement des plongées, d'après
  `src/shearwater_common.c` et `src/shearwater_petrel.c`.
- `shearwaterDiveParser.ts` : décodage du format « Petrel Native Format »,
  d'après `src/shearwater_predator_parser.c`.

Ce sont des œuvres dérivées de libdivecomputer : ils sont publiés ici sous la
même licence, la GNU LGPL, version 2.1 ou (à votre choix) toute version
ultérieure (voir `../COPYING`). Ils sont donnés dans leur dernière version,
tels qu'ils étaient dans DiveLog, commentaires compris ; ils ne dépendent
d'aucun autre fichier.

*English: DiveLog's earlier TypeScript ports of libdivecomputer's Shearwater
code (Bluetooth transport and dive parser), served to browsers from
September 2026; derived works, published under the LGPL 2.1 or later.*
