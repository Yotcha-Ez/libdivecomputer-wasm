/**
 * Parseur du format binaire "Petrel Native Format" (PNF) des ordinateurs
 * Shearwater.
 *
 * Reconstruit a partir de libdivecomputer (src/shearwater_predator_parser.c,
 * licence LGPL 2.1, https://github.com/libdivecomputer/libdivecomputer).
 *
 * Le format est une suite d'enregistrements de 32 octets (SZ_SAMPLE_PETREL).
 * Le premier octet donne le type : 0x10-0x19 = enregistrements d'ouverture,
 * 0x20-0x29 = enregistrements de fermeture, 0x01 = echantillon de plongee,
 * 0x02 = quatre echantillons d'apnee de 8 octets, 0x03 = echantillon du mode
 * Avelo (meme disposition que 0x01, un seul emetteur de pression).
 * Contrairement aux imports de fichiers .db (où le BLOB de
 * profil proprietaire reste hors perimetre), les octets recus en Bluetooth
 * sont deja le format brut du protocole : on peut donc en extraire le profil
 * complet (profondeur/temperature/pression), pas seulement l'en-tete.
 */

const RECORD_SIZE = 0x20;

const TYPE_DIVE_SAMPLE = 0x01;
const TYPE_FREEDIVE_SAMPLE = 0x02;
const TYPE_AVELO_SAMPLE = 0x03;
const TYPE_OPENING_0 = 0x10;
const TYPE_OPENING_1 = 0x11;
const TYPE_OPENING_3 = 0x13;
const TYPE_OPENING_4 = 0x14;
const TYPE_OPENING_5 = 0x15;
const TYPE_CLOSING_0 = 0x20;

const UNITS_METRIC = 0;
const METERS_PER_FOOT = 0.3048;
const BAR_PER_PSI = 0.0689475729;

/** Intervalle par defaut, en millisecondes, si l'enregistrement d'ouverture n°5
 *  est absent (le champ lu sur l'appareil est aussi en millisecondes : 10000
 *  pour un intervalle reel de 10 secondes). */
const DEFAULT_INTERVAL_MS = 10000;

const FREEDIVE_SUBSAMPLE_SIZE = 8;
const MODE_FREEDIVE = 7;
// Valeurs par defaut de libdivecomputer (DEF_ATMOSPHERIC, DEF_DENSITY_SALT)
// quand l'ouverture n°1 ou n°3 manque.
const DEFAULT_ATMOSPHERIC_MBAR = 1013;
const DEFAULT_DENSITY = 1025;
const GRAVITY = 9.80665;

export interface DiveProfileSample {
  elapsedSeconds: number;
  depthM: number;
  temperatureC: number | null;
  pressureBar: number | null;
  /** Minutes avant la limite de décompression ; absente pendant un palier
   *  obligatoire, où la notion de NDL ne s'applique plus. */
  ndlSeconds: number | null;
}

export interface ParsedDive {
  startTime: Date;
  durationSeconds: number;
  maxDepthM: number;
  averageDepthM: number | null;
  waterTemperatureC: number | null;
  minimumTemperatureC: number | null;
  /** Premier mélange configuré ("Air", "Nx 32", "Tx 21/35"...). Simplification
   *  volontaire : ne reflète pas un changement de gaz en cours de plongée. */
  gasMix: string | null;
  profile: DiveProfileSample[];
}

function gasMixLabel(oxygen: number, helium: number): string | null {
  if (oxygen === 0) return null;
  if (helium > 0) return `Tx ${oxygen}/${helium}`;
  return oxygen === 21 ? "Air" : `Nx ${oxygen}`;
}

function uint16be(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function uint24be(data: Uint8Array, offset: number): number {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

function uint32be(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0
  );
}

export function parseDive(data: Uint8Array): ParsedDive {
  if (data.length < 2) throw new Error("Plongee vide ou tronquee.");

  const pnf = uint16be(data, 0) !== 0xffff ? 1 : 0;
  if (!pnf) {
    throw new Error("Format Predator-like (pre-PNF) non pris en charge.");
  }

  let opening0: number | null = null;
  let opening1: number | null = null;
  let opening3: number | null = null;
  let opening4: number | null = null;
  let opening5: number | null = null;
  let closing0: number | null = null;
  const sampleOffsets: number[] = [];

  for (let offset = 0; offset + RECORD_SIZE <= data.length; offset += RECORD_SIZE) {
    const record = data.subarray(offset, offset + RECORD_SIZE);
    if (record.every((b) => b === 0)) continue;

    const type = record[0];
    if (type === TYPE_OPENING_0) opening0 = offset;
    else if (type === TYPE_OPENING_1) opening1 = offset;
    else if (type === TYPE_OPENING_3) opening3 = offset;
    else if (type === TYPE_OPENING_4) opening4 = offset;
    else if (type === TYPE_OPENING_5) opening5 = offset;
    else if (type === TYPE_CLOSING_0) closing0 = offset;
    else if (type === TYPE_DIVE_SAMPLE || type === TYPE_FREEDIVE_SAMPLE || type === TYPE_AVELO_SAMPLE) {
      sampleOffsets.push(offset);
    }
  }

  if (opening0 === null || closing0 === null) {
    throw new Error("Enregistrement d'ouverture ou de fermeture introuvable.");
  }

  const units = data[opening0 + 8];
  // Heure murale de l'appareil, pour tous les modeles, Teric compris :
  // libdivecomputer la decode telle quelle (dc_datetime_gmtime, sans decalage)
  // et ne fait que signaler a cote, pour le Teric (journal >= 9), le fuseau de
  // l'ouverture n°5 (minutes a +26, heure d'ete a +30). L'ajouter decalerait
  // l'heure une seconde fois ; DiveLog ne stocke pas de fuseau.
  const timestamp = uint32be(data, opening0 + 12);
  const durationSeconds = uint24be(data, closing0 + 6);
  const rawMaxDepth = uint16be(data, closing0 + 4);
  const maxDepthM = units === UNITS_METRIC ? rawMaxDepth / 10 : (rawMaxDepth / 10) * METERS_PER_FOOT;

  // Intervalle entre echantillons : disponible a partir de la logversion 9
  // (enregistrement d'ouverture n°5) ; avant, 10 s, comme libdivecomputer.
  const logversion = opening4 !== null ? data[opening4 + 16] : 0;
  // L'apnee utilise le meme champ : c'est l'appareil qui y inscrit l'intervalle
  // du mode choisi.
  const intervalMs =
    logversion >= 9 && opening5 !== null ? uint16be(data, opening5 + 23) : DEFAULT_INTERVAL_MS;

  // Le mode de l'en-tete fait foi a partir du journal 8, comme dans
  // libdivecomputer ; avant, seule la presence de releves d'apnee le dit.
  const freedive =
    logversion >= 8 && opening4 !== null
      ? data[opening4 + 1] === MODE_FREEDIVE
      : sampleOffsets.some((offset) => data[offset] === TYPE_FREEDIVE_SAMPLE);
  const atmosphericMbar = opening1 !== null ? uint16be(data, opening1 + 16) : DEFAULT_ATMOSPHERIC_MBAR;
  const density = opening3 !== null ? uint16be(data, opening3 + 3) : DEFAULT_DENSITY;

  const profile: DiveProfileSample[] = [];
  let elapsedMs = 0;
  let depthSum = 0;
  let temperatureSum = 0;
  let minimumTemperatureC: number | null = null;

  // L'API attend des secondes entieres : un releve qui tomberait dans la meme
  // seconde que le precedent (apnee echantillonnee sous la seconde) est ecarte.
  function push(sample: Omit<DiveProfileSample, "elapsedSeconds">) {
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    if (profile.length && profile[profile.length - 1].elapsedSeconds === elapsedSeconds) return;
    profile.push({ elapsedSeconds, ...sample });
    depthSum += sample.depthM;
    if (sample.temperatureC !== null) {
      temperatureSum += sample.temperatureC;
      if (minimumTemperatureC === null || sample.temperatureC < minimumTemperatureC) minimumTemperatureC = sample.temperatureC;
    }
  }

  for (const offset of sampleOffsets) {
    if (data[offset] === TYPE_FREEDIVE_SAMPLE) {
      for (let i = 0; i < 4; i++) {
        const sub = offset + i * FREEDIVE_SUBSAMPLE_SIZE;
        if (data.subarray(sub, sub + FREEDIVE_SUBSAMPLE_SIZE).every((b) => b === 0)) break;
        elapsedMs += intervalMs;
        // Pression absolue en millibars (1 mbar = 100 Pa), quelles que soient
        // les unites de l'appareil ; l'API refuse une profondeur negative, qu'une
        // surface sous la pression de reference donnerait.
        const depthM = Math.max(0, ((uint16be(data, sub + 1) - atmosphericMbar) * 100) / (density * GRAVITY));
        const temperatureC = (((data[sub + 3] << 8) | data[sub + 4]) << 16 >> 16) / 10;
        push({ depthM, temperatureC, pressureBar: null, ndlSeconds: null });
      }
      continue;
    }

    elapsedMs += intervalMs;

    const rawDepth = uint16be(data, offset + pnf);
    const depthM = units === UNITS_METRIC ? rawDepth / 10 : (rawDepth / 10) * METERS_PER_FOOT;

    let rawTemperature = (data[offset + pnf + 13] << 24) >> 24; // octet signe
    if (rawTemperature < 0) {
      // Correction des temperatures negatives (encodage historique du firmware).
      rawTemperature += 102;
      if (rawTemperature > 0) rawTemperature = 0;
    }
    const temperatureC = units === UNITS_METRIC ? rawTemperature : ((rawTemperature - 32) * 5) / 9;

    // Premier emetteur seulement (octet 27), le seul en mode Avelo : un releve
    // DiveLog ne garde qu'une pression. Les autres seraient a l'octet 19
    // (deuxieme emetteur) et dans les enregistrements 0xE1, octets 0 a 3
    // (troisieme et quatrieme, journal >= 13). Comme libdivecomputer : pas de
    // pression avant le journal 7, et une valeur nulle n'est pas une mesure ;
    // un code >= 0xFFF0 signale un emetteur absent ou muet.
    const rawPressure = uint16be(data, offset + pnf + 27);
    const pressure = rawPressure & 0x0fff;
    const pressureBar = logversion >= 7 && rawPressure < 0xfff0 && pressure ? pressure * 2 * BAR_PER_PSI : null;

    // NDL / palier : un stop non nul signifie qu'on est deja en decompression
    // obligatoire, auquel cas la NDL ne s'applique plus.
    const decostop = uint16be(data, offset + pnf + 2);
    const ndlSeconds = decostop === 0 ? data[offset + pnf + 9] * 60 : null;

    push({ depthM, temperatureC, pressureBar, ndlSeconds });
  }

  // Premier melange fixe declare (indices 0..9 a partir de opening[0]+20 pour
  // l'oxygene, +30 pour l'helium) : suffisant pour le cas courant, un seul gaz.
  // Aucun en apnee, comme libdivecomputer.
  const gasMix = freedive ? null : gasMixLabel(data[opening0 + 20], data[opening0 + 30]);

  return {
    startTime: new Date(timestamp * 1000),
    durationSeconds,
    maxDepthM,
    averageDepthM: profile.length ? Math.round((depthSum / profile.length) * 100) / 100 : null,
    waterTemperatureC: profile.length ? Math.round((temperatureSum / profile.length) * 100) / 100 : null,
    minimumTemperatureC,
    gasMix,
    profile,
  };
}
