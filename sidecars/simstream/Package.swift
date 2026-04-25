// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "simstream",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "simstream", targets: ["simstream"]),
  ],
  targets: [
    .target(
      name: "SimBridgeC",
      publicHeadersPath: "include",
      cSettings: [.unsafeFlags(["-fobjc-arc"])]
    ),
    .executableTarget(
      name: "simstream",
      dependencies: ["SimBridgeC"],
      linkerSettings: [
        .linkedFramework("Foundation"),
        .linkedFramework("CoreVideo"),
        .linkedFramework("CoreMedia"),
        .linkedFramework("VideoToolbox"),
        .linkedFramework("IOSurface"),
        .linkedFramework("Network"),
      ]
    ),
  ]
)
