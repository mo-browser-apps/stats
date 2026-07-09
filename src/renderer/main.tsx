import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import "@fontsource-variable/sora/index.css";
import "./index.css";
import App from "./App.tsx";
import { initializeSentry } from "./sentry";

void initializeSentry().catch((error: unknown) => {
  console.warn("Sentry init failed", error);
});

/*
 * Block trackpad pinch-to-zoom on the page.
 */
window.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
    }
  },
  { passive: false },
);

ReactDOM.createRoot(document.getElementById("root")!, {
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
  onUncaughtError: Sentry.reactErrorHandler(),
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
