import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Bundled fonts keep the app self-contained (no network dependency at runtime).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

import { Root } from "./App";
import { configureMonaco } from "@/lib/monaco";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing the #root container");

// Point Monaco at the bundled editor before any editor mounts (no runtime CDN fetch).
configureMonaco();

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
