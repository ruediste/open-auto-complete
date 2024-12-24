import { OutputChannel } from "vscode";
import { CancellationToken } from "./completionManager";
import { ConfigContainer } from "./configuration";

async function* readLines(
  reader: ReadableStreamDefaultReader,
  token: CancellationToken
) {
  let buffer = "";
  const decoder = new TextDecoder();

  while (!token.isCancellationRequested) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    if (token.isCancellationRequested) {
      break;
    }

    if (part.value) {
      buffer += decoder.decode(part.value);

      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) {
          break;
        }
        yield buffer.substring(0, idx);
        if (token.isCancellationRequested) {
          break;
        }
        buffer = buffer.substring(idx + 1);
      }
    }
  }

  if (!token.isCancellationRequested) {
    yield buffer;
  }

  // always cancel the reader to make sure resources are released
  await reader.cancel();
}

async function* splitToMessageStrings(reader: AsyncGenerator<string>) {
  let message = "";
  for await (const line of reader) {
    if (line === "") {
      yield message;
      message = "";
      continue;
    }

    if (line.startsWith("data: ")) {
      message += line.substring(6);
    }
  }
}

async function* parseMessages(messages: AsyncGenerator<string>) {
  for await (const messageStr of messages) {
    if (messageStr === "[DONE]") {
      break;
    }
    const message: MistralStreamMessage = JSON.parse(messageStr);
    yield message;
  }
}

async function* messagesToCharStream(
  messages: AsyncGenerator<MistralStreamMessage>
): AsyncGenerator<string> {
  for await (const message of messages) {
    for (const ch of message.choices[0].delta.content) {
      yield ch;
    }
  }
}

async function* tap<T>(
  input: AsyncGenerator<T>,
  action: (item: T) => void,
  end?: () => void
): AsyncGenerator<T> {
  for await (const item of input) {
    action(item);
    yield item;
  }
  end?.();
}

interface MistralStreamMessage {
  choices: {
    delta: {
      content: string;
    };
    finish_reason:
      | "stop"
      | "length"
      | "model_length"
      | "error"
      | "tool_calls"
      | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface MistralFimRequest {
  model: "codestral-2405" | "codestral-latest";
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream: boolean;
  stop: string | string[];
  random_seed?: number;
  prompt: string;
  suffix?: string;
  min_tokens?: number;
}

export class LlmClient {
  constructor(
    private config: ConfigContainer,
    private channel: OutputChannel
  ) {}

  async getCompletion(
    requestDescription: string,
    prefix: string,
    suffix: string,
    token: CancellationToken
  ): Promise<AsyncGenerator<string>> {
    this.channel.append(
      `\n=========================================
Sending ${requestDescription}
${prefix}<FIM>${suffix}
===
`
    );

    const config = this.config.config;
    let apiBase = config.apiBase;
    if (apiBase.endsWith("/")) {
      apiBase = apiBase.substring(0, apiBase.length - 1);
    }

    const startTime = Date.now();

    const response = await fetch(apiBase + "/v1/fim/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "codestral-latest",
        prompt: prefix,
        suffix,
        max_tokens: 64,
      } as MistralFimRequest),
    });
    if (response.status !== 200) {
      throw new Error(
        `Request Failed: ${response.status} ${
          response.statusText
        }\n${await response.text()}`
      );
    }

    // Retrieve body as ReadableStream
    const reader = response.body!.getReader();

    const lines = readLines(reader, token);
    let usage: MistralStreamMessage["usage"] = undefined;
    const messages = tap(parseMessages(splitToMessageStrings(lines)), (msg) => {
      if (msg.usage) {
        usage = msg.usage;
      }
    });
    const chars = messagesToCharStream(messages);

    let firstChar = true;
    return tap(
      chars,
      (str) => {
        if (firstChar) {
          firstChar = false;
          this.channel.append(
            `Time to first Char: ${Date.now() - startTime}ms\n`
          );
        }
        return this.channel.append(str);
      },
      () => {
        this.channel.appendLine("");
        if (usage) {
          this.channel.appendLine(
            `Usage: prompt tokens: ${usage.prompt_tokens} completion_tokens: ${usage.completion_tokens} total tokens: ${usage.total_tokens}`
          );
        }
      }
    );
  }
}
