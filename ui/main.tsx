import "agentic-design/styles.css";
import { ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./ui.css";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <TooltipProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </TooltipProvider>
  </ThemeProvider>,
);
