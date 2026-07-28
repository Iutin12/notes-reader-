/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge } = require("electron");

// The renderer only receives the local OMR endpoint; it never gets Node or
// filesystem access. A normal browser keeps using same-origin Docker routes.
contextBridge.exposeInMainWorld("noteraDesktop", {
  omrBaseUrl: "http://127.0.0.1:8000",
});
