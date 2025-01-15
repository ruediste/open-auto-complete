// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { CompletionFilterService } from "./core/completionFilterService";
import { CompletionManager } from "./core/completionManager";
import {
  ConfigContainer,
  OpenAutoCompleteConfiguration,
} from "./core/configuration";
import { LlmClient } from "./core/llmClient";
import { ChannelLogManager } from "./core/logger";
import { DataExtractionService } from "./fineTune/DataExtractionService";
import { PerformanceEvaluationService } from "./fineTune/PerformanceEvaluationService";

function readConfiguration() {
  const vsCodeConfig = vscode.workspace.getConfiguration("openAutoComplete");
  const config: OpenAutoCompleteConfiguration = {
    apiBase: vsCodeConfig.get("apiBase")!,
    apiKey: vsCodeConfig.get("apiKey")!,
    enabled: vsCodeConfig.get("openAutoComplete.enabled") ?? true,
    logCompletionManager: vsCodeConfig.get("log.completionManager") ?? false,
    logCompletionStop: vsCodeConfig.get("log.completionStop") ?? false,
    prefixLength: vsCodeConfig.get("prefixLength")!,
    suffixLength: vsCodeConfig.get("suffixLength")!,
    matchLength: vsCodeConfig.get("matchLength")!,
    searchLength: vsCodeConfig.get("searchLength")!,
    model: vsCodeConfig.get("model")!,
    provider: vsCodeConfig.get("provider")!,
  };
  return config;
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

  const logManager = new ChannelLogManager(config, logChannel);

  const client = new LlmClient(config, llmChannel);
  const completionFilterService = new CompletionFilterService(logManager);

  const manager = new CompletionManager(
    config,
    client,
    completionFilterService,
    logManager
  );

  const dataExtractionService = new DataExtractionService(logChannel);

  const performanceEvaluationService = new PerformanceEvaluationService(
    config,
    client,
    completionFilterService,
    logManager,
    dataExtractionService
  );

  context.subscriptions.push(manager);

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      manager
    )
  );

  const loadingSpinnerDecorationType =
    vscode.window.createTextEditorDecorationType({
      backgroundColor: "transparent",

      gutterIconPath: context.asAbsolutePath("media/loadingSpinner.gif"),
      gutterIconSize: "cover",
    });
  context.subscriptions.push(loadingSpinnerDecorationType);

  const loadingSpinnerManager = new LoadingSpinnerManager(
    () => {
      const editor = vscode.window.activeTextEditor;
      return editor?.setDecorations(loadingSpinnerDecorationType, [
        new vscode.Range(editor.selection.end, editor.selection.end),
      ]);
    },
    () =>
      vscode.window.activeTextEditor?.setDecorations(
        loadingSpinnerDecorationType,
        []
      )
  );

  manager.onCompletionInProgress.subscribe((loading) =>
    loadingSpinnerManager.setLoading(loading)
  );

  // add command
  vscode.commands.registerCommand("open-auto-complete.fimDataSet", async () => {
    // await dataExtractionService.extractAndSaveData();
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
      },
      async (progress, token) => {
        // await performanceEvaluationService.evaluate(progress, token);
        dataExtractionService.extractAndSaveData();
      }
    );
  });
}

export function deactivate() {}

/** Manages the loading spinner. It is only shown after a delay, and
 * is visible for a minimum amount of time */
class LoadingSpinnerManager {
  private timer?: NodeJS.Timeout;
  private loading = false;
  private spinnerShown = false;
  private spinnerShownTime?: number;
  constructor(
    private showSpinner: () => void,
    private hideSpinner: () => void
  ) {}

  public setLoading(newValue: boolean) {
    if (this.loading === newValue) {
      return;
    }
    this.loading = newValue;

    if (newValue) {
      clearTimeout(this.timer);
      if (!this.spinnerShown) {
        this.timer = setTimeout(() => {
          this.showSpinner();
          this.spinnerShown = true;
          this.spinnerShownTime = Date.now();
        }, 200);
      }
    } else {
      clearTimeout(this.timer);
      if (this.spinnerShown) {
        const minTimeRemaining = 250 - (Date.now() - this.spinnerShownTime!);
        if (minTimeRemaining > 0) {
          setTimeout(() => {
            this.hideSpinner();
            this.spinnerShown = false;
            this.spinnerShownTime = undefined;
          }, minTimeRemaining);
        } else {
          this.hideSpinner();
          this.spinnerShown = false;
          this.spinnerShownTime = undefined;
        }
      }
    }
  }
}
