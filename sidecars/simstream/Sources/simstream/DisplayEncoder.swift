import Foundation
import CoreMedia
import CoreVideo
import IOSurface
import VideoToolbox

final class DisplayEncoder {
  struct EncodedFrame {
    let isKeyframe: Bool
    let ptsUs: UInt64
    let sample: Data
  }

  var onConfig: ((Int, Int, Data) -> Void)?
  var onFrame: ((EncodedFrame) -> Void)?

  private let queue = DispatchQueue(label: "simstream.encoder")
  private let fps: Int
  private var session: VTCompressionSession?
  private var width = 0
  private var height = 0
  private var startUs: UInt64?
  private var lastAvcC: Data?

  init(fps: Int) {
    self.fps = max(1, min(120, fps))
  }

  func encode(surface: IOSurface) {
    queue.async { [weak self] in
      self?.encodeOnQueue(surface: surface)
    }
  }

  func stop() {
    queue.sync {
      if let session {
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
      }
      session = nil
    }
  }

  private func encodeOnQueue(surface: IOSurface) {
    let nextWidth = IOSurfaceGetWidth(surface)
    let nextHeight = IOSurfaceGetHeight(surface)
    guard nextWidth > 0, nextHeight > 0 else { return }

    if session == nil || width != nextWidth || height != nextHeight {
      resetSession(width: nextWidth, height: nextHeight)
    }
    guard let session else { return }

    var unmanagedPixelBuffer: Unmanaged<CVPixelBuffer>?
    let attrs: CFDictionary = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary
    let pixelStatus = CVPixelBufferCreateWithIOSurface(
      kCFAllocatorDefault,
      surface,
      attrs,
      &unmanagedPixelBuffer
    )
    guard pixelStatus == kCVReturnSuccess, let pixelBuffer = unmanagedPixelBuffer?.takeRetainedValue() else {
      fputs("[simstream] CVPixelBufferCreateWithIOSurface failed: \(pixelStatus)\n", stderr)
      return
    }

    let nowUs = DispatchTime.now().uptimeNanoseconds / 1_000
    if startUs == nil { startUs = nowUs }
    let ptsUs = UInt64(nowUs - (startUs ?? nowUs))
    let pts = CMTime(value: CMTimeValue(ptsUs), timescale: 1_000_000)
    let duration = CMTime(value: CMTimeValue(max(1, 1_000_000 / fps)), timescale: 1_000_000)

    var flags = VTEncodeInfoFlags()
    let status = VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: pts,
      duration: duration,
      frameProperties: nil,
      sourceFrameRefcon: nil,
      infoFlagsOut: &flags
    )
    if status != noErr {
      fputs("[simstream] VTCompressionSessionEncodeFrame failed: \(status)\n", stderr)
    }
  }

  private func resetSession(width: Int, height: Int) {
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }

    self.width = width
    self.height = height
    self.lastAvcC = nil
    self.startUs = nil

    var newSession: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: compressionCallback,
      refcon: Unmanaged.passUnretained(self).toOpaque(),
      compressionSessionOut: &newSession
    )
    guard status == noErr, let newSession else {
      fputs("[simstream] VTCompressionSessionCreate failed: \(status)\n", stderr)
      session = nil
      return
    }

    VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
    VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
    VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: max(1, fps) as CFNumber)
    VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_AverageBitRate, value: max(800_000, width * height * 6) as CFNumber)
    VTCompressionSessionPrepareToEncodeFrames(newSession)

    session = newSession
    fputs("[simstream] encoder ready \(width)x\(height) @ \(fps)fps\n", stderr)
  }

  fileprivate func handleEncoded(status: OSStatus, sampleBuffer: CMSampleBuffer?) {
    guard status == noErr, let sampleBuffer, CMSampleBufferDataIsReady(sampleBuffer) else {
      if status != noErr { fputs("[simstream] compression callback failed: \(status)\n", stderr) }
      return
    }

    let isKeyframe = sampleBuffer.isKeyframe
    if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer), let avcC = makeAvcC(formatDescription: format) {
      if avcC != lastAvcC {
        lastAvcC = avcC
        onConfig?(width, height, avcC)
      }
    }

    guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    let length = CMBlockBufferGetDataLength(dataBuffer)
    guard length > 0 else { return }

    var sample = Data(count: length)
    let copyStatus = sample.withUnsafeMutableBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferCopyDataBytes(dataBuffer, atOffset: 0, dataLength: length, destination: base)
    }
    guard copyStatus == noErr else {
      fputs("[simstream] CMBlockBufferCopyDataBytes failed: \(copyStatus)\n", stderr)
      return
    }

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let ptsUs = pts.isValid ? UInt64(max(0, pts.seconds * 1_000_000)) : 0
    onFrame?(EncodedFrame(isKeyframe: isKeyframe, ptsUs: ptsUs, sample: sample))
  }
}

private let compressionCallback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
  guard let refcon else { return }
  let encoder = Unmanaged<DisplayEncoder>.fromOpaque(refcon).takeUnretainedValue()
  encoder.handleEncoded(status: status, sampleBuffer: sampleBuffer)
}

private extension CMSampleBuffer {
  var isKeyframe: Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(self, createIfNecessary: false) as? [[CFString: Any]],
          let first = attachments.first else {
      return true
    }
    let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
    return !notSync
  }
}

private func makeAvcC(formatDescription: CMFormatDescription) -> Data? {
  var spsPointer: UnsafePointer<UInt8>?
  var spsSize = 0
  var parameterSetCount = 0
  var nalUnitHeaderLength: Int32 = 0
  let spsStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
    formatDescription,
    parameterSetIndex: 0,
    parameterSetPointerOut: &spsPointer,
    parameterSetSizeOut: &spsSize,
    parameterSetCountOut: &parameterSetCount,
    nalUnitHeaderLengthOut: &nalUnitHeaderLength
  )

  var ppsPointer: UnsafePointer<UInt8>?
  var ppsSize = 0
  let ppsStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
    formatDescription,
    parameterSetIndex: 1,
    parameterSetPointerOut: &ppsPointer,
    parameterSetSizeOut: &ppsSize,
    parameterSetCountOut: nil,
    nalUnitHeaderLengthOut: nil
  )

  guard spsStatus == noErr, ppsStatus == noErr,
        let spsPointer, let ppsPointer,
        spsSize >= 4, ppsSize > 0 else {
    return nil
  }

  let sps = UnsafeBufferPointer(start: spsPointer, count: spsSize)
  let pps = UnsafeBufferPointer(start: ppsPointer, count: ppsSize)

  var out = Data()
  out.append(0x01)
  out.append(sps[1])
  out.append(sps[2])
  out.append(sps[3])
  out.append(0xff) // reserved + 4-byte NAL length size
  out.append(0xe1) // reserved + 1 SPS
  out.appendUInt16BE(UInt16(spsSize))
  out.append(contentsOf: sps)
  out.append(0x01) // 1 PPS
  out.appendUInt16BE(UInt16(ppsSize))
  out.append(contentsOf: pps)
  return out
}
