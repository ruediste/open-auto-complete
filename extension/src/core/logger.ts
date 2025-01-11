import { LogLevel, LogOutputChannel } from "vscode";
import {
  ConfigContainer,
  OpenAutoCompleteConfiguration,
} from "./configuration";

export interface LogManager {
  get(
    name: string,
    predicate: (config: OpenAutoCompleteConfiguration) => boolean
  ): Logger;
}

// The Api of the logger uses optional functions to short circuit disabled loggers.
export interface Logger {
  info: ((message: string) => void) | undefined;
  warn: ((message: string) => void) | undefined;
  error: ((message: string) => void) | undefined;
}

class ChannelLogger implements Logger {
  constructor(
    private name: string,
    private predicate: (config: OpenAutoCompleteConfiguration) => boolean,
    private configContainer: ConfigContainer,
    private channel: LogOutputChannel
  ) {}

  get info() {
    return this.logFunction(LogLevel.Info, (msg) => this.channel.info(msg));
  }

  get warn() {
    return this.logFunction(LogLevel.Warning, (msg) => this.channel.warn(msg));
  }

  get error() {
    return this.logFunction(LogLevel.Error, (msg) => this.channel.error(msg));
  }

  private logFunction(
    level: LogLevel,
    doLog: (message: string) => void
  ): ((message: string) => void) | undefined {
    if (
      this.channel.logLevel <= level &&
      // always show warnings and above
      (level >= LogLevel.Warning || this.predicate(this.configContainer.config))
    ) {
      return (message) => doLog(this.name + ": " + message);
    }
    return undefined;
  }
}

export class ChannelLogManager implements LogManager {
  constructor(
    private configContainer: ConfigContainer,
    private channel: LogOutputChannel
  ) {}

  get(
    name: string,
    predicate: (config: OpenAutoCompleteConfiguration) => boolean
  ): Logger {
    return new ChannelLogger(
      name,
      predicate,
      this.configContainer,
      this.channel
    );
  }
}

class NopLogger implements Logger {
  readonly warn = undefined;
  readonly error = undefined;
  readonly info = undefined;
}

export class NopLogManager implements LogManager {
  get(): Logger {
    return new NopLogger();
  }
}
