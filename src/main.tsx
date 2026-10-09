import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app/globals.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("Workena sa nepodarilo pripraviť na inštaláciu.", error);
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
