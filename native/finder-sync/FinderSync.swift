import Cocoa
import FinderSync

final class FinderSync: FIFinderSync {
    private let menuTitle = "Ask Interpreter to Edit This"

    override init() {
        super.init()
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: "/")]
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        let menu = NSMenu(title: "")
        let item = NSMenuItem(title: menuTitle, action: #selector(askInterpreterToEditSelection(_:)), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        return menu
    }

    @objc private func askInterpreterToEditSelection(_ sender: Any?) {
        let controller = FIFinderSyncController.default()
        let selectedURLs = controller.selectedItemURLs() ?? []
        let targetURLs = selectedURLs.isEmpty
            ? controller.targetedURL().map { [$0] } ?? []
            : selectedURLs
        let paths = targetURLs.map { $0.path }.filter { !$0.isEmpty }

        guard !paths.isEmpty else {
            return
        }

        launchInterpreter(with: paths)
    }

    private func launchInterpreter(with paths: [String]) {
        let appexURL = Bundle.main.bundleURL
        let appContentsURL = appexURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let executableURL = appContentsURL
            .appendingPathComponent("MacOS")
            .appendingPathComponent("Interpreter")

        let process = Process()
        process.executableURL = executableURL
        process.arguments = ["--ask"] + paths

        do {
            try process.run()
        } catch {
            NSLog("Ask Interpreter Finder extension failed to launch Interpreter: \(String(describing: error))")
        }
    }
}
