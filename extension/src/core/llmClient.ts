import { Ollama } from "ollama";
import OpenAI from "openai";
import { OutputChannel } from "vscode";
import { AsyncGenerators } from "./asyncGenerators";
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
    if (part.done || token.isCancellationRequested) {
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
  } else {
    // cancel the reader abort the completion and to make sure resources are released
    await reader.cancel();
  }
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
    const startTime = Date.now();

    let result: AsyncGenerator<string>;
    switch (this.config.config.provider) {
      case "mistral":
        result = await this.getCompletionMistral(prefix, suffix, token);
        break;
      case "ollama":
        result = this.getCompletionOllama(prefix, suffix, token);
        break;
      case "openai":
        result = this.getCompletionOpenAi(prefix, suffix, token);
        break;
      case "simple":
        result = this.getCompletionSimple(prefix, suffix, token);
        break;
      default:
        throw new Error(`Unknown provider: ${this.config}`);
    }

    let firstChar = true;
    return AsyncGenerators.tap(
      result,
      (str) => {
        if (firstChar) {
          firstChar = false;
          this.channel.appendLine(
            `Time to first Char: ${Date.now() - startTime}ms`
          );
        }
        return this.channel.append(str);
      },
      () => {
        this.channel.appendLine(
          `\n=== completed. Time to completion: ${Date.now() - startTime}ms`
        );
      }
    );
  }

  async *getCompletionOllama(
    prefix: string,
    suffix: string,
    token: CancellationToken
  ): AsyncGenerator<string> {
    const config = this.config.config;
    const ollama = new Ollama({ host: config.apiBase });
    const response = await ollama.generate({
      model: config.model,
      prompt: prefix,
      suffix,
      stream: true,
      options: {
        stop: ["<|fim_pad|>", "<|file_sep|>", "<|fim_prefix|>"],
      },
    });
    if (token.isCancellationRequested) {
      ollama.abort();
      return;
    }

    token.onCancellationRequested.subscribe(() => {
      ollama.abort();
    });

    try {
      for await (const chunk of response) {
        if (token.isCancellationRequested) {
          return;
        }
        for (const char of chunk.response) {
          yield char;
        }
      }
    } catch (error: any) {
      if (error.name === "AbortError") {
        // swallow
      }
    }
  }

  async *getCompletionOpenAi(
    prefix: string,
    suffix: string,
    token: CancellationToken
  ): AsyncGenerator<string> {
    const config = this.config.config;
    const openai = new OpenAI({
      baseURL: config.apiBase,
      apiKey: config.apiKey,
    });
    const response = await openai.completions.create({
      model: config.model,
      prompt: prefix,
      suffix,
      stream: true,
      max_tokens: 25,
      temperature: 0,
    });

    try {
      for await (const chunk of response) {
        if (token.isCancellationRequested) {
          return;
        }
        for (const char of chunk.choices[0].text) {
          yield char;
        }
      }
    } catch (error: any) {
      if (error.name === "AbortError") {
        // swallow
      }
    }
  }

  async *getCompletionSimple(
    prefix: string,
    suffix: string,
    token: CancellationToken
  ): AsyncGenerator<string> {
    const config = this.config.config;

    const response = await fetch(config.apiBase, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix,
        suffix,
      }),
    });

    if (response.status !== 200) {
      throw new Error(
        `Request Failed: ${response.status} ${
          response.statusText
        }\n${await response.text()}`
      );
    }

    const completion = await response.text();
    for (const char of completion) {
      yield char;
    }
  }

  async getCompletionMistral(
    prefix: string,
    suffix: string,
    token: CancellationToken
  ): Promise<AsyncGenerator<string>> {
    const config = this.config.config;
    let apiBase = config.apiBase;
    if (apiBase.endsWith("/")) {
      apiBase = apiBase.substring(0, apiBase.length - 1);
    }

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
    const messages = AsyncGenerators.tap(
      parseMessages(splitToMessageStrings(lines)),
      (msg) => {
        if (msg.usage) {
          usage = msg.usage;
        }
      }
    );
    const chars = messagesToCharStream(messages);

    return AsyncGenerators.tap(
      chars,
      () => {},
      () => {
        if (usage) {
          this.channel.appendLine(
            `Usage: prompt tokens: ${usage.prompt_tokens} completion_tokens: ${usage.completion_tokens} total tokens: ${usage.total_tokens}`
          );
        }
      }
    );
  }
}
