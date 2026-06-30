import Foundation

struct SerialConnectionDraft {
    var name = "Mac USB NMEA"
    var devicePath = "/dev/cu.usbserial-1410"
    var baud = 38400
    var priority = 50
    var enabled = true

    var isValid: Bool {
        !devicePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        (1...65535).contains(baud) &&
        (0...100).contains(priority)
    }

    var payload: [String: Any] {
        [
            "name": name.isEmpty ? "Mac USB NMEA" : name,
            "type": "serial",
            "address": devicePath.trimmingCharacters(in: .whitespacesAndNewlines),
            "port": baud,
            "priority": priority,
            "enabled": enabled,
            "dataProtocol": "nmea0183"
        ]
    }
}
