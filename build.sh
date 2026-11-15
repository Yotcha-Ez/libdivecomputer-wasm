#!/bin/bash
# build.sh : construit le module WebAssembly de libdivecomputer pour DiveLog
# (libdc.wasm et libdc.mjs, variante JSPI), puis écrit build-info.json à côté
# de ce script : commit de libdivecomputer, versions des outils, SHA-256 et
# tailles des entrées et des sorties.
#
# Copyright (C) 2026 les auteurs de DiveLog
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Usage : build.sh <dossier de sortie>
#   DiveLog :        frontend/libdc/build.sh frontend/src/libdc/generated
#   dépôt public :   LIBDC_SRC=libdivecomputer ./build.sh out
#   LIBDC_SRC=<dossier> : source de libdivecomputer déjà présente ; sans elle,
#   le commit épinglé est cloné dans vendor/.
# Outils : emcc, emconfigure, emmake (Emscripten), autoreconf, automake,
# libtool de GNU (sur macOS, celui de Homebrew), git (sans LIBDC_SRC), shasum.
#
# La bibliothèque est construite dans vendor/, à partir d'une copie propre de
# la source (sans .git, avec le fichier `revision` que libdivecomputer lit
# pour son numéro de version) : un clone ou une copie donnent les mêmes octets.
set -euo pipefail

COMMIT=14f92934c0aedbba7a5aafe8915e8a96d944335c
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ $# -ne 1 ]; then
  echo "Usage : $0 <dossier de sortie>" >&2
  exit 2
fi
OUT="$1"
VENDOR="$HERE/vendor"
SRC="$VENDOR/libdivecomputer"
LIB="$VENDOR/build-wasm"
if [ -d /opt/homebrew/opt/libtool/libexec/gnubin ]; then
  export PATH="/opt/homebrew/opt/libtool/libexec/gnubin:$PATH"
fi

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
size() { wc -c <"$1" | tr -d ' '; }

EMCC_VERSION="$(emcc --version | head -n 1)"
CLANG_VERSION="$(emcc -v 2>&1 | grep -m 1 'clang version' || true)"
AUTOCONF_VERSION="$(autoconf --version | head -n 1)"
AUTOMAKE_VERSION="$(automake --version | head -n 1)"
LIBTOOL_VERSION="$(libtool --version | head -n 1)"

mkdir -p "$VENDOR" "$OUT"
OUT="$(cd "$OUT" && pwd)"

STAMP="$COMMIT ${LIBDC_SRC:+copie} $(sha "$HERE/sans_tiocgserial.h") $(sha "$HERE/build.sh") $EMCC_VERSION $AUTOCONF_VERSION $AUTOMAKE_VERSION $LIBTOOL_VERSION"
if [ ! -f "$LIB/src/.libs/libdivecomputer.a" ] || [ "$(cat "$LIB/.divelog-stamp" 2>/dev/null)" != "$STAMP" ]; then
  rm -rf "$SRC" "$LIB"
  mkdir -p "$SRC" "$LIB"
  if [ -n "${LIBDC_SRC:-}" ]; then
    [ -f "$LIBDC_SRC/configure.ac" ] || { echo "LIBDC_SRC : configure.ac introuvable dans $LIBDC_SRC" >&2; exit 1; }
    cp -R "$LIBDC_SRC/." "$SRC"
    rm -rf "$SRC/.git"
  else
    CLONE="$VENDOR/clone"
    if [ ! -d "$CLONE/.git" ]; then
      git clone --quiet https://github.com/libdivecomputer/libdivecomputer.git "$CLONE"
    fi
    git -C "$CLONE" cat-file -e "$COMMIT^{commit}" 2>/dev/null || git -C "$CLONE" fetch --quiet origin "$COMMIT"
    git -C "$CLONE" archive "$COMMIT" | tar -x -C "$SRC"
  fi
  echo "$COMMIT" >"$SRC/revision"
  (cd "$SRC" && autoreconf --install --force >/dev/null 2>&1)
  (cd "$LIB" && emconfigure "$SRC/configure" --host=wasm32-unknown-emscripten \
    --disable-shared --enable-static --without-libusb --without-hidapi --without-bluez \
    --disable-examples --disable-doc --disable-pty \
    CFLAGS="-Oz -include $HERE/sans_tiocgserial.h" >/dev/null)
  (cd "$LIB" && emmake make -j8 >/dev/null)
  echo "$STAMP" >"$LIB/.divelog-stamp"
fi

emcc "$HERE/divelog_libdc.c" "$LIB/src/.libs/libdivecomputer.a" \
  -I"$SRC/include" -I"$LIB/include" \
  -Oz -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 \
  -sFILESYSTEM=0 -sINCOMING_MODULE_JS_API=wasmBinary,locateFile,print,printErr \
  -sEXPORTED_FUNCTIONS=_dl_download,_dl_list_ble,_dl_version,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,HEAPU8,UTF8ToString,stringToUTF8 \
  -sJSPI=1 -sJSPI_EXPORTS=dl_download -sEXPORT_NAME=createLibdc \
  -o "$OUT/libdc.mjs"

cat >"$HERE/build-info.json" <<EOF
{
  "libdivecomputer": {
    "repository": "https://github.com/libdivecomputer/libdivecomputer",
    "commit": "$COMMIT"
  },
  "tools": {
    "emcc": "$EMCC_VERSION",
    "clang": "$CLANG_VERSION",
    "autoconf": "$AUTOCONF_VERSION",
    "automake": "$AUTOMAKE_VERSION",
    "libtool": "$LIBTOOL_VERSION"
  },
  "inputs": {
    "build.sh": "$(sha "$HERE/build.sh")",
    "divelog_libdc.c": "$(sha "$HERE/divelog_libdc.c")",
    "sans_tiocgserial.h": "$(sha "$HERE/sans_tiocgserial.h")"
  },
  "outputs": {
    "libdc.wasm": { "sha256": "$(sha "$OUT/libdc.wasm")", "bytes": $(size "$OUT/libdc.wasm") },
    "libdc.mjs": { "sha256": "$(sha "$OUT/libdc.mjs")", "bytes": $(size "$OUT/libdc.mjs") }
  }
}
EOF

echo "libdivecomputer $COMMIT"
for f in "$OUT/libdc.wasm" "$OUT/libdc.mjs"; do
  printf '%-11s %8d octets, %7d en gzip, sha256 %s\n' "$(basename "$f")" "$(size "$f")" "$(gzip -9c "$f" | wc -c)" "$(sha "$f")"
done
