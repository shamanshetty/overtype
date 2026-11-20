import * as v from "vscode";
import { reviewHunks, previewAccepted, Hunk } from "./review";

interface Proposal {
  uri: v.Uri;
  original: string;
  hunks: Hunk[];
  revision: number;
}
export class Review
  implements v.TextDocumentContentProvider, v.CodeLensProvider
{
  files = new Map<string, Proposal>();
  private counter = 0;
  private changes = new v.EventEmitter<v.Uri>();
  readonly onDidChange = this.changes.event;
  virtual(key: string) {
    return v.Uri.parse("forge-review:/preview").with({ query: key });
  }
  provideTextDocumentContent(uri: v.Uri) {
    const file = this.files.get(uri.query);
    return file ? previewAccepted(file.original, file.hunks) : "";
  }
  stage(doc: v.TextDocument, before: string, after: string) {
    const key = doc.uri.toString(),
      original = doc.getText(),
      previous = this.files.get(key);
    if (previous && original !== previous.original)
      throw Error("File changed since review started.");
    const current = previous
      ? previewAccepted(original, previous.hunks)
      : original;
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    before = before.replace(/\r?\n/g, eol);
    after = after.replace(/\r?\n/g, eol);
    if (!before || current.split(before).length !== 2)
      throw Error(
        "Original text must occur exactly once in the proposed file.",
      );
    const proposed = current.replace(before, () => after);
    const hunks = reviewHunks(original, proposed);
    if (hunks.length)
      this.files.set(key, {
        uri: doc.uri,
        original,
        hunks,
        revision: ++this.counter,
      });
    else this.files.delete(key);
    this.changes.fire(this.virtual(key));
    return hunks.length;
  }
  clear() {
    const keys = [...this.files.keys()];
    this.files.clear();
    for (const key of keys) this.changes.fire(this.virtual(key));
  }
  async open(key?: string) {
    if (!key)
      key = (
        await v.window.showQuickPick(
          [...this.files].map(([key, p]) => ({
            label: v.workspace.asRelativePath(p.uri),
            key,
          })),
          { placeHolder: "Choose a proposed file" },
        )
      )?.key;
    const file = key && this.files.get(key);
    if (file)
      await v.commands.executeCommand(
        "vscode.diff",
        file.uri,
        this.virtual(file.uri.toString()),
        "Review - " + v.workspace.asRelativePath(file.uri),
      );
  }
  provideCodeLenses(doc: v.TextDocument) {
    const key = doc.uri.query,
      p = this.files.get(key);
    if (!p) return [];
    let shift = 0;
    return p.hunks.flatMap((h, i) => {
      const pos = doc.positionAt(h.start + shift);
      shift += h.replacement.length - (h.end - h.start);
      return ["Accept", "Reject"].map(
        (title) =>
          new v.CodeLens(new v.Range(pos, pos), {
            title,
            command: "forgeReview.decide",
            arguments: [key, p.revision, i, title === "Accept"],
          }),
      );
    });
  }
  private applying = false;
  async acceptAll() {
    if (this.applying || !this.files.size) return;
    this.applying = true;
    try {
      const batch = [...this.files.values()];
      const docs = await Promise.all(
        batch.map((p) => v.workspace.openTextDocument(p.uri)),
      );
      const edit = new v.WorkspaceEdit();
      for (const [i, p] of batch.entries()) {
        const doc = docs[i];
        if (
          this.files.get(p.uri.toString()) !== p ||
          doc.getText() !== p.original
        )
          throw Error(
            "Conflict in " +
              v.workspace.asRelativePath(p.uri) +
              ". Review again.",
          );
        for (const h of p.hunks)
          edit.replace(
            p.uri,
            new v.Range(doc.positionAt(h.start), doc.positionAt(h.end)),
            h.replacement,
          );
      }
      if (!(await v.workspace.applyEdit(edit)))
        throw Error("VS Code declined the transaction.");
      this.clear();
    } finally {
      this.applying = false;
    }
  }
  async decide(
    key: string,
    rev: number,
    index: number | undefined,
    accept: boolean,
  ) {
    if (this.applying) return;
    this.applying = true;
    try {
      const p = this.files.get(key);
      if (!p || p.revision !== rev) return;
      const selected = index === undefined ? p.hunks : [p.hunks[index]];
      if (!selected[0]) return;
      const doc = await v.workspace.openTextDocument(p.uri);
      if (this.files.get(key) !== p) return;
      if (doc.getText() !== p.original)
        throw Error(
          "File changed. Discard this proposal and request a new edit.",
        );
      const remaining = p.hunks.filter((h) => !selected.includes(h));
      let base = p.original;
      if (accept) {
        const edit = new v.WorkspaceEdit();
        for (const h of [...selected].reverse())
          edit.replace(
            p.uri,
            new v.Range(doc.positionAt(h.start), doc.positionAt(h.end)),
            h.replacement,
          );
        if (!(await v.workspace.applyEdit(edit)))
          throw Error("VS Code declined the edit.");
        base = previewAccepted(base, selected);
        for (const h of remaining) {
          const delta = selected
            .filter((s) => s.start < h.start)
            .reduce((n, s) => n + s.replacement.length - s.end + s.start, 0);
          h.start += delta;
          h.end += delta;
        }
      }
      if (remaining.length)
        this.files.set(key, {
          ...p,
          original: base,
          hunks: remaining,
          revision: ++this.counter,
        });
      else this.files.delete(key);
      this.changes.fire(this.virtual(key));
    } finally {
      this.applying = false;
    }
  }
}
