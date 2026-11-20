import * as v from "vscode";
import { runSpike } from "./spike";
import { Review } from "./review-ui";
import { panel } from "./panel";
import { turn, Conversation } from "./turn";

export function activate(context: v.ExtensionContext) {
  const review = new Review(),
    output = v.window.createOutputChannel("Overtype");
  const conversation: Conversation = {};
  let view: v.WebviewPanel | undefined;
  const log = {
    append: (s: string) => {
      output.append(s);
      void view?.webview.postMessage(s);
    },
    appendLine: (s: string) => {
      output.appendLine(s);
      void view?.webview.postMessage(s + "\n");
    },
  };
  let active: AbortController | undefined;
  const command = (name: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      v.commands.registerCommand("forgeReview." + name, async (...args) => {
        try {
          return await handler(...args);
        } catch (error) {
          output.appendLine(String(error));
          v.window.setStatusBarMessage(String(error), 8000);
          return false;
        }
      }),
    );
  context.subscriptions.push(
    output,
    v.workspace.registerTextDocumentContentProvider("forge-review", review),
    v.languages.registerCodeLensProvider({ scheme: "forge-review" }, review),
  );
  command("spike", async () => {
    output.show(true);
    await runSpike((s) => output.appendLine(s));
    return true;
  });
  command("session", async () => {
    if (!conversation.session || !conversation.url)
      throw Error("Start an agent task first.");
    await v.env.openExternal(
      v.Uri.parse(
        conversation.url +
          "/sessions/" +
          encodeURIComponent(conversation.session),
      ),
    );
  });
  command("review", () => review.open());
  command("decide", (key, revision, index, accept) =>
    active ? undefined : review.decide(key, revision, index, accept),
  );
  command("acceptAll", async () => {
    if (active) return;
    await review.acceptAll();
  });
  command("rejectAll", () => {
    if (!active) review.clear();
  });
  command("stop", () => {
    active?.abort();
    review.clear();
  });
  async function run(inline: boolean, goal?: string) {
    if (active || review.files.size)
      throw Error("Finish the current run and review pending changes first.");
    const editor = v.window.activeTextEditor;
    const folder = editor
      ? (v.workspace.getWorkspaceFolder(editor.document.uri) ??
        v.workspace.workspaceFolders?.[0])
      : v.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== "file" || !v.workspace.isTrusted)
      throw Error("Open a trusted local Git workspace.");
    if (
      inline &&
      (!editor ||
        editor.selection.isEmpty ||
        editor.document.uri.scheme !== "file" ||
        !v.workspace.getWorkspaceFolder(editor.document.uri))
    )
      throw Error("Select workspace code first.");
    let prompt =
      goal ??
      (await v.window.showInputBox({
        prompt: inline
          ? "How should the selection change?"
          : "What should the agent change?",
      }));
    if (!prompt || active || review.files.size) return;
    if (inline && editor)
      prompt +=
        "\nSelected text in " +
        v.workspace.asRelativePath(editor.document.uri) +
        ":\n" +
        editor.document.getText(editor.selection);
    const control = new AbortController();
    active = control;
    output.show(true);
    try {
      await turn(
        folder.uri.fsPath,
        prompt,
        review,
        control,
        log,
        inline && editor
          ? {
              doc: editor.document,
              text: editor.document.getText(editor.selection),
            }
          : undefined,
        inline ? undefined : conversation,
      );
      if (review.files.size)
        await review.open(review.files.keys().next().value);
    } catch (error) {
      review.clear();
      throw error;
    } finally {
      active = undefined;
    }
  }
  command("inline", () => run(true));
  command("agent", () => {
    if (view) {
      view.reveal();
      return;
    }
    view = panel(
      (goal) => run(false, goal),
      () => {
        active?.abort();
        review.clear();
      },
      () => {
        void review.open();
      },
    );
    view.onDidDispose(() => {
      view = undefined;
    });
  });
}
