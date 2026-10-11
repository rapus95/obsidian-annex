'use strict';

/**
 * Minimal stand-in for the `obsidian` module.
 *
 * The real module only exists inside Obsidian's Electron renderer, so the tests
 * (and the load check) substitute this stub to let the single-file `main.js` be
 * required in a plain Node process.
 */

class Notice {
  constructor(message, timeout) {
    this.message = message;
    this.timeout = timeout;
    Notice.last = this;
  }
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  addStatusBarItem() {
    return { style: {}, setText() {}, addClass() {}, addEventListener() {} };
  }
  addCommand() {}
  registerEvent() {}
}

module.exports = {
  Plugin,
  Notice,
  MarkdownView: class {},
  PluginSettingTab: class {},
  Setting: class {},
};
