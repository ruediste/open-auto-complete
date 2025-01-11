import * as vscode from "vscode";
import { CompletionFilterService } from "../core/completionFilterService";
import { CancellationTokenOwner } from "../core/completionManager";
import { ConfigContainer } from "../core/configuration";
import { LlmClient } from "../core/llmClient";
import { LogManager } from "../core/logger";
import { DataExtractionService, FimExample } from "./DataExtractionService";

function countCommonStartChars(str1: string, str2: string) {
  let count = 0;
  const minLength = Math.min(str1.length, str2.length);

  for (let i = 0; i < minLength; i++) {
    if (str1[i] === str2[i]) {
      count++;
    } else {
      break;
    }
  }

  return count;
}

function shuffle(array: any[]) {
  let currentIndex = array.length;

  // While there remain elements to shuffle...
  while (currentIndex !== 0) {
    // Pick a remaining element...
    let randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }
}

type EvaluationResult = FimExample["parameters"] & {
  match: boolean;
  timeMs: number;
};

export class PerformanceEvaluationService {
  constructor(
    private config: ConfigContainer,
    private llmClient: LlmClient,
    private completionFilterService: CompletionFilterService,
    private logManager: LogManager,
    private dataExtractionService: DataExtractionService
  ) {}
  async evaluate(
    progress: vscode.Progress<{
      message?: string;
      increment?: number;
    }>,
    vsToken: vscode.CancellationToken
  ) {
    const data = await this.dataExtractionService.extractData();
    const totalExampleCount = Math.min(
      100 * 1 * 1 * 5 * 2,
      data.map((x) => x.examples.length).reduce((a, b) => a + b, 0)
    );
    let remainingCount = totalExampleCount;
    console.log("Remaining count: " + remainingCount);

    for (const { folder, examples } of data) {
      if (remainingCount <= 0) {
        break;
      }
      progress.report({ message: `Processing ${folder.name}` });
      // shuffle examples
      shuffle(examples);

      const results: EvaluationResult[] = [];
      exampleLoop: for (const example of examples) {
        const expected = PerformanceEvaluationService.getCompletion(
          example.completion
        );

        let attempt = 0;
        while (true) {
          if (vsToken.isCancellationRequested) {
            break;
          }
          const startTime = Date.now();
          const token = new CancellationTokenOwner();
          const subscription = vsToken.onCancellationRequested(() =>
            token.cancel()
          );

          try {
            let chars = await this.llmClient.getCompletion(
              {
                requestDescription: "evaluate",
                language: example.language,
                fileName: example.fileName,
                prefix: example.prefix,
                suffix: example.suffix,
              },
              token
            );
            let actual = "";
            for await (const char of chars) {
              if (actual.length > expected.length) {
                token.cancel();
              }
              actual += char;
            }

            console.log(
              `${example.prefix}<|FIM|>${example.completion}<|/FIM|>${example.suffix}}`
            );
            const isMatch = actual.startsWith(expected);

            console.log(
              `Params: ${JSON.stringify(
                example.parameters
              )}\nExpected: ${expected}\nActual  : ${actual}\nMatch:${isMatch}`
            );

            results.push({
              ...example.parameters,
              match: isMatch,
              timeMs: Date.now() - startTime,
            });
            break;
          } catch (e) {
            console.log("Failed to evaluate the command", e);
            if (attempt++ > 3) {
              console.log("stopping due to error");
              break;
            }
          } finally {
            subscription.dispose();
            progress.report({ increment: 100 / totalExampleCount });
            remainingCount--;
            if (remainingCount <= 0) {
              break exampleLoop;
            }
          }
        }
      }
      await vscode.workspace.fs.writeFile(
        folder.uri.with({ path: folder.uri.path + "/results.json" }),
        new TextEncoder().encode(JSON.stringify(results, undefined, 2))
      );

      await vscode.workspace.fs.writeFile(
        folder.uri.with({ path: folder.uri.path + "/results.csv" }),
        new TextEncoder().encode(
          `category, prefix, suffix, completion, match\n` +
            results
              .map(
                (d) =>
                  `${d.category},${d.prefixSize},${d.suffixSize},${
                    d.completionSize
                  },${d.match ? 1 : 0}`
              )
              .join("\n")
        )
      );
    }
  }

  static getCompletion(generated: string) {
    const match = generated.match(/^\s*\w*[^\w]*/g);
    return match === null ? generated : match[0];
  }
}
