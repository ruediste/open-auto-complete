import { ConfigContainer } from "./configuration";

class StreamControl {
  private _cancelled = false;
  get cancelled(): boolean {
    return this._cancelled;
  }

  cancel() {
    this._cancelled = true;
  }
}

async function* readLines(
  reader: ReadableStreamDefaultReader,
  ctrl: StreamControl
) {
  let buffer = "";
  const decoder = new TextDecoder();

  while (!ctrl.cancelled) {
    const part = await reader.read();
    if (part.done) {
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
        if (ctrl.cancelled) {
          return;
        }
        buffer = buffer.substring(idx + 1);
      }
    }
  }

  if (!ctrl.cancelled) {
    yield buffer;
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

async function* parseMessages(
  messages: AsyncGenerator<string>,
  ctrl: StreamControl
) {
  for await (const messageStr of messages) {
    if (messageStr === "[DONE]") {
      console.log("cancelling");
      ctrl.cancel();
      break;
    }
    const message: MistralStreamMessage = JSON.parse(messageStr);
    yield message;
  }
}

async function* messagesToCharStream(
  messages: AsyncGenerator<MistralStreamMessage>
) {
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
}

export class LlmClient {
  constructor(private config: ConfigContainer) {}

  async createCompletion() {
    console.log("sending request");
    const config = this.config.config;
    // Fetch the original image
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
        prompt:
          '// test.js\n// print "Hello World I love You" using console.log()\n',
        suffix: "exit(0);",
      }),
    });
    // Retrieve its body as ReadableStream

    const reader = response.body!.getReader();
    const ctrl = new StreamControl();

    const lines = readLines(reader, ctrl);
    const messages = parseMessages(splitToMessageStrings(lines), ctrl);
    const chars = messagesToCharStream(messages);
    return chars;

    // let count = 0;
    // let all = "";
    // for await (const char of chars) {
    //   console.log(char, char.charCodeAt(0));
    //   all += char;
    //   count++;
    //   if (count > 200) {
    //     console.log("cancel");
    //     ctrl.cancel();
    //   }
    // }

    // await reader.cancel();

    // console.log("done", all);
  }
}
