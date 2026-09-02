var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

var ChatOverride = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    const extensionId = this.extension.id;
    const chatUrl = this.extension.baseURI.resolve("chat.html");
    const wire = (window) => {
      const button = window.document.getElementById("chatButton");
      if (!button || button.dataset.mailMcpAgentChat) return;
      button.dataset.mailMcpAgentChat = "true";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.document.getElementById("tabmail").openTab("contentTab", { url: chatUrl });
      }, true);
    };
    this.windowListener = { chromeURLs: ["chrome://messenger/content/messenger.xhtml"], onLoadWindow: wire };
    ExtensionSupport.registerWindowListener(extensionId, this.windowListener);
    for (const window of ExtensionSupport.openWindows) {
      if (window.location.href === "chrome://messenger/content/messenger.xhtml") wire(window);
    }
  }

  onShutdown() {
    ExtensionSupport.unregisterWindowListener(this.extension.id);
  }
};
