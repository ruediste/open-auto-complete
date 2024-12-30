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

export class CancellationTokenOwner implements CancellationToken {
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

interface GenerationResponse {
  id: number;
  startTime?: number;
  file: string;
  offset: number;
  matchPrefix: string;
  token: CancellationTokenOwner;
  generationCompleted: boolean;
  finished$: ProgrammaticPromise<void>;
  generatedChars: ReplayAsyncGenerator<string>;
  availableResponse: string;
}

export class CompletionManager implements vscode.InlineCompletionItemProvider {
  private log: Logger;
  private generationResponses: GenerationResponse[] = [];
  private nextId = 0;
  private completionTriggerPending = false;

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
    if (!config.enabled) {
      return [];
    }

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

    /*
    General: Response Generation is considered as not started, in progress or complete. The completion becomes available as soon as the generation is complete. 
Rules:
- If there is an existing response (including the current one) with enough generated text to create a meaningful completion right away, create the completion.
- Check the response generation in progress. If it exactly matches the current prefix, wait for it's completion.
- Otherwise cancel the current generation, queue a generation for the current position and wait for it's completion.
*/

    const matchPrefix = prefix.substring(prefix.length - config.matchLength);
    const currentResponse: GenerationResponse = {
      id,
      file: document.fileName,
      offset,
      matchPrefix: prefix.substring(prefix.length - config.matchLength),
      availableResponse: "",
      generatedChars: new ReplayAsyncGenerator<string>(),
      token,
      generationCompleted: false,
      finished$: new ProgrammaticPromise(),
    };

    const queueResponseGeneration = () => {
      this.pendingRequest?.completion.finished$.resolve();
      this.pendingRequest = {
        completion: currentResponse,
        factory: async () => {
          let chars = await this.llmClient.getCompletion(
            `Completion ${id}`,
            prefix,
            suffix,
            currentResponse.token
          );
          chars = this.completionFilterService.filter(
            chars,
            true,
            () => {},
            () => token.cancel()
          );
          for await (const chunk of chars) {
            currentResponse.availableResponse += chunk;
          }
        },
      };
      this.requestPending.resolve(true);
    };

    // filter existing responses
    const now = Date.now();
    this.generationResponses = this.generationResponses.filter((completion) => {
      // if the cursor moved too far, remove existing response
      if (Math.abs(completion.offset - offset) > 30) {
        return false;
      }

      // if more than 30s passed, remove response
      if (completion.startTime && now - completion.startTime > 30 * 1000) {
        return false;
      }

      // otherwise keep
      return true;
    });

    function createResult(completionStr: string) {
      return [
        new vscode.InlineCompletionItem(
          (context.selectedCompletionInfo?.text ?? "") + completionStr,
          context.selectedCompletionInfo?.range ??
            new vscode.Range(position, position)
        ),
      ];
    }

    // find best matching existing generation response
    const bestCandidate = CompletionManager.findBestCandidate(
      prefix.substring(prefix.length - config.searchLength),
      this.generationResponses
    );

    // check if the filters consider the response complete
    if (bestCandidate !== undefined) {
      const filteredCompletion =
        await this.completionFilterService.applyFilters(
          bestCandidate.completionStr
        );

      const generate =
        bestCandidate.generationRequired ||
        Math.abs(bestCandidate.completion.offset - offset) > 10;

      this.log.info?.(
        `Found existing completion: ${bestCandidate.completion.id} queuing generation: ${generate} completion:\n${filteredCompletion}`
      );

      if (generate) {
        if (bestCandidate.generationRequired) {
          this.completionTriggerPending = true;
        }
        queueResponseGeneration();
      }
      return createResult(filteredCompletion);
    }

    this.completionTriggerPending = false;

    // check the response currently being generated
    if (this.currentGeneration) {
      // capture the field to avoid changes while awaiting
      const currentGeneration = this.currentGeneration;

      if (currentGeneration.matchPrefix === matchPrefix) {
        await currentGeneration.finished$.promise;
        if (vsCodeToken.isCancellationRequested) {
          return [];
        }

        const completion = await this.completionFilterService.applyFilters(
          currentGeneration.availableResponse
        );

        return createResult(completion);
      } else {
        // cancel current generation
        currentGeneration.token.cancel();
      }
    }

    // No existing response could be used, and the response currently being generated does not match as well.
    // Queue a response generation for the current request
    this.log.info?.(`Queuing Generation and waiting for completion for ${id}`);
    queueResponseGeneration();

    await currentResponse.finished$.promise;

    if (!currentResponse.generationCompleted) {
      return [];
    }

    const filteredResponse = await this.completionFilterService.applyFilters(
      currentResponse.availableResponse
    );
    this.log.info?.(
      `Using result of generation for ${id}:\n${currentResponse.availableResponse}\n===\n${filteredResponse}`
    );
    return createResult(filteredResponse);
  }

  private requestPending = new ProgrammaticPromise<boolean>();
  private pendingRequest?: {
    completion: GenerationResponse;
    factory: () => Promise<void>;
  };
  private currentGeneration?: GenerationResponse;

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
        this.currentGeneration = request.completion;

        // perform completion
        log.info?.("Start fetching completion for " + request.completion.id);
        this.onCompletionInProgress.fire(true);
        request.completion.startTime = Date.now();
        try {
          await request.factory();
          request.completion.generationCompleted = true;
          this.generationResponses.push(request.completion);
        } finally {
          request.completion.finished$.resolve();
          this.currentGeneration = undefined;
          this.onCompletionInProgress.fire(false);
          log.info?.("Completion fetched for " + request.completion.id);

          // trigger completion to show results
          if (this.completionTriggerPending) {
            log.info?.("Triggering inline completion");
            this.completionTriggerPending = false;
            vscode.commands.executeCommand(
              "editor.action.inlineSuggest.trigger"
            );
          }
        }
      } catch (e) {
        log.error?.("Error in request loop: " + e);
      }
    }
  }

  static searchCutInCompletion(
    searchPrefix: string,
    completion: { matchPrefix: string; availableResponse: string }
  ) {
    const allText = completion.matchPrefix + completion.availableResponse;

    // test if the existing completion contains the prefix of the current completion request
    // first search the last occurrence in the prefix
    const idx = allText.lastIndexOf(
      searchPrefix,
      completion.matchPrefix.length + searchPrefix.length
    );
    if (idx < 0) {
      // then look for the first occurrence in the generated text
      allText.indexOf(searchPrefix, completion.matchPrefix.length);
    }
    if (idx >= 0) {
      const cutIdx = idx + searchPrefix.length;
      return { cutIdx, completion: allText.substring(cutIdx) };
    }
  }

  static findBestCandidate<
    T extends Pick<GenerationResponse, "matchPrefix" | "availableResponse">
  >(
    searchPrefix: string,
    existingResponses: T[]
  ):
    | {
        generationRequired: boolean;
        completionStr: string;
        completion: T;
      }
    | undefined {
    const candidates: (NonNullable<
      ReturnType<typeof this.findBestCandidate<T>>
    > & {
      cursorChange: number;
    })[] = [];

    for (const completion of existingResponses) {
      const match = this.searchCutInCompletion(searchPrefix, completion);
      if (match) {
        const generationRequired =
          // When the cut is in the prefix, the LLM could have generated a different response for the shorter prefix
          match.cutIdx < completion.matchPrefix.length;

        candidates.push({
          generationRequired,
          completionStr: match.completion,
          completion,
          cursorChange: match.cutIdx - completion.matchPrefix.length,
        });
      }
    }

    candidates.sort((a, b) => {
      // if generation is required, candidates have a lower priority
      if (a.generationRequired && !b.generationRequired) {
        return -1;
      }
      if (!a.generationRequired && b.generationRequired) {
        return 1;
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
      generationRequired: candidate.generationRequired,
    };
  }
}

class ReplayAsyncGenerator<T> {
  private existing: T[] = [];
  private inputExhausted = false;
  private newItem = new ProgrammaticPromise<void>();
  private attached = false;

  attach(input: AsyncGenerator<T>) {
    if (this.attached) {
      throw new Error("can only attach once");
    }
    this.attached = true;

    this.pollLoop(input);
  }

  private async pollLoop(input: AsyncGenerator<T>) {
    try {
      for await (const item of input) {
        this.existing.push(item);
        this.newItem.resolve();
        this.newItem = new ProgrammaticPromise();
      }
    } catch (e) {
      console.log("Error while polling: ", e);
    } finally {
      this.inputExhausted = true;
    }
  }

  async *get(): AsyncGenerator<T> {
    let idx = 0;
    while (true) {
      while (idx < this.existing.length) {
        yield this.existing[idx];
      }
      if (this.inputExhausted) {
        break;
      }
      await this.newItem.promise;
    }
  }
}
