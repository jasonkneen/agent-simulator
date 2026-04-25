import { describe, expect, test } from "bun:test";
import {
  codecFromAvcC,
  makeFmp4Fragment,
  makeFmp4InitSegment,
  parseSimstreamMessage,
} from "./simstream-protocol";

const avcC = new Uint8Array([
  0x01, 0x64, 0x00, 0x33, 0xff, 0xe1, 0x00, 0x04,
  0x67, 0x64, 0x00, 0x33, 0x01, 0x00, 0x02, 0x68, 0xee,
]);

function configMessage(width: number, height: number) {
  const msg = new Uint8Array(1 + 4 + 4 + avcC.length);
  msg[0] = 1;
  new DataView(msg.buffer).setUint32(1, width, true);
  new DataView(msg.buffer).setUint32(5, height, true);
  msg.set(avcC, 9);
  return msg;
}

function frameMessage(type: 2 | 3, ptsUs: bigint, sample: Uint8Array) {
  const msg = new Uint8Array(1 + 8 + sample.length);
  const view = new DataView(msg.buffer);
  msg[0] = type;
  view.setBigUint64(1, ptsUs, true);
  msg.set(sample, 9);
  return msg;
}

describe("Komand simstream protocol", () => {
  test("parses config messages as width/height plus avcC", () => {
    const parsed = parseSimstreamMessage(configMessage(1206, 2622));
    expect(parsed.type).toBe("config");
    if (parsed.type !== "config") throw new Error("wrong type");
    expect(parsed.width).toBe(1206);
    expect(parsed.height).toBe(2622);
    expect(Array.from(parsed.avcC.slice(0, 4))).toEqual([1, 0x64, 0, 0x33]);
    expect(codecFromAvcC(parsed.avcC)).toBe("avc1.640033");
  });

  test("parses key and delta frames as ptsUs plus length-prefixed AVC samples", () => {
    const sample = new Uint8Array([0, 0, 0, 3, 0x65, 0xaa, 0xbb]);
    const parsed = parseSimstreamMessage(frameMessage(2, 123456789n, sample));
    expect(parsed.type).toBe("frame");
    if (parsed.type !== "frame") throw new Error("wrong type");
    expect(parsed.isKeyframe).toBe(true);
    expect(parsed.ptsUs).toBe(123456789n);
    expect(Array.from(parsed.sample)).toEqual(Array.from(sample));
  });

  test("emits playable fMP4 init and media fragments", () => {
    const init = makeFmp4InitSegment({ width: 1206, height: 2622, avcC });
    expect(new TextDecoder().decode(init.slice(4, 8))).toBe("ftyp");
    const ftypSize = new DataView(init.buffer, init.byteOffset, init.byteLength).getUint32(0, false);
    expect(new TextDecoder().decode(init.slice(ftypSize + 4, ftypSize + 8))).toBe("moov");

    const sample = new Uint8Array([0, 0, 0, 3, 0x65, 0xaa, 0xbb]);
    const frag = makeFmp4Fragment({ sequenceNumber: 1, baseMediaDecodeTime: 123456n, duration: 16667, sample, isKeyframe: true });
    expect(new TextDecoder().decode(frag.slice(4, 8))).toBe("moof");
    const mdatOffset = frag.findIndex((_, i) => i > 8 && new TextDecoder().decode(frag.slice(i, i + 4)) === "mdat") - 4;
    expect(mdatOffset).toBeGreaterThan(0);
    expect(frag.byteLength).toBeGreaterThan(sample.byteLength + 16);
  });
});
