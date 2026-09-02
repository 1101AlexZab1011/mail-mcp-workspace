var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

var ChatOverride = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    const extensionId = this.extension.id;
    const chatUrl = this.extension.baseURI.resolve("chat.html");
    // A content tab shows whatever favicon it is handed; without this it falls back to the
    // generic document icon rather than reading the page's own <link rel="icon">.
    const chatIcon = this.extension.baseURI.resolve("chat-icon.svg");
    // The spaces toolbar handles the click from an ancestor, so a listener on the button
    // itself runs too late. Capturing at the window is the only point that runs first.
    const wire = (window) => {
      const button = window.document.getElementById("chatButton");
      if (!button || window.mailMcpAgentChatWired) return;
      window.mailMcpAgentChatWired = true;
      window.addEventListener("click", (event) => {
        if (!event.target?.closest?.("#chatButton")) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window.document.getElementById("tabmail").openTab("contentTab", { url: chatUrl, favIconUrl: chatIcon });
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
