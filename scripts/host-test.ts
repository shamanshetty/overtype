import * as vscode from "vscode";
export async function run() {
  const passed = await vscode.commands.executeCommand<boolean>("forgeReview.spike");
  if (!passed) throw new Error("The Overtype extension command failed its round trip.");
}
