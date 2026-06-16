import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/sora/index.css";
import "./index.css";
import App from "./App.tsx";

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
