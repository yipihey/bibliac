#!/usr/bin/env swift
// ShareHelper.swift - Native macOS share sheet for Bibliac
// Compile: swiftc -o ShareHelper ShareHelper.swift -framework AppKit

import AppKit
import Foundation

class ShareDelegate: NSObject, NSSharingServicePickerDelegate {
    var completion: ((Bool) -> Void)?

    func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker, didChoose service: NSSharingService?) {
        if let service = service {
            // User chose a service - wait for completion
            service.delegate = ServiceDelegate.shared
            ServiceDelegate.shared.completion = completion
        } else {
            // User cancelled
            completion?(false)
        }
    }
}

class ServiceDelegate: NSObject, NSSharingServiceDelegate {
    static let shared = ServiceDelegate()
    var completion: ((Bool) -> Void)?

    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
        completion?(true)
    }

    func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) {
        completion?(true) // Still count as handled
    }
}

// Main entry point
guard CommandLine.arguments.count > 1 else {
    print("ERROR: No file path provided")
    exit(1)
}

let filePath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: filePath)

guard FileManager.default.fileExists(atPath: filePath) else {
    print("ERROR: File not found: \(filePath)")
    exit(1)
}

// Initialize the app
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Create a small transparent window to anchor the picker
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)

// Position near mouse cursor or screen center
if let screen = NSScreen.main {
    let mouseLocation = NSEvent.mouseLocation
    let x = min(max(mouseLocation.x - 150, 50), screen.frame.width - 350)
    let y = min(max(mouseLocation.y - 200, 50), screen.frame.height - 400)
    window.setFrameOrigin(NSPoint(x: x, y: y))
}

window.backgroundColor = .clear
window.isOpaque = false
window.level = .floating
window.makeKeyAndOrderFront(nil)

// Create the share picker
let picker = NSSharingServicePicker(items: [fileURL])
let delegate = ShareDelegate()
picker.delegate = delegate

// Handle completion
var hasCompleted = false
delegate.completion = { success in
    guard !hasCompleted else { return }
    hasCompleted = true
    if success {
        print("SUCCESS: File shared")
    } else {
        print("CANCELLED: User dismissed picker")
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        app.terminate(nil)
    }
}

// Show the picker
DispatchQueue.main.async {
    app.activate(ignoringOtherApps: true)
    picker.show(relativeTo: .zero, of: window.contentView!, preferredEdge: .minY)
}

// Timeout fallback - if nothing happens within 2 minutes, exit
DispatchQueue.main.asyncAfter(deadline: .now() + 120) {
    if !hasCompleted {
        hasCompleted = true
        print("TIMEOUT: No action taken")
        app.terminate(nil)
    }
}

// Run the app
app.run()
