import Foundation

func packConfigMessage(width: Int, height: Int, avcC: Data) -> Data {
  var data = Data()
  data.append(1)
  data.appendUInt32LE(UInt32(width))
  data.appendUInt32LE(UInt32(height))
  data.append(avcC)
  return data
}

func packFrameMessage(isKeyframe: Bool, ptsUs: UInt64, sample: Data) -> Data {
  var data = Data(capacity: 1 + 8 + sample.count)
  data.append(isKeyframe ? 2 : 3)
  data.appendUInt64LE(ptsUs)
  data.append(sample)
  return data
}

extension Data {
  mutating func appendUInt16BE(_ value: UInt16) {
    append(UInt8((value >> 8) & 0xff))
    append(UInt8(value & 0xff))
  }

  mutating func appendUInt32LE(_ value: UInt32) {
    append(UInt8(value & 0xff))
    append(UInt8((value >> 8) & 0xff))
    append(UInt8((value >> 16) & 0xff))
    append(UInt8((value >> 24) & 0xff))
  }

  mutating func appendUInt64LE(_ value: UInt64) {
    append(UInt8(value & 0xff))
    append(UInt8((value >> 8) & 0xff))
    append(UInt8((value >> 16) & 0xff))
    append(UInt8((value >> 24) & 0xff))
    append(UInt8((value >> 32) & 0xff))
    append(UInt8((value >> 40) & 0xff))
    append(UInt8((value >> 48) & 0xff))
    append(UInt8((value >> 56) & 0xff))
  }
}
