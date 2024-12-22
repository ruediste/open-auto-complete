// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { CompletionManager } from "./core/completionManager";
import {
  ConfigContainer,
  OpenAutoCompleteConfiguration,
} from "./core/configuration";
import { LlmClient } from "./core/llmClient";
import { LogManager } from "./core/logger";

function readConfiguration() {
  const vsCodeConfig = vscode.workspace.getConfiguration("openAutoComplete");
  const config: OpenAutoCompleteConfiguration = {
    apiBase: vsCodeConfig.get("apiBase")!,
    apiKey: vsCodeConfig.get("apiKey")!,
    logCompletionManager: vsCodeConfig.get("log.completionManager") ?? false,
  };
  return config;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Open Auto Complete started");

  const logChannel = vscode.window.createOutputChannel("Open Auto Complete", {
    log: true,
  });
  context.subscriptions.push(logChannel);

  const llmChannel = vscode.window.createOutputChannel(
    "Open Auto Complete - LLM"
  );
  context.subscriptions.push(llmChannel);

  const config = new ConfigContainer();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(
      () => (config.config = readConfiguration())
    )
  );
  config.config = readConfiguration();

  const logManager = new LogManager(config, logChannel);

  const client = new LlmClient(config);

  const manager = new CompletionManager(config, client, logManager);

  context.subscriptions.push(manager);

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      manager
    )
  );
}

export function deactivate() {}
