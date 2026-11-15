/*
 * divelog_libdc.c : colle entre libdivecomputer et Web Bluetooth, pour DiveLog.
 *
 * Copyright (C) 2026 les auteurs de DiveLog
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Ce fichier est libre : vous pouvez le redistribuer et le modifier selon les
 * termes de la GNU Lesser General Public License, version 2.1 ou (à votre
 * choix) toute version ultérieure, telle que publiée par la Free Software
 * Foundation. Il est distribué sans aucune garantie. Voir le fichier COPYING.
 *
 * C'est la seule colle en C, liée avec libdivecomputer dans le même module
 * WebAssembly. Il ouvre un appareil par dc_custom_open (la connexion Bluetooth
 * est fournie par le JavaScript de la page), télécharge les plongées par
 * dc_device_foreach et les relit par dc_parser. Les fonctions js_* sont écrites
 * en JavaScript et appellent l'objet Module.divelog (décrit dans le README) ;
 * celles qui attendent le Bluetooth sont asynchrones (EM_ASYNC_JS) : JSPI
 * suspend alors la pile C le temps de la promesse, car libdivecomputer appelle
 * sa connexion de façon synchrone et bloquante.
 */

#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include <libdivecomputer/ble.h>
#include <libdivecomputer/context.h>
#include <libdivecomputer/custom.h>
#include <libdivecomputer/descriptor.h>
#include <libdivecomputer/device.h>
#include <libdivecomputer/iterator.h>
#include <libdivecomputer/parser.h>
#include <libdivecomputer/version.h>

/* Réponses de Module.divelog.read et write. */
#define JS_TIMEOUT (-1)
#define JS_IO (-2)

EM_ASYNC_JS(int, js_read, (unsigned char *data, size_t size), {
	return await Module.divelog.read(data, size);
});

EM_ASYNC_JS(int, js_write, (const unsigned char *data, size_t size), {
	return await Module.divelog.write(data, size);
});

EM_ASYNC_JS(void, js_sleep, (unsigned int milliseconds), {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
});

EM_JS(void, js_set_timeout, (int timeout), { Module.divelog.timeout = timeout; });
EM_JS(void, js_purge, (void), { Module.divelog.purge(); });
EM_JS(int, js_name, (char *data, size_t size), { return Module.divelog.name(data, size); });
EM_JS(int, js_cancelled, (void), { return Module.divelog.cancelled ? 1 : 0; });
EM_JS(void, js_log, (int level, const char *message), { Module.divelog.log(level, UTF8ToString(message)); });
EM_JS(int, js_devinfo, (unsigned int model, unsigned int firmware, unsigned int serial, unsigned char *fingerprint, size_t size), {
	return Module.divelog.devinfo(model, firmware, serial >>> 0, fingerprint, size);
});
EM_JS(void, js_progress, (unsigned int current, unsigned int maximum), { Module.divelog.progress(current, maximum); });
EM_JS(void, js_dive_raw, (const unsigned char *data, unsigned int size, const unsigned char *fingerprint, unsigned int fsize), {
	Module.divelog.diveRaw(data, size, fingerprint, fsize);
});
EM_JS(void, js_dive_header, (int status, int year, int month, int day, int hour, int minute, int second, int timezone,
	unsigned int divetime, double maxdepth, int divemode, int ngasmixes, double oxygen, double helium,
	int has_tmin, double tmin), {
	Module.divelog.diveHeader({ status, year, month, day, hour, minute, second, timezone, divetime, maxdepth,
		divemode, ngasmixes, oxygen, helium, tmin: has_tmin ? tmin : null });
});
EM_JS(void, js_sample, (int type, double a, double b), { Module.divelog.sample(type, a, b); });
EM_JS(int, js_dive_end, (int status), { return Module.divelog.diveEnd(status) ? 1 : 0; });
EM_JS(void, js_descriptor, (const char *vendor, const char *product, unsigned int family, unsigned int model, unsigned int transports), {
	Module.divelog.descriptor(UTF8ToString(vendor), UTF8ToString(product), family, model, transports);
});

static dc_status_t
io_read (void *userdata, void *data, size_t size, size_t *actual)
{
	int n = js_read ((unsigned char *) data, size);
	if (n == JS_TIMEOUT) return DC_STATUS_TIMEOUT;
	if (n < 0) return DC_STATUS_IO;
	if (actual) *actual = (size_t) n;
	return DC_STATUS_SUCCESS;
}

static dc_status_t
io_write (void *userdata, const void *data, size_t size, size_t *actual)
{
	if (js_write ((const unsigned char *) data, size) < 0) return DC_STATUS_IO;
	if (actual) *actual = size;
	return DC_STATUS_SUCCESS;
}

static dc_status_t
io_set_timeout (void *userdata, int timeout)
{
	js_set_timeout (timeout);
	return DC_STATUS_SUCCESS;
}

static dc_status_t
io_sleep (void *userdata, unsigned int milliseconds)
{
	js_sleep (milliseconds);
	return DC_STATUS_SUCCESS;
}

static dc_status_t
io_purge (void *userdata, dc_direction_t direction)
{
	if (direction & DC_DIRECTION_INPUT) js_purge ();
	return DC_STATUS_SUCCESS;
}

static dc_status_t
io_ioctl (void *userdata, unsigned int request, void *data, size_t size)
{
	/* Le nom Bluetooth sert à certaines familles (Oceanic, Aqualung). Le code
	 * d'accès et le code PIN des Pelagic i330R, ou la lecture d'une
	 * caractéristique (Cressi), demanderaient un écran : pas encore pris en charge. */
	if (request == DC_IOCTL_BLE_GET_NAME) {
		return js_name ((char *) data, size) < 0 ? DC_STATUS_UNSUPPORTED : DC_STATUS_SUCCESS;
	}
	return DC_STATUS_UNSUPPORTED;
}

static int
on_cancel (void *userdata)
{
	return js_cancelled ();
}

static void
on_log (dc_context_t *context, dc_loglevel_t loglevel, const char *file, unsigned int line, const char *function, const char *message, void *userdata)
{
	js_log (loglevel, message);
}

static void
on_event (dc_device_t *device, dc_event_type_t event, const void *data, void *userdata)
{
	if (event == DC_EVENT_DEVINFO) {
		/* Comme Subsurface : le JavaScript retrouve par le numéro de série
		 * l'empreinte de la dernière plongée importée de cet appareil, et la
		 * lecture s'arrête à cette plongée. Les pilotes la lisent après cet
		 * événement (le Shearwater, en parcourant son manifeste). */
		const dc_event_devinfo_t *devinfo = (const dc_event_devinfo_t *) data;
		unsigned char fingerprint[64];
		int size = js_devinfo (devinfo->model, devinfo->firmware, devinfo->serial, fingerprint, sizeof (fingerprint));
		if (size > 0) dc_device_set_fingerprint (device, fingerprint, (unsigned int) size);
	} else if (event == DC_EVENT_PROGRESS) {
		const dc_event_progress_t *progress = (const dc_event_progress_t *) data;
		js_progress (progress->current, progress->maximum);
	}
}

static void
on_sample (dc_sample_type_t type, const dc_sample_value_t *value, void *userdata)
{
	switch (type) {
	case DC_SAMPLE_TIME:
		js_sample (type, value->time, 0);
		break;
	case DC_SAMPLE_DEPTH:
		js_sample (type, value->depth, 0);
		break;
	case DC_SAMPLE_TEMPERATURE:
		js_sample (type, value->temperature, 0);
		break;
	case DC_SAMPLE_PRESSURE:
		js_sample (type, value->pressure.tank, value->pressure.value);
		break;
	case DC_SAMPLE_DECO:
		js_sample (type, value->deco.type, value->deco.time);
		break;
	default:
		break;
	}
}

/* La suite est décidée par le JavaScript (diveEnd) : continuer, ou s'arrêter
 * après cette plongée. */
static int
on_dive (const unsigned char *data, unsigned int size, const unsigned char *fingerprint, unsigned int fsize, void *userdata)
{
	dc_device_t *device = (dc_device_t *) userdata;
	js_dive_raw (data, size, fingerprint, fsize);

	dc_parser_t *parser = NULL;
	dc_status_t status = dc_parser_new (&parser, device, data, size);
	if (status == DC_STATUS_SUCCESS) {
		dc_datetime_t dt = {0};
		unsigned int divetime = 0, ngasmixes = 0;
		double maxdepth = 0, tmin = 0;
		dc_divemode_t divemode = DC_DIVEMODE_OC;
		dc_gasmix_t gasmix = {0};
		status = dc_parser_get_datetime (parser, &dt);
		if (status == DC_STATUS_SUCCESS) status = dc_parser_get_field (parser, DC_FIELD_DIVETIME, 0, &divetime);
		if (status == DC_STATUS_SUCCESS) status = dc_parser_get_field (parser, DC_FIELD_MAXDEPTH, 0, &maxdepth);
		dc_parser_get_field (parser, DC_FIELD_DIVEMODE, 0, &divemode);
		if (dc_parser_get_field (parser, DC_FIELD_GASMIX_COUNT, 0, &ngasmixes) == DC_STATUS_SUCCESS && ngasmixes > 0) {
			dc_parser_get_field (parser, DC_FIELD_GASMIX, 0, &gasmix);
		}
		int has_tmin = dc_parser_get_field (parser, DC_FIELD_TEMPERATURE_MINIMUM, 0, &tmin) == DC_STATUS_SUCCESS;
		js_dive_header (status, dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, dt.timezone,
			divetime, maxdepth, divemode, ngasmixes, gasmix.oxygen, gasmix.helium, has_tmin, tmin);
		if (status == DC_STATUS_SUCCESS) status = dc_parser_samples_foreach (parser, on_sample, NULL);
		dc_parser_destroy (parser);
	}
	return js_dive_end (status);
}

static const dc_descriptor_t *
find_descriptor (const char *vendor, const char *product)
{
	dc_iterator_t *iterator = NULL;
	dc_descriptor_t *descriptor = NULL, *found = NULL;
	if (dc_descriptor_iterator_new (&iterator, NULL) != DC_STATUS_SUCCESS) return NULL;
	while (dc_iterator_next (iterator, &descriptor) == DC_STATUS_SUCCESS) {
		if (!found && strcmp (dc_descriptor_get_vendor (descriptor), vendor) == 0 &&
			strcmp (dc_descriptor_get_product (descriptor), product) == 0) {
			found = descriptor;
		} else {
			dc_descriptor_free (descriptor);
		}
	}
	dc_iterator_free (iterator);
	return found;
}

EMSCRIPTEN_KEEPALIVE const char *
dl_version (void)
{
	return dc_version (NULL);
}

/* Les modèles que libdivecomputer sait lire en Bluetooth basse consommation,
 * et, si `name` n'est pas vide, seulement ceux que ce nom Bluetooth désigne
 * (dc_descriptor_filter, la règle qu'appliquent Subsurface et les autres). */
EMSCRIPTEN_KEEPALIVE int
dl_list_ble (const char *name)
{
	dc_iterator_t *iterator = NULL;
	dc_descriptor_t *descriptor = NULL;
	int count = 0;
	if (dc_descriptor_iterator_new (&iterator, NULL) != DC_STATUS_SUCCESS) return -1;
	while (dc_iterator_next (iterator, &descriptor) == DC_STATUS_SUCCESS) {
		if (dc_descriptor_filter (descriptor, DC_TRANSPORT_BLE, name && name[0] ? name : NULL)) {
			js_descriptor (dc_descriptor_get_vendor (descriptor), dc_descriptor_get_product (descriptor),
				dc_descriptor_get_type (descriptor), dc_descriptor_get_model (descriptor),
				dc_descriptor_get_transports (descriptor));
			count++;
		}
		dc_descriptor_free (descriptor);
	}
	dc_iterator_free (iterator);
	return count;
}

/* Télécharge les plongées, les plus récentes d'abord, jusqu'à l'empreinte
 * donnée à DEVINFO, jusqu'à ce que diveEnd réponde « stop », ou jusqu'à
 * l'annulation (Module.divelog.cancelled). L'appareil est toujours refermé par
 * dc_device_close, qui envoie à un Shearwater la commande de fin de session
 * (2E 90 20 00) : il quitte alors le mode Bluetooth. Renvoie un dc_status_t. */
EMSCRIPTEN_KEEPALIVE int
dl_download (const char *vendor, const char *product, int loglevel)
{
	dc_context_t *context = NULL;
	dc_iostream_t *iostream = NULL;
	dc_device_t *device = NULL;
	dc_descriptor_t *descriptor = NULL;
	dc_status_t status = dc_context_new (&context);
	if (status != DC_STATUS_SUCCESS) return status;
	dc_context_set_loglevel (context, (dc_loglevel_t) loglevel);
	dc_context_set_logfunc (context, on_log, NULL);

	descriptor = (dc_descriptor_t *) find_descriptor (vendor, product);
	if (descriptor == NULL) {
		status = DC_STATUS_UNSUPPORTED;
		goto done;
	}

	static const dc_custom_cbs_t callbacks = {
		.set_timeout = io_set_timeout,
		.read = io_read,
		.write = io_write,
		.ioctl = io_ioctl,
		.purge = io_purge,
		.sleep = io_sleep,
	};
	status = dc_custom_open (&iostream, context, DC_TRANSPORT_BLE, &callbacks, NULL);
	if (status != DC_STATUS_SUCCESS) goto done;

	status = dc_device_open (&device, context, descriptor, iostream);
	if (status != DC_STATUS_SUCCESS) goto done;

	dc_device_set_cancel (device, on_cancel, NULL);
	dc_device_set_events (device, DC_EVENT_DEVINFO | DC_EVENT_PROGRESS, on_event, NULL);
	status = dc_device_foreach (device, on_dive, device);

	/* Sans dc_device_close, la structure de l'appareil resterait allouée.
	 * L'annulation est levée avant l'envoi de la commande de fin. Un échec de
	 * cet envoi (liaison déjà perdue) ne change rien aux plongées lues : seul
	 * compte le statut de la lecture. */
	dc_device_close (device);

done:
	dc_iostream_close (iostream);
	dc_descriptor_free (descriptor);
	dc_context_free (context);
	return status;
}
