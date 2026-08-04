import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DocumentArtifactsApp } from "./DocumentArtifactsApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DocumentArtifactsApp />
  </StrictMode>,
);
