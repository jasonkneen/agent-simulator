import Foundation
import Network

final class WebSocketServer {
  private let port: UInt16
  private let listener: NWListener
  private let queue = DispatchQueue(label: "simstream.websocket")
  private var clients: [UUID: NWConnection] = [:]
  private var latestConfig: Data?

  init(port: UInt16) throws {
    self.port = port
    let parameters = NWParameters.tcp
    let websocketOptions = NWProtocolWebSocket.Options()
    websocketOptions.autoReplyPing = true
    parameters.defaultProtocolStack.applicationProtocols.insert(websocketOptions, at: 0)
    guard let nwPort = NWEndpoint.Port(rawValue: port) else {
      throw NSError(domain: "simstream", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid port \(port)"])
    }
    self.listener = try NWListener(using: parameters, on: nwPort)
  }

  func start(onReady: @escaping () -> Void) {
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    listener.stateUpdateHandler = { state in
      switch state {
      case .ready:
        onReady()
      case .failed(let error):
        fputs("[simstream] listener failed: \(error)\n", stderr)
        exit(1)
      case .cancelled:
        break
      default:
        break
      }
    }
    listener.start(queue: queue)
  }

  func broadcast(_ data: Data) {
    queue.async { [weak self] in
      guard let self else { return }
      if data.first == 1 { self.latestConfig = data }
      for (id, connection) in self.clients {
        self.send(data, to: connection) { [weak self] failed in
          if failed { self?.clients[id] = nil }
        }
      }
    }
  }

  func stop() {
    queue.sync {
      for connection in clients.values { connection.cancel() }
      clients.removeAll()
      listener.cancel()
    }
  }

  private func accept(_ connection: NWConnection) {
    let id = UUID()
    clients[id] = connection
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        if let config = self?.latestConfig {
          self?.send(config, to: connection)
        }
        self?.receiveLoop(id: id, connection: connection)
      case .failed, .cancelled:
        self?.queue.async { self?.clients[id] = nil }
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  private func receiveLoop(id: UUID, connection: NWConnection) {
    connection.receiveMessage { [weak self] _, _, _, error in
      guard let self else { return }
      if error != nil {
        self.clients[id] = nil
        connection.cancel()
        return
      }
      if self.clients[id] != nil {
        self.receiveLoop(id: id, connection: connection)
      }
    }
  }

  private func send(_ data: Data, to connection: NWConnection, onDone: ((Bool) -> Void)? = nil) {
    let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
    let context = NWConnection.ContentContext(identifier: "simstream-frame", metadata: [metadata])
    connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
      onDone?(error != nil)
    })
  }
}
