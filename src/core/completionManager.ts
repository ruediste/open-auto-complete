import * as vscode from "vscode";
import { ConfigContainer } from "./configuration";
import { LlmClient } from "./llmClient";
import { Logger, LogManager } from "./logger";
import { formatPosition, ProgrammaticPromise } from "./util";

interface Event<T> {
  subscribe: (handler: (message: T) => void) => void;
}

class EventOwner<T> implements Event<T> {
  private handlers: ((message: T) => void)[] = [];

  fire(message: T) {
    this.handlers.forEach((h) => h(message));
  }

  subscribe(handler: (message: T) => void) {
    this.handlers.push(handler);
  }
}

interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
  readonly cancelled: Promise<boolean>;
}

class CancellationTokenOwner implements CancellationToken {
  private onCancellationRequestedOwner = new EventOwner<void>();
  isCancellationRequested = false;
  private cancelledPromise = new ProgrammaticPromise<boolean>();

  get cancelled() {
    return this.cancelledPromise.promise;
  }
  get onCancellationRequested(): Event<void> {
    return this.onCancellationRequestedOwner;
  }

  cancel() {
    if (this.isCancellationRequested) {
      return;
    }
    this.isCancellationRequested = true;
    this.onCancellationRequestedOwner.fire();
    this.cancelledPromise.resolve(true);
  }
}

export interface CompletionRequest {}

interface Completion {
  id: number;
  startTime: number;
  file: string;
  offset: number;
  matchPrefix: string;
  availableCompletion: string;
  token: CancellationTokenOwner;
  completed: boolean;
}

async function stringStreamToString(input: AsyncGenerator<string>) {
  let result = "";
  for await (const chunk of input) {
    result += chunk;
  }
  return result;
}

export class CompletionManager implements vscode.InlineCompletionItemProvider {
  private log: Logger;

  constructor(
    private config: ConfigContainer,
    private llmClient: LlmClient,
    logManager: LogManager
  ) {
    this.requestLoop();
    this.log = logManager.get(
      "Completion Manager",
      (c) => c.logCompletionManager
    );
  }

  private completions: Completion[] = [];
  private nextId = 0;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    vsCodeToken: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    const id = this.nextId++;
    const offset = document.offsetAt(position);

    this.log.info?.(
      `received request ${
        context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
          ? "automatic"
          : "invoke"
      } ${formatPosition(position)} (${offset}) id: ${id} ${
        context.selectedCompletionInfo
          ? "completion info: " + context.selectedCompletionInfo.text
          : ""
      }\n${document.getText(
        new vscode.Range(
          new vscode.Position(Math.max(0, position.line - 1), 0),
          position
        )
      )}<CURSOR>${document.getText(
        new vscode.Range(position, new vscode.Position(position.line + 2, 0))
      )}`
    );

    const token = new CancellationTokenOwner();

    let prefix =
      document.getText(
        new vscode.Range(document.positionAt(offset - 30), position)
      ) + (context.selectedCompletionInfo?.text ?? "");

    const suffix = document.getText(
      new vscode.Range(position, document.positionAt(offset - 10))
    );

    const now = Date.now();

    const currentCompletion: Completion = {
      id,
      startTime: now,
      file: document.fileName,
      offset,
      matchPrefix: prefix.substring(prefix.length - 15),
      availableCompletion: "",
      token,
      completed: false,
    };

    function createItem(completion: string) {
      return [
        new vscode.InlineCompletionItem(
          (context.selectedCompletionInfo?.text ?? "") + completion,
          context.selectedCompletionInfo?.range ??
            new vscode.Range(position, position)
        ),
      ];
    }

    // filter existing completions
    this.completions = this.completions.filter(
      (completion) =>
        !completion.completed ||
        (Math.abs(completion.offset - offset) < 30 &&
          now - completion.startTime < 15 * 1000)
    );

    // find matching existing completion
    const searchPrefix = prefix.substring(prefix.length - 10);

    const candidates: {
      perfectMatch: boolean;
      completionStr: string;
      completion: Completion;
    }[] = [];

    for (const completion of this.completions) {
      // limit the distance of the completion point
      if (Math.abs(completion.offset - offset) > 30) {
        continue;
      }
      const allText = completion.matchPrefix + completion.availableCompletion;

      // check if the existing completion contains the prefix of the current completion request
      const idx = allText.indexOf(searchPrefix);
      if (idx >= 0) {
        // Check if this is a perfect match. If so, we don't need to trigger another completion later
        const perfectMatch =
          completion.completed &&
          completion.file === currentCompletion.file &&
          completion.offset === currentCompletion.offset &&
          completion.matchPrefix === currentCompletion.matchPrefix;

        candidates.push({
          perfectMatch,
          completionStr: allText.substring(idx + searchPrefix.length),
          completion,
        });
      }
    }

    // sort by descending completion length
    candidates.sort((a, b) => b.completionStr.length - a.completionStr.length);

    if (candidates.length === 0 || !candidates[0].perfectMatch) {
      this.log.info?.("Queuing Completion " + id);
      this.requestPending.resolve(true);
      this.pendingRequest = {
        completion: currentCompletion,
        factory: async () => {
          currentCompletion.startTime = Date.now();
          try {
            for await (const chunk of await this.llmClient.getCompletion(
              prefix,
              suffix
            )) {
              currentCompletion.availableCompletion += chunk;
            }
          } finally {
            currentCompletion.completed = true;
          }
        },
      };
    }

    if (candidates.length === 0) {
      this.log.info?.("Found no existing completion");
      return [];
    }

    const bestCandidate = candidates[0];
    this.log.info?.(
      `Found existing completion: ${bestCandidate.completion.id} perfectMatch: ${bestCandidate.perfectMatch}`
    );
    return await createItem(bestCandidate.completionStr);
  }

  private requestPending = new ProgrammaticPromise<boolean>();
  private pendingRequest?: {
    completion: Completion;
    factory: () => Promise<void>;
  };

  private stopToken = new CancellationTokenOwner();

  dispose() {
    this.stopToken.cancel();
  }

  private async requestLoop() {
    this.log.info?.("Entering Request Loop");
    while (true) {
      try {
        this.log.info?.("Waiting for next request");
        await Promise.any([
          this.requestPending.promise,
          this.stopToken.cancelled,
        ]);
        if (this.stopToken.isCancellationRequested) {
          this.log.info?.("Stop requested, exiting loop");
          break;
        }
        this.requestPending = new ProgrammaticPromise();
        const request = this.pendingRequest!;
        this.pendingRequest = undefined;

        this.completions.push(request.completion);

        // perform completion
        this.log.info?.(
          "Start fetching completion for " + request.completion.id
        );
        await request.factory();
        this.log.info?.("Completion fetched for " + request.completion.id);

        // trigger completion to show results
        vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
      } catch (e) {
        this.log.error?.("Error in request loop: " + e);
      }
    }
  }
}
