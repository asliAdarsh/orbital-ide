/**
 * Monaco bootstrap.
 *
 * `@monaco-editor/react` defaults to downloading the editor from jsDelivr at runtime,
 * which would break offline use and violate the app's own `script-src 'self'` CSP. The
 * loader is therefore pointed at the bundled `monaco-editor` package, and Monaco's
 * language workers are served as bundled Vite worker modules.
 *
 * Must run before the first editor mounts — `main.tsx` calls it at startup.
 */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

export function configureMonaco(): void {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };
  loader.config({ monaco });
}
