import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
// Installs the token-auth fetch wrapper (auth.js) before any component's
// first fetch() call — must run before App mounts.
import "./auth.js";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
