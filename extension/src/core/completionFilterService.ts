import { Logger, LogManager } from "./logger";

async function* countWords(
  chars: AsyncGenerator<string>,
  startOfWord: (count: number, stop: () => void, stopped: boolean) => void,
  endOfWord: (count: number, stop: () => void, stopped: boolean) => void
): AsyncGenerator<string> {
  let inWord = false;
  let count = 0;
  let stopped = false;
  let firstChar = true;
  const nonWordChars = new Set<string>([..." \t\r\n()[]{}'\"`+-*/~!%^&|;:.,"]);
  for await (const char of chars) {
    if (nonWordChars.has(char)) {
      if (firstChar) {
        inWord = false;
      }
      if (inWord) {
        inWord = false;
        endOfWord(count, () => (stopped = true), stopped);
      }
    } else {
      if (firstChar) {
        inWord = true;
        count = 1;
      }
      if (!inWord) {
        inWord = true;
        startOfWord(++count, () => (stopped = true), stopped);
      }
    }
    firstChar = false;
    if (!stopped) {
      yield char;
    }
  }
}

async function* forEachCharacter(
  chars: AsyncGenerator<string>,
  handler: (char: string) => void
) {
  for await (const char of chars) {
    handler(char);
    yield char;
  }
}

async function* stringToCharGenerator(
  input: string,
  token?: { isCancelRequested: boolean }
): AsyncGenerator<string, void, unknown> {
  for (const char of input) {
    yield char;
    if (token?.isCancelRequested) {
      return;
    }
  }
}

export class CompletionFilterService {
  private logStopCompletion: Logger;
  private logStopGeneration: Logger;

  constructor(logManager: LogManager) {
    this.logStopCompletion = logManager.get(
      "Completion Stop",
      (c) => c.logCompletionStop
    );
    this.logStopGeneration = logManager.get(
      "Generation Stop",
      (c) => c.logCompletionStop
    );
  }

  async applyFilters(completionStr: string) {
    let completionStopped = false;
    const stopToken = {
      isCancelRequested: false,
    };

    let completion = "";

    for await (const char of this.filter(
      stringToCharGenerator(completionStr, stopToken),
      false,
      () => {
        stopToken.isCancelRequested = true;
        completionStopped = true;
      },
      () => {}
    )) {
      if (!completionStopped) {
        completion += char;
      }
    }
    return completion;
  }

  filter(
    chars: AsyncGenerator<string>,
    doLog: boolean,
    stopCompletion: () => void,
    stopGeneration: () => void
  ): AsyncGenerator<string> {
    let completionStopped = false;
    let generationStopped = false;
    return this.doFilter(
      chars,
      (reason) => {
        if (!completionStopped) {
          completionStopped = true;
          if (doLog) {
            this.logStopCompletion.info?.(reason);
          }
          stopCompletion();
        }
      },
      (reason) => {
        if (!generationStopped) {
          generationStopped = true;
          if (doLog) {
            this.logStopGeneration.info?.(reason);
          }
          stopGeneration();
        }
      }
    );
  }

  private doFilter(
    chars: AsyncGenerator<string>,
    stopCompletion: (reason: string) => void,
    stopGeneration: (reason: string) => void
  ): AsyncGenerator<string> {
    let result = countWords(
      chars,
      (count) => {
        stopCompletion("word count");
        if (count > 9) {
          stopGeneration("word count");
        }
      },
      (count) => {}
    );

    let firstChar = true;
    result = forEachCharacter(result, (char) => {
      if (!firstChar && char === "\n") {
        stopCompletion("line break");
      }
      firstChar = false;
    });
    return result;
  }
}
