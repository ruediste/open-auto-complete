import * as vscode from "vscode";
import { CompletionFilterService } from "../core/completionFilterService";
import { CancellationTokenOwner } from "../core/completionManager";
import { ConfigContainer } from "../core/configuration";
import { LlmClient } from "../core/llmClient";
import { LogManager } from "../core/logger";
import {
  DataExtractionService,
  FimExampleCategory,
} from "./DataExtractionService";
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

interface EvaluationResult {
  category: FimExampleCategory;
  prefixSize: number;
  suffixSize: number;
  completionSize: number;
  match: boolean;
}

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
    this.dataExtractionService.saveData(data);
    const results: EvaluationResult[] = [];
    let count = 0;
    const totalExampleCount = Math.min(
      300,
      data.map((x) => x.examples.length).reduce((a, b) => a + b, 0)
    );

    for (const { folder, examples } of data) {
      progress.report({ message: `Processing ${folder.name}` });
      // shuffle examples
      shuffle(examples);
      for (const example of examples) {
        if (count++ >= totalExampleCount) {
          break;
        }
        progress.report({ increment: 100 / totalExampleCount });
        const match = example.completion.match(/^\s*\w*[^\w]*/g);
        const expected = match === null ? example.completion : match[0];

        let attempt = 0;
        while (true) {
          if (vsToken.isCancellationRequested) {
            break;
          }
          const token = new CancellationTokenOwner();
          const subscription = vsToken.onCancellationRequested(() =>
            token.cancel()
          );
          try {
            let chars = await this.llmClient.getCompletion(
              "evaluate",
              example.prefix,
              example.suffix,
              token
            );
            let actual = "";
            for await (const chunk of chars) {
              if (actual.length > expected.length) {
                token.cancel();
              }
              actual += chunk;
            }

            console.log(
              `${example.prefix}<|FIM|>${example.completion}<|/FIM|>${example.suffix}}`
            );
            const isMatch = actual.startsWith(expected);

            console.log(
              `Expected: ${expected}\nActual: ${actual}\nMatch:${isMatch}`
            );

            results.push({
              category: example.category,
              prefixSize: example.prefix.length,
              suffixSize: example.suffix.length,
              completionSize: example.completion.length,
              match: isMatch,
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
          }
        }

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
  }
}
