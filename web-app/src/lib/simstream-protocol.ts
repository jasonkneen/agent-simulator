export type SimstreamMessage =
  | { type: "config"; width: number; height: number; avcC: Uint8Array }
  | { type: "frame"; isKeyframe: boolean; ptsUs: bigint; sample: Uint8Array };

const TIMESCALE = 1_000_000;

export function parseSimstreamMessage(data: ArrayBuffer | Uint8Array): SimstreamMessage {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 1) throw new Error("empty simstream message");
  const kind = bytes[0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === 1) {
    if (bytes.byteLength < 10) throw new Error("short simstream config message");
    const width = view.getUint32(1, true);
    const height = view.getUint32(5, true);
    const avcC = bytes.slice(9);
    if (avcC.byteLength < 7) throw new Error("simstream config missing avcC payload");
    return { type: "config", width, height, avcC };
  }
  if (kind === 2 || kind === 3) {
    if (bytes.byteLength < 10) throw new Error("short simstream frame message");
    const ptsUs = view.getBigUint64(1, true);
    const sample = bytes.slice(9);
    if (sample.byteLength === 0) throw new Error("simstream frame missing sample payload");
    return { type: "frame", isKeyframe: kind === 2, ptsUs, sample };
  }
  throw new Error(`unknown simstream message type ${kind}`);
}

export function codecFromAvcC(avcC: Uint8Array): string {
  if (avcC.byteLength < 4 || avcC[0] !== 1) return "avc1.42e01e";
  return `avc1.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
}

export function makeFmp4InitSegment(config: {
  width: number;
  height: number;
  avcC: Uint8Array;
}): Uint8Array {
  const { width, height, avcC } = config;
  return concat(
    box(
      "ftyp",
      ascii("isom"),
      u32(0x00000200),
      ascii("isom"),
      ascii("iso6"),
      ascii("avc1"),
      ascii("mp41"),
    ),
    box(
      "moov",
      mvhd(),
      box(
        "trak",
        tkhd(width, height),
        box(
          "mdia",
          mdhd(),
          hdlr(),
          box(
            "minf",
            vmhd(),
            dinf(),
            box(
              "stbl",
              stsd(width, height, avcC),
              box("stts", fullHeader(0, 0), u32(0)),
              box("stsc", fullHeader(0, 0), u32(0)),
              box("stsz", fullHeader(0, 0), u32(0), u32(0)),
              box("stco", fullHeader(0, 0), u32(0)),
            ),
          ),
        ),
      ),
      box("mvex", trex()),
    ),
  );
}

export function makeFmp4Fragment(input: {
  sequenceNumber: number;
  baseMediaDecodeTime: bigint;
  duration: number;
  sample: Uint8Array;
  isKeyframe: boolean;
}): Uint8Array {
  const mdat = box("mdat", input.sample);
  const provisionalMoof = moof(input, 0);
  const finalMoof = moof(input, provisionalMoof.byteLength + 8);
  return concat(finalMoof, mdat);
}

function moof(
  input: {
    sequenceNumber: number;
    baseMediaDecodeTime: bigint;
    duration: number;
    sample: Uint8Array;
    isKeyframe: boolean;
  },
  dataOffset: number,
): Uint8Array {
  const sampleFlags = input.isKeyframe ? 0x02000000 : 0x01010000;
  return box(
    "moof",
    box("mfhd", fullHeader(0, 0), u32(input.sequenceNumber)),
    box(
      "traf",
      box("tfhd", fullHeader(0, 0x020000), u32(1)),
      box("tfdt", fullHeader(1, 0), u64(input.baseMediaDecodeTime)),
      box(
        "trun",
        fullHeader(0, 0x000001 | 0x000100 | 0x000200 | 0x000400),
        u32(1),
        i32(dataOffset),
        u32(input.duration),
        u32(input.sample.byteLength),
        u32(sampleFlags),
      ),
    ),
  );
}

function mvhd(): Uint8Array {
  return box(
    "mvhd",
    fullHeader(0, 0),
    u32(0), u32(0),
    u32(TIMESCALE),
    u32(0),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    u32(0), u32(0),
    matrix(),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(2),
  );
}

function tkhd(width: number, height: number): Uint8Array {
  return box(
    "tkhd",
    fullHeader(0, 0x000007),
    u32(0), u32(0),
    u32(1),
    u32(0),
    u32(0),
    u32(0), u32(0),
    u16(0), u16(0), u16(0), u16(0),
    matrix(),
    u32(width << 16),
    u32(height << 16),
  );
}

function mdhd(): Uint8Array {
  return box(
    "mdhd",
    fullHeader(0, 0),
    u32(0), u32(0),
    u32(TIMESCALE),
    u32(0),
    u16(0x55c4),
    u16(0),
  );
}

function hdlr(): Uint8Array {
  return box(
    "hdlr",
    fullHeader(0, 0),
    u32(0),
    ascii("vide"),
    u32(0), u32(0), u32(0),
    cstr("VideoHandler"),
  );
}

function vmhd(): Uint8Array {
  return box("vmhd", fullHeader(0, 1), u16(0), u16(0), u16(0), u16(0));
}

function dinf(): Uint8Array {
  return box("dinf", box("dref", fullHeader(0, 0), u32(1), box("url ", fullHeader(0, 1))));
}

function stsd(width: number, height: number, avcC: Uint8Array): Uint8Array {
  return box("stsd", fullHeader(0, 0), u32(1), avc1(width, height, avcC));
}

function avc1(width: number, height: number, avcC: Uint8Array): Uint8Array {
  return box(
    "avc1",
    zeros(6),
    u16(1),
    u16(0), u16(0),
    u32(0), u32(0), u32(0),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    compressorName("simstream"),
    u16(0x0018),
    u16(0xffff),
    box("avcC", avcC),
    box("btrt", u32(0), u32(0), u32(0)),
  );
}

function trex(): Uint8Array {
  return box("trex", fullHeader(0, 0), u32(1), u32(1), u32(0), u32(0), u32(0));
}

function matrix(): Uint8Array {
  return concat(
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  );
}

function compressorName(name: string): Uint8Array {
  const out = new Uint8Array(32);
  const encoded = new TextEncoder().encode(name).slice(0, 31);
  out[0] = encoded.length;
  out.set(encoded, 1);
  return out;
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const body = concat(...payloads);
  return concat(u32(body.byteLength + 8), ascii(type), body);
}

function fullHeader(version: number, flags: number): Uint8Array {
  return new Uint8Array([version & 0xff, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]);
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function cstr(s: string): Uint8Array {
  return concat(ascii(s), new Uint8Array([0]));
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

function u16(v: number): Uint8Array {
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}

function u32(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v >>> 0, false);
  return out;
}

function i32(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, v, false);
  return out;
}

function u64(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, false);
  return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function hex2(v: number): string {
  return v.toString(16).padStart(2, "0");
}
