// Extension pages disallow inline scripts, so Prism's manual mode is set from a file.
// Without it Prism highlights the whole document on load, before any message exists.
window.Prism = window.Prism || {};
window.Prism.manual = true;
