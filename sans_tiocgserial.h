/*
 * sans_tiocgserial.h : inclus de force (-include) dans chaque fichier de
 * libdivecomputer compilé pour le navigateur.
 *
 * Copyright (C) 2026 les auteurs de DiveLog
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Emscripten déclare TIOCGSERIAL sans fournir linux/serial.h : serial_posix.c
 * tenterait alors d'utiliser une structure inconnue. Le port série n'existe pas
 * dans un navigateur ; on retire ces deux constantes pour qu'il prenne sa
 * branche générique. Aucune source de libdivecomputer n'est modifiée.
 */
#include <sys/ioctl.h>
#undef TIOCGSERIAL
#undef TIOCSSERIAL
