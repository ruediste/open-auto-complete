import { Logger, LogManager } from "./logger";

async function* countWords(
  chars: AsyncGenerator<string>,
  startOfWord: (count: number, stop: () => void, stopped: boolean) => void,
  endOfWord: (count: number, stop: () => void, stopped: boolean) => void
): AsyncGenerator<string> {
  let inWord = false;
  let count = 0;
  let stopped = false;
  const nonWordChars = new Set<string>([..." \t\r\n()[]{}'\"`+-*/~!%^&|;:.,"]);
  for await (const char of chars) {
    if (nonWordChars.has(char)) {
      if (inWord) {
        inWord = false;
        endOfWord(count, () => (stopped = true), stopped);
      }
    } else {
      if (!inWord) {
        inWord = true;
        startOfWord(++count, () => (stopped = true), stopped);
      }
    }
    if (!stopped) {
      yield char;
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
        if (count > 3) {
          stopCompletion("word count");
        }
        if (count > 9) {
          stopGeneration("word count");
        }
      },
      (count) => {}
    );
    return result;
  }
}
