// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import {
  ConfigContainer,
  OpenAutoCompleteConfiguration,
} from "./core/configuration";
import { LlmClient } from "./core/llmClient";

function readConfiguration() {
  const vsCodeConfig = vscode.workspace.getConfiguration("openAutoComplete");
  const config: OpenAutoCompleteConfiguration = {
    apiBase: vsCodeConfig.get("apiBase")!,
    apiKey: vsCodeConfig.get("apiKey")!,
  };
  return config;
}

class CompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(client: LlmClient) {}
  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<
    vscode.InlineCompletionItem[] | vscode.InlineCompletionList
  > {
    const offset = document.offsetAt(position);
    console.log(
      context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
        ? "automatic"
        : "invoke",
      position.line + 1 + ":" + (position.character + 1),
      document.offsetAt(position)
    );
    console.log(
      document.getText(
        new vscode.Range(
          document.positionAt(offset - 10),
          document.positionAt(offset + 10)
        )
      )
    );
    console.log("completionInfo", context.selectedCompletionInfo?.text);
    const item = new vscode.InlineCompletionItem(
      (context.selectedCompletionInfo?.text ?? "") + "Hello World",
      context.selectedCompletionInfo?.range ??
        new vscode.Range(position, position)
    );
    // item.filterText = context.selectedCompletionInfo?.text;
    return [item];
  }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log(
    'Congratulations, your extension "open-auto-complete" is now active!'
  );

  const config = new ConfigContainer();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(
      () => (config.config = readConfiguration())
    )
  );
  config.config = readConfiguration();

  const client = new LlmClient(config);
  const provider = new CompletionProvider(client);

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "open-auto-complete.helloWorld",
      async () => {
        // The code you place here will be executed every time your command is executed
        // Display a message box to the user
        vscode.window.showInformationMessage(
          "Hello World from Open Auto Complete!"
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      provider
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
