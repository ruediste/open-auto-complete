import * as vscode from "vscode";
import { CompletionFilterService } from "./completionFilterService";
import { ConfigContainer } from "./configuration";
import { LlmClient } from "./llmClient";
import { Logger, LogManager } from "./logger";
import { formatPosition, formatRange, ProgrammaticPromise } from "./util";

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

export interface CancellationToken {
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

export class CompletionManager implements vscode.InlineCompletionItemProvider {
  private log: Logger;
  private completions: Completion[] = [];
  private nextId = 0;

  readonly onCompletionInProgress = new EventOwner<boolean>();

  constructor(
    private config: ConfigContainer,
    private llmClient: LlmClient,
    private completionFilterService: CompletionFilterService,
    private logManager: LogManager
  ) {
    this.log = logManager.get(
      "Completion Manager",
      (c) => c.logCompletionManager
    );
    this.requestLoop();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    vsCodeToken: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    const id = this.nextId++;
    const config = this.config.config;

    this.log.info?.(
      `received request ${
        context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
          ? "automatic"
          : "invoke"
      } ${formatPosition(position)} id: ${id} ${
        context.selectedCompletionInfo
          ? `completion info: "${
              context.selectedCompletionInfo.text
            }" ${formatRange(context.selectedCompletionInfo.range)}`
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

    let offset: number;
    let prefix: string;
    let suffix: string;
    if (context.selectedCompletionInfo) {
      // the range of the completion info is the text that is already
      // typed after the start of the completion. We perform the
      // completion as if the completion was already selected
      const range = context.selectedCompletionInfo.range;
      const rangeStartOffset = document.offsetAt(range.start);
      offset = rangeStartOffset + context.selectedCompletionInfo.text.length;
      prefix =
        document.getText(
          new vscode.Range(
            document.positionAt(rangeStartOffset - config.prefixLength),
            range.start
          )
        ) + context.selectedCompletionInfo.text;
      suffix = document.getText(
        new vscode.Range(
          range.end,
          document.positionAt(
            document.offsetAt(range.end) + config.suffixLength
          )
        )
      );
    } else {
      offset = document.offsetAt(position);
      prefix = document.getText(
        new vscode.Range(
          document.positionAt(offset - config.prefixLength),
          position
        )
      );
      suffix = document.getText(
        new vscode.Range(
          position,
          document.positionAt(offset + config.suffixLength)
        )
      );
    }

    const now = Date.now();

    const currentCompletion: Completion = {
      id,
      startTime: now,
      file: document.fileName,
      offset,
      matchPrefix: prefix.substring(prefix.length - config.matchLength),
      availableCompletion: "",
      token,
      completed: false,
    };

    // filter existing completions
    this.completions = this.completions.filter(
      (completion) =>
        !completion.completed ||
        (Math.abs(completion.offset - offset) < 30 &&
          now - completion.startTime < 15 * 1000)
    );

    // find matching existing completion
    const bestCandidate = CompletionManager.findBestCandidate(
      prefix.substring(prefix.length - config.searchLength),
      currentCompletion,
      this.completions
    );

    if (!(bestCandidate?.perfectMatch ?? false)) {
      this.log.info?.("Queuing Completion " + id);
      this.requestPending.resolve(true);
      this.pendingRequest = {
        completion: currentCompletion,
        factory: async () => {
          currentCompletion.startTime = Date.now();
          try {
            let chars = await this.llmClient.getCompletion(
              `Completion ${id}`,
              prefix,
              suffix,
              currentCompletion.token
            );
            chars = this.completionFilterService.filter(chars);
            for await (const chunk of chars) {
              currentCompletion.availableCompletion += chunk;
            }
          } finally {
            currentCompletion.completed = true;
          }
        },
      };
    }

    if (bestCandidate === undefined) {
      this.log.info?.("Found no existing completion");
      return [];
    }

    this.log.info?.(
      `Found existing completion: ${bestCandidate.completion.id} perfectMatch: ${bestCandidate.perfectMatch} completion:\n${bestCandidate.completionStr}`
    );

    return [
      new vscode.InlineCompletionItem(
        (context.selectedCompletionInfo?.text ?? "") +
          bestCandidate.completionStr,
        context.selectedCompletionInfo?.range ??
          new vscode.Range(position, position)
      ),
    ];
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
    const log = this.logManager.get(
      "Completion Manager (queue)",
      (c) => c.logCompletionManager
    );
    while (true) {
      try {
        log.info?.("Waiting for next request");
        await Promise.any([
          this.requestPending.promise,
          this.stopToken.cancelled,
        ]);
        if (this.stopToken.isCancellationRequested) {
          log.info?.("Stop requested, exiting loop");
          break;
        }
        this.requestPending = new ProgrammaticPromise();
        const request = this.pendingRequest!;
        this.pendingRequest = undefined;

        this.completions.push(request.completion);

        // perform completion
        log.info?.("Start fetching completion for " + request.completion.id);
        this.onCompletionInProgress.fire(true);
        try {
          await request.factory();
        } finally {
          this.onCompletionInProgress.fire(false);
          log.info?.("Completion fetched for " + request.completion.id);

          // trigger completion to show results
          vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        }
      } catch (e) {
        log.error?.("Error in request loop: " + e);
      }
    }
  }

  static findBestCandidate<
    T extends Pick<
      Completion,
      "file" | "offset" | "matchPrefix" | "availableCompletion" | "completed"
    >
  >(
    searchPrefix: string,
    currentCompletion: Pick<Completion, "file" | "offset" | "matchPrefix">,
    completions: T[]
  ):
    | {
        perfectMatch: boolean;
        completionStr: string;
        completion: T;
      }
    | undefined {
    const candidates: (NonNullable<
      ReturnType<typeof this.findBestCandidate<T>>
    > & {
      cursorChange: number;
    })[] = [];

    for (const completion of completions) {
      const allText = completion.matchPrefix + completion.availableCompletion;

      // check if the existing completion contains the prefix of the current completion request
      const idx = allText.indexOf(searchPrefix);
      if (idx >= 0) {
        // Check if this is a perfect match. If so, we don't need to trigger another completion later
        const perfectMatch =
          completion.file === currentCompletion.file &&
          completion.offset === currentCompletion.offset &&
          completion.matchPrefix === currentCompletion.matchPrefix;

        candidates.push({
          perfectMatch,
          completionStr: allText.substring(idx + searchPrefix.length),
          completion,
          cursorChange: idx - completion.matchPrefix.length,
        });
      }
    }

    candidates.sort((a, b) => {
      if (a.perfectMatch && !b.perfectMatch) {
        return 1;
      }
      if (!a.perfectMatch && b.perfectMatch) {
        return -1;
      }

      // negative cursor change means that some of the prefix has been deleted. When creating the completion,
      // the LLM was given a longer prefix and with part of the prefix removed, the completion can be completely
      // different and much better.
      if (a.cursorChange < 0 || b.cursorChange < 0) {
        const result = a.cursorChange - b.cursorChange;
        if (result !== 0) {
          return result;
        }
      }

      // sort by descending completion length
      return a.completionStr.length - b.completionStr.length;
    });

    if (candidates.length === 0) {
      return undefined;
    }

    const candidate = candidates[candidates.length - 1];
    return {
      completion: candidate.completion,
      completionStr: candidate.completionStr,
      perfectMatch: candidate.perfectMatch,
    };
  }
}
