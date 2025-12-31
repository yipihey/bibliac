import UIKit
import Capacitor

class CustomBridgeViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ICloudPlugin())
        print("[CustomBridge] ICloud plugin registered")
    }
}
