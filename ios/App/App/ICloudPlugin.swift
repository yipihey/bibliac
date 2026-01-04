import Foundation
import Capacitor

@objc(ICloudPlugin)
public class ICloudPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ICloudPlugin"
    public let jsName = "ICloud"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getContainerUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rmdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyFromLocal", returnType: CAPPluginReturnPromise)
    ]

    private let containerIdentifier = "iCloud.io.bibliac.app"

    private func getContainerURL() -> URL? {
        // Try real iCloud first
        if let iCloudURL = FileManager.default.url(forUbiquityContainerIdentifier: containerIdentifier) {
            return iCloudURL
        }
        // Fallback to local Documents for simulator
        #if targetEnvironment(simulator)
        return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("iCloudFallback")
        #else
        return nil
        #endif
    }

    private func getDocumentsURL() -> URL? {
        guard let containerURL = getContainerURL() else { return nil }
        // For simulator fallback, don't add Documents subdirectory
        #if targetEnvironment(simulator)
        if FileManager.default.url(forUbiquityContainerIdentifier: containerIdentifier) == nil {
            return containerURL
        }
        #endif
        return containerURL.appendingPathComponent("Documents")
    }

    private func getFullPath(_ path: String) -> URL? {
        guard let documentsURL = getDocumentsURL() else { return nil }
        if path.isEmpty {
            return documentsURL
        }
        return documentsURL.appendingPathComponent(path)
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        let available = getContainerURL() != nil
        call.resolve(["available": available])
    }

    @objc func getContainerUrl(_ call: CAPPluginCall) {
        if let url = getDocumentsURL() {
            // Ensure Documents directory exists
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            call.resolve(["url": url.path])
        } else {
            call.reject("iCloud container not available")
        }
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Path is required")
            return
        }

        guard let fileURL = getFullPath(path) else {
            call.reject("iCloud container not available")
            return
        }

        let encoding = call.getString("encoding")

        // Check if file exists and is downloaded from iCloud
        let fileManager = FileManager.default

        // For iCloud files, we may need to trigger a download
        if !fileManager.fileExists(atPath: fileURL.path) {
            // Check if this is an iCloud placeholder that needs downloading
            do {
                // Try to start downloading the file from iCloud
                try fileManager.startDownloadingUbiquitousItem(at: fileURL)
                // File is being downloaded - reject with specific message
                call.reject("File is downloading from iCloud, please try again")
                return
            } catch {
                // Not an iCloud file or other error
                call.reject("File not found: \(path)")
                return
            }
        }

        do {
            if encoding != nil {
                let data = try String(contentsOf: fileURL, encoding: .utf8)
                call.resolve(["data": data])
            } else {
                let data = try Data(contentsOf: fileURL)
                call.resolve(["data": data.base64EncodedString()])
            }
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Path is required")
            return
        }

        guard let data = call.getString("data") else {
            call.reject("Data is required")
            return
        }

        guard let fileURL = getFullPath(path) else {
            call.reject("iCloud container not available")
            return
        }

        let encoding = call.getString("encoding")
        let recursive = call.getBool("recursive") ?? false

        do {
            // Create parent directory if needed
            let parentDir = fileURL.deletingLastPathComponent()
            if !FileManager.default.fileExists(atPath: parentDir.path) {
                if recursive {
                    try FileManager.default.createDirectory(at: parentDir, withIntermediateDirectories: true)
                } else {
                    call.reject("Parent directory doesn't exist")
                    return
                }
            }

            if encoding != nil {
                try data.write(to: fileURL, atomically: true, encoding: .utf8)
            } else {
                if let base64Data = Data(base64Encoded: data) {
                    try base64Data.write(to: fileURL)
                } else {
                    call.reject("Invalid base64 data")
                    return
                }
            }
            call.resolve(["uri": fileURL.absoluteString])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Path is required")
            return
        }

        guard let fileURL = getFullPath(path) else {
            call.reject("iCloud container not available")
            return
        }

        do {
            try FileManager.default.removeItem(at: fileURL)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Path is required")
            return
        }

        guard let dirURL = getFullPath(path) else {
            call.reject("iCloud container not available")
            return
        }

        let recursive = call.getBool("recursive") ?? false

        do {
            try FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: recursive)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func rmdir(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Path is required")
            return
        }

        guard let dirURL = getFullPath(path) else {
            call.reject("iCloud container not available")
            return
        }

        let recursive = call.getBool("recursive") ?? false

        do {
            if !recursive {
                let contents = try FileManager.default.contentsOfDirectory(at: dirURL, includingPropertiesForKeys: nil)
                if !contents.isEmpty {
                    call.reject("Directory is not empty")
                    return
                }
            }
            try FileManager.default.removeItem(at: dirURL)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func readdir(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""

        guard let dirURL = getFullPath(path) else {
            call.reject("iCloud container not available")
            return
        }

        do {
            // Ensure Documents directory exists for root
            if path.isEmpty {
                try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
            }

            let contents = try FileManager.default.contentsOfDirectory(at: dirURL, includingPropertiesForKeys: [.isDirectoryKey])
            var files: [[String: Any]] = []

            for item in contents {
                let resourceValues = try item.resourceValues(forKeys: [.isDirectoryKey])
                let isDir = resourceValues.isDirectory ?? false
                files.append([
                    "name": item.lastPathComponent,
                    "type": isDir ? "directory" : "file",
                    "uri": item.absoluteString
                ])
            }

            call.resolve(["files": files])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Path is required")
            return
        }

        guard let fileURL = getFullPath(path) else {
            call.reject("iCloud container not available")
            return
        }

        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
            let fileType = attrs[.type] as? FileAttributeType
            let isDir = fileType == .typeDirectory

            call.resolve([
                "type": isDir ? "directory" : "file",
                "size": attrs[.size] as? Int ?? 0,
                "mtime": (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0,
                "uri": fileURL.absoluteString
            ])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func copy(_ call: CAPPluginCall) {
        guard let from = call.getString("from"),
              let to = call.getString("to") else {
            call.reject("From and to paths are required")
            return
        }

        guard let fromURL = getFullPath(from),
              let toURL = getFullPath(to) else {
            call.reject("iCloud container not available")
            return
        }

        do {
            // Remove destination if it exists
            if FileManager.default.fileExists(atPath: toURL.path) {
                try FileManager.default.removeItem(at: toURL)
            }
            try FileManager.default.copyItem(at: fromURL, to: toURL)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        guard let from = call.getString("from"),
              let to = call.getString("to") else {
            call.reject("From and to paths are required")
            return
        }

        guard let fromURL = getFullPath(from),
              let toURL = getFullPath(to) else {
            call.reject("iCloud container not available")
            return
        }

        do {
            // Remove destination if it exists
            if FileManager.default.fileExists(atPath: toURL.path) {
                try FileManager.default.removeItem(at: toURL)
            }
            try FileManager.default.moveItem(at: fromURL, to: toURL)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    // Copy a file from local Documents to iCloud container
    // This avoids passing large base64 data through JavaScript
    @objc func copyFromLocal(_ call: CAPPluginCall) {
        guard let sourcePath = call.getString("sourcePath"),
              let destPath = call.getString("destPath") else {
            call.reject("sourcePath and destPath are required")
            return
        }

        // Get source from local Documents directory
        let docsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let sourceURL = docsURL.appendingPathComponent(sourcePath)

        // Get destination in iCloud container
        guard let destURL = getFullPath(destPath) else {
            call.reject("iCloud container not available")
            return
        }

        do {
            // Create parent directory if needed
            let parentDir = destURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parentDir, withIntermediateDirectories: true)

            // Remove destination if it exists
            if FileManager.default.fileExists(atPath: destURL.path) {
                try FileManager.default.removeItem(at: destURL)
            }

            // Copy file from local to iCloud
            try FileManager.default.copyItem(at: sourceURL, to: destURL)
            call.resolve(["uri": destURL.absoluteString])
        } catch {
            call.reject("Copy failed: \(error.localizedDescription)")
        }
    }
}
