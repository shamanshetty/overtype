import * as v from "vscode";
import { randomUUID } from "node:crypto";

export function panel(
  run: (goal: string) => Promise<void>,
  stop: () => void,
  review: () => void,
) {
  const view = v.window.createWebviewPanel(
    "astra.agent",
    "Overtype",
    v.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  const nonce = randomUUID();
  view.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">body{font:var(--vscode-font-size) var(--vscode-font-family);max-width:56rem;margin:24px auto;padding:0 20px}textarea{display:block;width:95%;min-height:5em;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:10px}button{margin:10px 6px 10px 0;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>Overtype</h1><label for="goal">Workspace task</label><textarea id="goal"></textarea><button id="run">Run task</button><button id="stop">Stop</button><button id="review">Review changes</button><pre id="events" role="log"></pre><script nonce="${nonce}">const api=acquireVsCodeApi();for(const id of ['run','stop','review'])document.getElementById(id).onclick=()=>api.postMessage({id,goal:document.getElementById('goal').value});window.addEventListener('message',e=>{const log=document.getElementById('events');log.textContent=(log.textContent+e.data).slice(-80000)});</script></body></html>`;
  view.webview.onDidReceiveMessage(async (m) => {
    try {
      if (m.id === "run" && typeof m.goal === "string" && m.goal.trim())
        await run(m.goal);
      if (m.id === "stop") stop();
      if (m.id === "review") review();
    } catch (error) {
      void view.webview.postMessage("\n" + String(error) + "\n");
    }
  });
  return view;
}
