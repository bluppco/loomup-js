// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "Loomup",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
        .tvOS(.v15),
        .watchOS(.v8),
    ],
    products: [
        .library(name: "Loomup", targets: ["Loomup"]),
    ],
    targets: [
        .target(
            name: "Loomup",
            path: "native/swift/Sources/Loomup"
        ),
        .testTarget(
            name: "LoomupTests",
            dependencies: ["Loomup"],
            path: "native/swift/Tests/LoomupTests"
        ),
    ]
)
