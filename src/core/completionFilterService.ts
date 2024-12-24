import { Logger, LogManager } from "./logger";

export class CompletionFilterService {
  logStop: Logger;
  constructor(logManager: LogManager) {
    this.logStop = logManager.get(
      "Completion Stop",
      (c) => c.logCompletionStop
    );
  }

  filter(chars: AsyncGenerator<string>): AsyncGenerator<string> {
    return chars;
  }
}
