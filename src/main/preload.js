const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getStartupEnabled: () => ipcRenderer.invoke("data:getStartupEnabled"),
  setStartupEnabled: (enabled) => ipcRenderer.invoke("data:setStartupEnabled", enabled),

  getTemplatesAll: () => ipcRenderer.invoke("templates:getAll"),
  saveTemplate: (payload) => ipcRenderer.invoke("templates:save", payload),
  deleteTemplate: (id) => ipcRenderer.invoke("templates:delete", { id }),

  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (partial) => ipcRenderer.invoke("settings:set", partial),

  getClipboardHistory: () => ipcRenderer.invoke("clipboard:getHistory"),

  getTodos: () => ipcRenderer.invoke("todos:getAll"),
  addTodo: (text, targetDate) => ipcRenderer.invoke("todos:add", { text, targetDate }),
  setTodoDate: (id, targetDate) => ipcRenderer.invoke("todos:setDate", { id, targetDate }),
  toggleTodo: (id) => ipcRenderer.invoke("todos:toggle", { id }),
  deleteTodo: (id) => ipcRenderer.invoke("todos:delete", { id }),
  clearDoneTodos: () => ipcRenderer.invoke("todos:clearDone"),

  paste: (text) => ipcRenderer.send("ui:paste", { text }),
  close: () => ipcRenderer.send("ui:close"),

  clipboardFlyoutSync: (payload) => ipcRenderer.send("clipboard-flyout:sync", payload),
  clipboardFlyoutHide: () => ipcRenderer.send("clipboard-flyout:hide"),
  clipboardFlyoutPeerHoverSend: (inside) => ipcRenderer.send("clipboard-flyout:peer-hover", inside),

  templatesFlyoutSync: (payload) => ipcRenderer.send("templates-flyout:sync", payload),
  templatesFlyoutHide: () => ipcRenderer.send("templates-flyout:hide"),
  templatesFlyoutPeerHoverSend: (inside) => ipcRenderer.send("templates-flyout:peer-hover", inside),

  onUiUpdate: (handler) => ipcRenderer.on("ui:update", (_evt, payload) => handler(payload)),

  onThemeChange: (handler) => ipcRenderer.on("theme:update", (_evt, payload) => handler(payload)),

  onClipboardFlyoutPeerHover: (handler) =>
    ipcRenderer.on("clipboard-flyout:peer-hover", (_evt, inside) => handler(inside)),

  onClipboardFlyoutRender: (handler) =>
    ipcRenderer.on("clipboard-flyout:render", (_evt, payload) => handler(payload)),

  onClipboardFlyoutSyncDone: (handler) => ipcRenderer.on("clipboard-flyout:sync-done", () => handler()),

  onTemplatesFlyoutRender: (handler) =>
    ipcRenderer.on("templates-flyout:render", (_evt, payload) => handler(payload)),

  onTemplatesFlyoutSyncDone: (handler) => ipcRenderer.on("templates-flyout:sync-done", () => handler()),

  onTemplatesFlyoutPeerHover: (handler) =>
    ipcRenderer.on("templates-flyout:peer-hover", (_evt, inside) => handler(inside)),

  reportClipboardMainHeight: (height) => ipcRenderer.send("clipboard-compact:resize-main", height),
  reportClipboardFlyoutHeight: (height) => ipcRenderer.send("clipboard-compact:resize-flyout", height),

  onClipboardCompactMainSized: (handler) => ipcRenderer.on("clipboard-compact:main-sized", () => handler()),
  onClipboardFlyoutSized: (handler) => ipcRenderer.on("clipboard-compact:flyout-sized", () => handler()),
});

