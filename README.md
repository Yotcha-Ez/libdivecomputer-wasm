# libdivecomputer-wasm

*English summary below.*

Ce dépôt publie la partie libre de **DiveLog**, un carnet de plongée en ligne :
la bibliothèque [libdivecomputer](https://github.com/libdivecomputer/libdivecomputer)
compilée en WebAssembly, et la petite colle en C qui la relie au Bluetooth du
navigateur (Web Bluetooth). DiveLog s'en sert pour lire directement un
ordinateur de plongée depuis le navigateur, sans application tierce.

libdivecomputer est distribuée sous la licence GNU LGPL, version 2.1 ou
ultérieure. Cette licence permet de l'utiliser dans une application dont le
reste du code n'est pas publié, à condition de publier la source exacte de la
bibliothèque distribuée et les ajouts qui y sont liés, et de permettre à
chacun de la recompiler et de la remplacer. C'est l'objet de ce dépôt. Le reste
de DiveLog (interface, serveur, données) n'est pas publié ; aucune plongée ni
aucun fichier de ses utilisateurs ne s'y trouve.

## Contenu

| Chemin | Rôle |
|---|---|
| `libdivecomputer/` | Source de libdivecomputer au commit `14f92934c0aedbba7a5aafe8915e8a96d944335c`, copiée telle quelle (sans historique git). Aucun fichier n'y est modifié. |
| `divelog_libdc.c` | La colle C : ouvre l'appareil par `dc_custom_open`, télécharge et relit les plongées, et appelle le JavaScript de la page (voir plus bas). |
| `sans_tiocgserial.h` | En-tête inclus de force à la compilation de libdivecomputer : retire deux constantes du port série qu'Emscripten déclare sans les fournir. |
| `build.sh` | Le script de construction. |
| `build-info.json` | Écrit par `build.sh` : commit, versions des outils, SHA-256 et tailles des entrées et des sorties. |
| `COPYING` | Texte de la GNU LGPL 2.1 (le même que `libdivecomputer/COPYING`). |
| `shearwater-ts/` | Les deux anciens fichiers TypeScript de DiveLog, dérivés de libdivecomputer (voir `shearwater-ts/README.md`). |

`divelog_libdc.c`, `sans_tiocgserial.h` et `build.sh` sont sous licence
LGPL-2.1-or-later, comme libdivecomputer.

## Reconstruire le module

Outils : Emscripten (`emcc`, `emconfigure`, `emmake`), autoconf, automake,
libtool de GNU (sur macOS, celui de Homebrew ; le script l'ajoute seul au
`PATH` s'il le trouve), `shasum`. Versions employées pour la version publiée :
voir `tools` dans `build-info.json` (Emscripten 7.0.0 de Homebrew, clang 24,
autoconf 2.73, automake 1.20, libtool 2.6.2).

```sh
LIBDC_SRC=libdivecomputer ./build.sh out
```

Le script copie la source dans `vendor/` (le dossier `libdivecomputer/` n'est
pas touché), y écrit le fichier `revision` que libdivecomputer lit pour son
numéro de version, la compile en bibliothèque statique, puis lie la colle et
produit `out/libdc.wasm` et `out/libdc.mjs` (variante JSPI). Il réécrit enfin
`build-info.json` : avec les mêmes outils, le fichier ne change pas ; sinon,
`git diff` montre ce qui diffère. Sans `LIBDC_SRC`, il clone libdivecomputer
depuis GitHub au même commit.

### SHA-256 attendus

| Version de DiveLog | Commit de libdivecomputer | `libdc.wasm` | `libdc.mjs` |
|---|---|---|---|
| `divelog-2026-11-15` (première mise en ligne) | `14f92934c0ae` | `0318039310371f169c7f6262b3a339e004de50558442b7390241a6aadd7f77f0` (332 137 octets) | `be3e980160a4b8cd71ea3f57ab7b9023f8affa4b0832a912f248120398fab618` (16 000 octets) |

Chaque version mise en ligne reçoit une étiquette git dans ce dépôt, publiée
avant le déploiement.

## Remplacer le module dans le navigateur

DiveLog sert le module dans `/assets/`, sous un nom haché : `libdc-<empreinte>.wasm`
pour le WebAssembly, et un morceau JavaScript `libdc-<empreinte>.js` qui est
`libdc.mjs` repris par l'outil de construction de l'interface (Vite). Il n'est
chargé que par l'écran d'import.

Pour faire tourner DiveLog avec une libdivecomputer modifiée :

1. Modifiez `libdivecomputer/` (ou la colle), puis reconstruisez avec
   `build.sh`.
2. Si `out/libdc.mjs` est identique à celui de la version publiée (même
   SHA-256, ce qui est le cas tant que la colle et les options de compilation
   ne changent pas), remplacez seulement le `.wasm` : dans Chrome ou Edge,
   outils de développement, *Sources > Overrides*, remplacez le contenu de
   `/assets/libdc-<empreinte>.wasm` par votre `out/libdc.wasm`.
3. Si `libdc.mjs` a changé, remplacez aussi le morceau `libdc-<empreinte>.js`
   par votre `out/libdc.mjs`, en changeant dans ce fichier le nom
   `"libdc.wasm"` en `"libdc-<empreinte>.wasm"`.

### Ce que le module attend de la page

La page charge le module par sa fonction exportée par défaut,
`createLibdc({ wasmBinary? })`, puis appelle par `ccall` :

- `dl_version()` : chaîne « 0.10.0-devel (commit) » ;
- `dl_list_ble(nom)` : les modèles lisibles en Bluetooth basse consommation
  (ceux que `nom` désigne s'il n'est pas vide), un appel de
  `Module.divelog.descriptor` par modèle ;
- `dl_download(fabricant, modèle, niveau de journal)` : asynchrone (JSPI),
  renvoie un `dc_status_t`. Les plongées arrivent de la plus récente à la plus
  ancienne ; la lecture s'arrête à l'empreinte donnée par `devinfo`, quand
  `diveEnd` répond faux, ou à l'annulation. L'appareil est toujours refermé
  par `dc_device_close` (un Shearwater reçoit alors sa commande de fin de
  session et quitte le mode Bluetooth).

La colle appelle en retour les fonctions de l'objet `Module.divelog`, que la
page fournit (pointeurs dans `Module.HEAPU8`) :

| Fonction | Rôle |
|---|---|
| `read(ptr, size)` → `Promise<number>` | octets reçus de l'appareil, copiés à `ptr` ; `-1` délai dépassé, `-2` erreur |
| `write(ptr, size)` → `Promise<number>` | envoie `size` octets ; négatif en cas d'erreur |
| `timeout` (propriété écrite) | délai de lecture demandé par libdivecomputer, en ms |
| `purge()` | vider ce qui a été reçu et pas encore lu |
| `name(ptr, size)` → `number` | écrire le nom Bluetooth de l'appareil ; négatif s'il est inconnu |
| `cancelled` (propriété lue) | vrai pour interrompre le téléchargement |
| `log(niveau, message)` | journal de libdivecomputer |
| `devinfo(modèle, micrologiciel, numéro de série, ptr, taille)` → `number` | identité de l'appareil ; écrire à `ptr` (au plus `taille` octets) l'empreinte de la dernière plongée déjà lue, et en rendre la longueur (0 : aucune, tout lire) |
| `progress(courant, maximum)` | avancement |
| `diveRaw(ptr, size, empreinte, taille de l'empreinte)` | octets bruts d'une plongée |
| `diveHeader({ status, year, month, day, hour, minute, second, timezone, divetime, maxdepth, divemode, ngasmixes, oxygen, helium, tmin })` | en-tête relu par `dc_parser` |
| `sample(type, a, b)` | un relevé (temps, profondeur, température, pression, palier) |
| `diveEnd(status)` → `boolean` | fin de la plongée (`status` : relecture par `dc_parser`) ; vrai pour continuer, faux pour s'arrêter après elle |
| `descriptor(fabricant, modèle, famille, numéro, transports)` | un modèle, pour `dl_list_ble` |

## English summary

This repository publishes the open-source part of DiveLog, an online dive log:
libdivecomputer (LGPL 2.1 or later), unmodified, at commit `14f92934c0ae`, the
small C glue that connects it to Web Bluetooth (`divelog_libdc.c`, LGPL 2.1 or
later), and the build script. Rebuild with
`LIBDC_SRC=libdivecomputer ./build.sh out` (Emscripten, autotools); the
expected SHA-256 of each released module is listed above, and `build.sh`
rewrites `build-info.json`, so `git diff` shows any difference. To run DiveLog
with a modified libdivecomputer, rebuild and substitute
`/assets/libdc-<hash>.wasm` in your browser (for instance with Chrome DevTools
local overrides); the JavaScript functions the glue calls are listed in the
table above. `shearwater-ts/` holds DiveLog's two earlier TypeScript files,
derived from libdivecomputer and published under the same licence.
