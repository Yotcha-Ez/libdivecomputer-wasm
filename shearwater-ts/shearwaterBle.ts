/// <reference types="web-bluetooth" />
/**
 * Client Web Bluetooth pour les ordinateurs de plongee Shearwater.
 *
 * Protocole reconstruit a partir des sources de libdivecomputer
 * (src/shearwater_common.c, src/shearwater_petrel.c, licence LGPL 2.1,
 * https://github.com/libdivecomputer/libdivecomputer) et valide le
 * 2026-09-15 contre un Shearwater Peregrine TX reel.
 *
 * Tous les Shearwater en Bluetooth basse consommation parlent le protocole
 * "V1" (valide sur le Peregrine TX, modele 13) : chaque trame SLIP envoyee en
 * BLE est precedee d'un en-tete de 2 octets [nframes, idx] decoupant le flux
 * en paquets de 20 octets, et la requete porte sa longueur sur un octet.
 * Seul le Perdix 3 (modele 14) parle "V2" : pas d'en-tete Bluetooth, longueur
 * sur 2 octets, paquets jusqu'a 4096 octets. V2 n'a jamais ete essaye sur un
 * vrai Perdix 3 : il suit shearwater_common.c, verifie par des tests sur des
 * trames seulement.
 */

export const SHEARWATER_SERVICE = "fe25c237-0ece-443c-b0aa-e02033e7029d";
const CHARACTERISTIC = "27b7570b-359e-45a3-91bb-cf7e70049bd2";

const END = 0xc0;
const ESC = 0xdb;
const ESC_END = 0xdc;
const ESC_ESC = 0xdd;

const BLE_MTU_MIN = 20;

export type ShearwaterProtocol = "v1" | "v2";

export const ID_SERIAL = 0x8010;
export const ID_FIRMWARE = 0x8011;
export const ID_LOGUPLOAD = 0x8021;
export const ID_MODEL = 0x8060;

const RDBI_REQUEST = 0x22;
const RDBI_RESPONSE = 0x62;
const NAK = 0x7f;

const UPLOAD_INIT_REQUEST = 0x35;
const UPLOAD_INIT_RESPONSE = 0x75;
const UPLOAD_DATA_REQUEST = 0x36;
const UPLOAD_DATA_RESPONSE = 0x76;
const UPLOAD_EXIT_REQUEST = 0x37;
const UPLOAD_EXIT_RESPONSE = 0x77;

export const MANIFEST_ADDR = 0xe0000000;
export const MANIFEST_SIZE = 0x600;
const RECORD_SIZE = 0x20;
const RECORD_COUNT = MANIFEST_SIZE / RECORD_SIZE;

/** Une plongee peut occuper jusqu'a ce nombre d'octets une fois decompressee. */
export const DIVE_SIZE = 0xffffff;

/**
 * Port du switch de shearwater_petrel_device_foreach : la reponse ID_LOGUPLOAD
 * donne l'adresse de base du format de journal utilise par l'appareil.
 */
export function resolveBaseAddress(logupload: Uint8Array): number {
  const raw =
    ((logupload[1] << 24) | (logupload[2] << 16) | (logupload[3] << 8) | logupload[4]) >>> 0;
  switch (raw) {
    case 0xdd000000: // Predator
    case 0xc0000000: // format "Predator-like" (ancien Petrel)
    case 0x90000000: // ancienne variante du format PNF, sans enregistrement final
      return 0xc0000000;
    case 0x80000000: // Petrel Native Format avec enregistrement final
      return raw;
    default:
      throw new Error(`Format de journal inconnu: ${raw.toString(16)}`);
  }
}

export interface ManifestEntry {
  fingerprint: Uint8Array;
  address: number;
}

const EARLIEST_START_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Heure de debut d'une plongee, lue dans son empreinte du manifeste, sans rien
 * telecharger. libdivecomputer compare cette empreinte (octets 4 a 7 de
 * l'enregistrement) a celle qu'il rend pour chaque plongee telechargee, les
 * octets 12 a 15 de la plongee, c'est-a-dire l'horodatage de l'ouverture n°0
 * (shearwater_petrel_device_foreach) : les deux sont le meme horodatage.
 * Comme `parseDive`, l'heure murale de l'appareil est lue comme de l'UTC.
 * Une empreinte nulle ou absurde (avant 2000, apres demain) ne donne pas de date.
 */
export function manifestStartTime(fingerprint: Uint8Array, now = Date.now()): Date | null {
  if (fingerprint.length !== 4) return null;
  const seconds = ((fingerprint[0] << 24) | (fingerprint[1] << 16) | (fingerprint[2] << 8) | fingerprint[3]) >>> 0;
  const ms = seconds * 1000;
  if (ms < EARLIEST_START_MS || ms > now + DAY_MS) return null;
  return new Date(ms);
}

/** Port de shearwater_common_decompress_lre. Renvoie true si la fin du flux compresse a ete atteinte. */
function decompressLre(data: Uint8Array, out: number[]): boolean {
  const nbits = data.length * 8;
  if (nbits % 9 !== 0) throw new Error("Taille RLE invalide.");

  let offset = 0;
  while (offset + 9 <= nbits) {
    const byteIndex = offset >> 3;
    const bit = offset % 8;
    const shift = 16 - (bit + 9);
    const word = ((data[byteIndex] ?? 0) << 8) | (data[byteIndex + 1] ?? 0);
    const value = (word >> shift) & 0x1ff;

    if (value & 0x100) {
      out.push(value & 0xff);
    } else if (value === 0) {
      return true;
    } else {
      for (let i = 0; i < value; i++) out.push(0);
    }

    offset += 9;
  }

  return false;
}

/** Port de shearwater_common_decompress_xor (en place). */
function decompressXor(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  for (let i = 32; i < data.length; i++) data[i] ^= data[i - 32];
  return data;
}

export interface ShearwaterHandshake {
  serialHex: string;
  firmware: string;
  model: number;
  logupload: Uint8Array;
}

// Numeros de shearwater_common.h, noms de descriptor.c. Tern et Tern TX
// partagent le 12. Le 3 vaut pour le Petrel 1 et le Petrel 2, mais seul le
// Petrel 2 parle le BLE : le Petrel 1, le Predator et le NERD n'ont que le
// Bluetooth classique, hors de portee de Web Bluetooth.
const MODEL_NAMES: Record<number, string> = {
  2: "Predator",
  3: "Petrel 2",
  4: "NERD",
  5: "Perdix",
  6: "Perdix AI",
  7: "NERD 2",
  8: "Teric",
  9: "Peregrine",
  10: "Petrel 3",
  11: "Perdix 2",
  12: "Tern",
  13: "Peregrine TX",
  14: "Perdix 3",
};

export function shearwaterModelName(model: number): string | null {
  return MODEL_NAMES[model] ?? null;
}

/**
 * Le protocole doit etre choisi avant le premier echange. libdivecomputer le
 * deduit du modele choisi par l'utilisateur ; ici, du nom Bluetooth annonce par
 * l'appareil, que libdivecomputer compare au nom exact « Perdix 3 »
 * (dc_filter_shearwater). On tolere la casse, les espaces et un suffixe.
 */
export function protocolForDeviceName(name: string | undefined): ShearwaterProtocol {
  return name && /^perdix\s*3(?!\d)/i.test(name.trim()) ? "v2" : "v1";
}

/** En-tete de requete de shearwater_common_transfer :
 *  V1 `FF 01 [len+1] 00`, V2 `FF 01 00 [len_hi] [len_lo]`. */
export function encodeRequest(payload: Uint8Array, protocol: ShearwaterProtocol): Uint8Array {
  const header =
    protocol === "v2"
      ? [0xff, 0x01, 0x00, (payload.length >> 8) & 0xff, payload.length & 0xff]
      : [0xff, 0x01, (payload.length + 1) & 0xff, 0x00];
  const request = new Uint8Array(header.length + payload.length);
  request.set(header);
  request.set(payload, header.length);
  return request;
}

/** Controle d'en-tete et de longueur de la reponse, puis sa charge utile. */
export function decodeResponse(packet: Uint8Array, protocol: ShearwaterProtocol): Uint8Array {
  const headerLength = protocol === "v2" ? 5 : 4;
  const zeroIndex = protocol === "v2" ? 2 : 3;
  if (packet.length < headerLength || packet[0] !== 0x01 || packet[1] !== 0xff || packet[zeroIndex] !== 0x00) {
    throw new Error(`En-tete de paquet invalide: ${toHex(packet)}`);
  }

  let length: number;
  if (protocol === "v2") {
    length = (packet[3] << 8) | packet[4];
  } else {
    length = packet[2];
    if (length < 1) throw new Error(`En-tete de paquet invalide: ${toHex(packet)}`);
    length -= 1;
  }

  if (length + headerLength !== packet.length) {
    throw new Error(`Longueur de paquet invalide: attendu ${length}, recu ${packet.length - headerLength}`);
  }

  return packet.slice(headerLength);
}

/** Aucune reponse dans le delai : seul echec qui fasse essayer l'autre protocole. */
export class ShearwaterTimeoutError extends Error {
  constructor() {
    super("Delai depasse en attendant la reponse.");
    this.name = "ShearwaterTimeoutError";
  }
}

/** Port de shearwater_common_slip_write : ecritures de 20 octets, precedees en
 *  V1 seulement de l'en-tete [nframes, idx]. */
// Uint8Array.from() is typed as Uint8Array<ArrayBufferLike>, but
// writeValueWithoutResponse requires the narrower Uint8Array<ArrayBuffer>.
// A plain number[] source always backs onto a real ArrayBuffer, never a
// SharedArrayBuffer, so this cast is safe.
function bytes(values: number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(values) as Uint8Array<ArrayBuffer>;
}

export function buildBleWriteFrames(payload: Uint8Array, protocol: ShearwaterProtocol, mtu = BLE_MTU_MIN): Uint8Array<ArrayBuffer>[] {
  let count = 1;
  for (const c of payload) count += c === END || c === ESC ? 2 : 1;
  const nframes = Math.ceil(count / mtu);

  const frames: Uint8Array<ArrayBuffer>[] = [];
  let frameIndex = 0;
  const header = () => (protocol === "v1" ? [nframes & 0xff, frameIndex & 0xff] : []);
  let buf: number[] = header();

  function flush() {
    frames.push(bytes(buf));
    frameIndex++;
    buf = header();
  }

  for (const c of payload) {
    if (c === END || c === ESC) {
      buf.push(ESC);
      if (buf.length >= mtu) flush();
      buf.push(c === END ? ESC_END : ESC_ESC);
    } else {
      buf.push(c);
    }
    if (buf.length >= mtu) flush();
  }

  buf.push(END);
  frames.push(bytes(buf));
  return frames;
}

/** Port de shearwater_common_slip_read, cote reception (notifications). */
export class SlipReassembler {
  private data: number[] = [];
  private escaped = false;

  constructor(private readonly protocol: ShearwaterProtocol) {}

  /** Renvoie un paquet complet des qu'un octet END non echappe le termine. */
  feed(notification: DataView): Uint8Array | null {
    // En V1, les notifications portent le meme en-tete 2 octets [nframes, idx].
    for (let i = this.protocol === "v1" ? 2 : 0; i < notification.byteLength; i++) {
      const c = notification.getUint8(i);

      if (c === END || c === ESC) {
        if (this.escaped) {
          throw new Error(`SLIP frame escaped the special character ${c.toString(16)}`);
        }
        if (c === END) {
          if (this.data.length) {
            const packet = Uint8Array.from(this.data);
            this.data = [];
            return packet;
          }
          // trame vide (bruit de ligne) : on ignore
        } else {
          this.escaped = true;
        }
        continue;
      }

      let value = c;
      if (this.escaped) {
        if (value === ESC_END) value = END;
        else if (value === ESC_ESC) value = ESC;
        this.escaped = false;
      }
      this.data.push(value);
    }
    return null;
  }
}

export class ShearwaterBleClient {
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private protocol: ShearwaterProtocol = "v1";
  private reassembler = new SlipReassembler("v1");
  private pending: { resolve: (packet: Uint8Array) => void; reject: (err: Error) => void } | null = null;

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  async connect(): Promise<void> {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SHEARWATER_SERVICE] }],
    });

    const server = await this.device.gatt?.connect();
    if (!server) throw new Error("Connexion GATT impossible.");

    const service = await server.getPrimaryService(SHEARWATER_SERVICE);
    this.characteristic = await service.getCharacteristic(CHARACTERISTIC);

    await this.characteristic.startNotifications();
    this.characteristic.addEventListener("characteristicvaluechanged", this.onNotify);
    this.useProtocol(protocolForDeviceName(this.device.name));
  }

  private useProtocol(protocol: ShearwaterProtocol) {
    this.protocol = protocol;
    this.reassembler = new SlipReassembler(protocol);
    this.pending = null;
  }

  disconnect(): void {
    this.characteristic?.removeEventListener("characteristicvaluechanged", this.onNotify);
    this.device?.gatt?.disconnect();
    this.characteristic = null;
    this.device = null;
  }

  private onNotify = (event: Event) => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    const value = characteristic.value;
    if (!value) return;

    try {
      const packet = this.reassembler.feed(value);
      if (packet && this.pending) {
        this.pending.resolve(packet);
        this.pending = null;
      }
    } catch (err) {
      if (this.pending) {
        this.pending.reject(err instanceof Error ? err : new Error(String(err)));
        this.pending = null;
      }
    }
  };

  /** Port de shearwater_common_transfer. */
  private async transfer(payload: Uint8Array, timeoutMs = 5000): Promise<Uint8Array> {
    if (!this.characteristic) throw new Error("Non connecte.");

    const protocol = this.protocol;
    const packetPromise = new Promise<Uint8Array>((resolve, reject) => {
      this.pending = { resolve, reject };
    });

    for (const frame of buildBleWriteFrames(encodeRequest(payload, protocol), protocol)) {
      await this.characteristic.writeValueWithoutResponse(frame);
    }

    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new ShearwaterTimeoutError()), timeoutMs));
    const packet = await Promise.race([packetPromise, timeout]);
    return decodeResponse(packet, protocol);
  }

  /** Read Data By Identifier - lit un champ du firmware. */
  async rdbi(identifier: number, timeoutMs = 5000): Promise<Uint8Array> {
    const request = Uint8Array.from([RDBI_REQUEST, (identifier >> 8) & 0xff, identifier & 0xff]);
    const response = await this.transfer(request, timeoutMs);

    if (
      response.length < 3 ||
      response[0] !== RDBI_RESPONSE ||
      response[1] !== request[1] ||
      response[2] !== request[2]
    ) {
      if (response.length === 3 && response[0] === NAK && response[1] === RDBI_REQUEST) {
        throw new Error(`NAK recu, code erreur ${response[2].toString(16)}`);
      }
      throw new Error(`Reponse RDBI inattendue: ${toHex(response)}`);
    }

    return response.slice(3);
  }

  /** Handshake minimal (serie, firmware, modele) pour valider la connexion.
   *  Si le tout premier echange reste sans reponse, l'autre protocole est
   *  essaye une fois : un Perdix 3 au nom inattendu repondrait ainsi en V2.
   *  Un appareil qui repond, meme par une erreur, garde son protocole : le
   *  Peregrine TX ne recoit de trame V2 que s'il reste muet au premier echange,
   *  cas ou la connexion echouait deja. */
  async handshake(): Promise<ShearwaterHandshake> {
    let serial: Uint8Array;
    try {
      serial = await this.rdbi(ID_SERIAL);
    } catch (err) {
      if (!(err instanceof ShearwaterTimeoutError)) throw err;
      this.useProtocol(this.protocol === "v1" ? "v2" : "v1");
      serial = await this.rdbi(ID_SERIAL);
    }
    const firmware = await this.rdbi(ID_FIRMWARE);
    const model = await this.rdbi(ID_MODEL);
    const logupload = await this.rdbi(ID_LOGUPLOAD);

    return {
      serialHex: new TextDecoder().decode(serial),
      firmware: new TextDecoder().decode(firmware),
      model: model[0] ?? 0,
      logupload,
    };
  }

  /** Port de shearwater_common_download. */
  async download(address: number, size: number, compression: 0 | 1, timeoutMs = 10000): Promise<Uint8Array> {
    const reqInit = Uint8Array.from([
      UPLOAD_INIT_REQUEST,
      compression ? 0x10 : 0x00,
      0x34,
      (address >>> 24) & 0xff,
      (address >>> 16) & 0xff,
      (address >>> 8) & 0xff,
      address & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 8) & 0xff,
      size & 0xff,
    ]);

    const initResponse = await this.transfer(reqInit, timeoutMs);
    if (initResponse.length < 2 || initResponse[0] !== UPLOAD_INIT_RESPONSE) {
      throw new Error(`Reponse d'initialisation inattendue: ${toHex(initResponse)}`);
    }
    const lenFieldSize = (initResponse[1] & 0xf0) >> 4;
    if (initResponse.length < lenFieldSize + 2 || lenFieldSize > 4) {
      throw new Error(`Reponse d'initialisation inattendue: ${toHex(initResponse)}`);
    }

    const out: number[] = [];
    let done = false;
    let block = 1;
    let nbytes = 0;
    while (nbytes < size && !done) {
      // Le protocole V1 n'envoie que les 2 premiers octets de la requete de bloc.
      const reqBlock = Uint8Array.from(
        this.protocol === "v2" ? [UPLOAD_DATA_REQUEST, block & 0xff, 0x00] : [UPLOAD_DATA_REQUEST, block & 0xff]
      );
      const response = await this.transfer(reqBlock, timeoutMs);

      if (response.length < 2 || response[0] !== UPLOAD_DATA_RESPONSE || response[1] !== (block & 0xff)) {
        throw new Error(`Reponse de bloc inattendue: ${toHex(response)}`);
      }

      const payload = response.slice(2);
      if (nbytes + payload.length > size) {
        throw new Error("Taille de paquet inattendue.");
      }

      if (compression) {
        done = decompressLre(payload, out);
      } else {
        for (const b of payload) out.push(b);
      }

      nbytes += payload.length;
      block++;
    }

    let result = Uint8Array.from(out);
    if (compression) result = decompressXor(result);

    const reqQuit = Uint8Array.from([UPLOAD_EXIT_REQUEST]);
    const quitResponse = await this.transfer(reqQuit, timeoutMs);
    if (quitResponse.length !== 2 || quitResponse[0] !== UPLOAD_EXIT_RESPONSE || quitResponse[1] !== 0x00) {
      throw new Error(`Reponse de fin inattendue: ${toHex(quitResponse)}`);
    }

    return result;
  }

  /**
   * Port de la boucle manifest de shearwater_petrel_device_foreach.
   * `fingerprint` (4 octets, l'horodatage de debut, voir `manifestStartTime`)
   * permet de s'arreter aux plongees deja importees ; une empreinte nulle
   * telecharge tout le manifest.
   */
  async readManifest(fingerprint: Uint8Array = new Uint8Array(4)): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = [];

    while (true) {
      const data = await this.download(MANIFEST_ADDR, MANIFEST_SIZE, 0);

      let count = 0;
      let deleted = 0;
      let offset = 0;
      while (offset < data.length) {
        const header = (data[offset] << 8) | data[offset + 1];
        if (header === 0x5a23) {
          // plongee supprimee : on continue a chercher
          offset += RECORD_SIZE;
          deleted++;
          continue;
        }
        if (header !== 0xa5c4) break;

        const entryFingerprint = data.slice(offset + 4, offset + 8);
        if (entryFingerprint.every((b, i) => b === fingerprint[i])) break;

        const address =
          (((data[offset + 20] << 24) |
            (data[offset + 21] << 16) |
            (data[offset + 22] << 8) |
            data[offset + 23]) >>>
            0);
        entries.push({ fingerprint: entryFingerprint, address });

        offset += RECORD_SIZE;
        count++;
      }

      if (count + deleted !== RECORD_COUNT) break;
    }

    return entries;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
