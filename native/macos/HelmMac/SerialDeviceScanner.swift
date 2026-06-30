import Foundation

enum SerialDeviceScanner {
    static func visibleDevicePaths() -> [String] {
        let devURL = URL(fileURLWithPath: "/dev", isDirectory: true)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: devURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return entries
            .map { $0.lastPathComponent }
            .filter { name in
                name.hasPrefix("cu.") ||
                name.hasPrefix("tty.usb") ||
                name.hasPrefix("tty.SLAB") ||
                name.hasPrefix("tty.wchusb")
            }
            .map { "/dev/\($0)" }
            .sorted()
    }
}
