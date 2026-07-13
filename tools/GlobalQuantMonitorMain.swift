import AppKit
import WebKit

private let monitorURL = URL(string: "http://127.0.0.1:8787/monitor.html")!
private let statusURL = URL(string: "http://127.0.0.1:8787/api/backend-monitor/status")!

final class MonitorAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private var retryWorkItem: DispatchWorkItem?
    private var healthAttempts = 0

    private lazy var projectRoot: URL = {
        let bundleURL = Bundle.main.bundleURL.standardizedFileURL
        if bundleURL.pathExtension == "app" {
            return bundleURL.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMainMenu()
        buildWindow()
        showLoadingPage()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        checkBackend(startIfNeeded: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        retryWorkItem?.cancel()
    }

    private func configureMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Global Quant Monitor", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Global Quant Monitor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        let frame = NSRect(x: 0, y: 0, width: 1360, height: 900)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Global Quant Monitor"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedRed: 0.035, green: 0.039, blue: 0.035, alpha: 1)
        window.minSize = NSSize(width: 980, height: 680)
        window.contentView = webView
        window.center()
        window.isReleasedWhenClosed = false
    }

    private func showLoadingPage(message: String = "正在连接本地量化后端") {
        let page = """
        <!doctype html>
        <html lang="zh-CN">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              :root { color-scheme: dark; }
              * { box-sizing: border-box; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; overflow: hidden; color: #f2f0e9; background: #090a09; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
              .shell { position: relative; width: min(920px, calc(100vw - 64px)); min-height: 430px; display: grid; grid-template-columns: 1fr 1.08fr; overflow: hidden; border: 1px solid rgba(242,240,233,.08); border-radius: 8px; background: #0d0f0d; box-shadow: 0 30px 90px rgba(0,0,0,.38); }
              .copy { z-index: 2; padding: 62px 52px; align-self: center; }
              .eyebrow { margin: 0 0 12px; color: #c6a35a; font-size: 11px; font-weight: 750; text-transform: uppercase; }
              h1 { margin: 0 0 18px; font-size: 42px; line-height: 1.12; }
              p { margin: 0; color: #c8c6bf; font-size: 15px; line-height: 1.75; }
              .status { margin-top: 34px; display: inline-flex; align-items: center; gap: 10px; color: #858881; font-size: 13px; }
              .dot { width: 8px; height: 8px; border-radius: 50%; background: #c6a35a; box-shadow: 0 0 0 6px rgba(198,163,90,.1); animation: pulse 1.8s ease-in-out infinite; }
              .art { min-height: 430px; background: linear-gradient(90deg,rgba(13,15,13,.2),rgba(13,15,13,0)), url("assets/images/workspace-model-texture-v1.jpg") center/cover; filter: saturate(.72) sepia(.12); opacity: .78; }
              @keyframes pulse { 50% { opacity: .45; transform: scale(.82); } }
              @media (max-width: 720px) { .shell { grid-template-columns: 1fr; } .art { position: absolute; inset: 0; opacity: .2; } .copy { padding: 44px 32px; } h1 { font-size: 34px; } }
              @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
            </style>
          </head>
          <body>
            <main class="shell">
              <section class="copy">
                <div class="eyebrow">Global Quant Watch</div>
                <h1>模型运行中枢</h1>
                <p>加载本地行情监控、模型轨迹、样本外证据与 Paper Agent 状态。</p>
                <div class="status"><span class="dot"></span><span>\(message)</span></div>
              </section>
              <div class="art" role="img" aria-label="量化模型网络插图"></div>
            </main>
          </body>
        </html>
        """
        webView.loadHTMLString(page, baseURL: projectRoot)
    }

    private func checkBackend(startIfNeeded: Bool) {
        var request = URLRequest(url: statusURL)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            guard let self else { return }
            let ok = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                if ok {
                    self.retryWorkItem?.cancel()
                    self.webView.load(URLRequest(url: monitorURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
                    return
                }
                if startIfNeeded && self.serverProcess == nil {
                    self.startBackend()
                }
                self.scheduleHealthRetry()
            }
        }.resume()
    }

    private func scheduleHealthRetry() {
        retryWorkItem?.cancel()
        healthAttempts += 1
        if healthAttempts == 20 {
            showLoadingPage(message: "后台启动时间较长，仍在重试；日志位于 /tmp/global-quant-monitor.log")
        }
        let workItem = DispatchWorkItem { [weak self] in
            self?.checkBackend(startIfNeeded: false)
        }
        retryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + (healthAttempts < 12 ? 0.45 : 1.5), execute: workItem)
    }

    private func startBackend() {
        guard let nodeURL = nodeCandidates().first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            showLoadingPage(message: "未找到本机 Node 运行时；可先运行 start-local.sh")
            return
        }

        let logURL = URL(fileURLWithPath: "/tmp/global-quant-monitor.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let logHandle = try? FileHandle(forWritingTo: logURL)
        _ = try? logHandle?.seekToEnd()

        let process = Process()
        process.executableURL = nodeURL
        process.arguments = [projectRoot.appendingPathComponent("server.mjs").path]
        process.currentDirectoryURL = projectRoot
        process.environment = ProcessInfo.processInfo.environment.merging(["NODE_ENV": "production"]) { _, new in new }
        process.standardOutput = logHandle ?? FileHandle.nullDevice
        process.standardError = logHandle ?? FileHandle.nullDevice
        do {
            try process.run()
            serverProcess = process
        } catch {
            showLoadingPage(message: "后台启动失败：\(error.localizedDescription)")
        }
    }

    private func nodeCandidates() -> [URL] {
        var paths: [String] = []
        if let configured = ProcessInfo.processInfo.environment["NODE_BINARY"], !configured.isEmpty {
            paths.append(configured)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        paths.append("\(home)/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")
        paths.append("/opt/homebrew/bin/node")
        paths.append("/usr/local/bin/node")
        paths.append("/usr/bin/node")
        return paths.map { URL(fileURLWithPath: $0) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadingPage(message: "页面加载中断，正在重新连接本地后端")
        scheduleHealthRetry()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadingPage(message: "本地后端暂不可达，正在重新连接")
        scheduleHealthRetry()
    }
}

let application = NSApplication.shared
let delegate = MonitorAppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
