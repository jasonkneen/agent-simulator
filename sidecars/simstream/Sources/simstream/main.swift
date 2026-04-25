import Foundation
import IOSurface
import SimBridgeC
import Darwin

func usage() -> Never {
  fputs("usage: simstream <udid> [port] [fps]\n", stderr)
  exit(64)
}

let args = CommandLine.arguments
guard args.count >= 2 else { usage() }
let udid = args[1]
let port = args.count >= 3 ? (UInt16(args[2]) ?? 9999) : 9999
let fps = args.count >= 4 ? (Int(args[3]) ?? 60) : 60

autoreleasepool {
  var errorPtr: UnsafeMutablePointer<CChar>?
  guard SPBridgeStart(udid, &errorPtr) else {
    let message = errorPtr.map { String(cString: $0) } ?? "unknown CoreSimulator bridge error"
    if let errorPtr { SPBridgeFreeCString(errorPtr) }
    fputs("[simstream] \(message)\n", stderr)
    exit(1)
  }
}

let server: WebSocketServer
do {
  server = try WebSocketServer(port: port)
} catch {
  fputs("[simstream] failed to start WebSocket server: \(error)\n", stderr)
  SPBridgeStop()
  exit(1)
}

let encoder = DisplayEncoder(fps: fps)
encoder.onConfig = { width, height, avcC in
  server.broadcast(packConfigMessage(width: width, height: height, avcC: avcC))
}
encoder.onFrame = { frame in
  server.broadcast(packFrameMessage(isKeyframe: frame.isKeyframe, ptsUs: frame.ptsUs, sample: frame.sample))
}

server.start {
  print("stream_ready ws://127.0.0.1:\(port)")
  fflush(stdout)
  fputs("[simstream] ws listening on ws://127.0.0.1:\(port)\n", stderr)
}

let encodeQueue = DispatchQueue(label: "simstream.surface-poll")
let timer = DispatchSource.makeTimerSource(queue: encodeQueue)
let intervalUs = max(1_000, 1_000_000 / max(1, min(120, fps)))
timer.schedule(deadline: .now(), repeating: .microseconds(intervalUs), leeway: .microseconds(intervalUs / 3))
timer.setEventHandler {
  guard let surface = SPBridgeCopySurface() else { return }
  encoder.encode(surface: surface)
}
timer.resume()

func shutdown() {
  timer.cancel()
  encoder.stop()
  server.stop()
  SPBridgeStop()
  exit(0)
}

signal(SIGPIPE, SIG_IGN)
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigint.setEventHandler { shutdown() }
sigint.resume()
signal(SIGINT, SIG_IGN)

let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { shutdown() }
sigterm.resume()
signal(SIGTERM, SIG_IGN)

fputs("[simstream] subscribed; streaming until SIGINT/SIGTERM\n", stderr)
RunLoop.main.run()
