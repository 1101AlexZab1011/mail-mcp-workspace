/* about:logins, the Browser's saved passwords (logins/): the add-on's logins folder as chrome://mailworkspace,
   and the about: page that serves it with chrome rights (Thunderbird has no about:logins of its own).
   Loaded into the Experiment's scope; `installAboutLogins` returns the undo. */
/* global Services, ChromeUtils, Cc, Ci */

var ABOUT_LOGINS = "about:logins";
var ABOUT_LOGINS_PAGE = "chrome://mailworkspace/content/logins.html";

function installAboutLogins(rootURI, componentManager) {
  const startup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  const chrome = startup.registerChrome(Services.io.newURI("manifest.json", null, rootURI), [["content", "mailworkspace", "logins/"]]);
  const page = Services.io.newURI(ABOUT_LOGINS_PAGE);
  const module = {
    QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),
    newChannel(uri, loadInfo) {
      const channel = Services.io.newChannelFromURIWithLoadInfo(page, loadInfo);
      channel.originalURI = uri;
      return channel;
    },
    // Not URI_SAFE_FOR_UNTRUSTED_CONTENT: web pages cannot link to it, and it loads in the parent process.
    getURIFlags() { return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI; },
    getChromeURI() { return page; },
  };
  const factory = {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    createInstance(iid) { return module.QueryInterface(iid); },
  };
  const registrar = componentManager.QueryInterface(Ci.nsIComponentRegistrar);
  const cid = Services.uuid.generateUUID();
  registrar.registerFactory(cid, "Mail Workspace about:logins", "@mozilla.org/network/protocol/about;1?what=logins", factory);
  return () => {
    try { registrar.unregisterFactory(cid, factory); } catch { /* already gone */ }
    chrome.destruct();
  };
}
