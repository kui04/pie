import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadPlatform } from "@/hooks/use-platform";
import "./index.css";

// Before React mounts, so the shell's boundary has an answer by the time it
// asks rather than showing a blank frame and then arriving.
void loadPlatform();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
