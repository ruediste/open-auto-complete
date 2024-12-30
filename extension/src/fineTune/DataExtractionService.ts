import ignore, { Ignore } from "ignore";
import * as vscode from "vscode";

export type FimExampleCategory = "random" | "beginningOfWord";
export interface FimExample {
  category: FimExampleCategory;
  prefix: string;
  suffix: string;
  completion: string;
}

class IgnoreContext {
  entries: { path: string; ignore: Ignore }[] = [];

  async initialize(folder: vscode.Uri) {
    // find parent .gitignore files
    let parent: vscode.Uri | undefined = folder;
    while (parent) {
      let repoRootFound = false;
      for (const [fileName, type] of await vscode.workspace.fs.readDirectory(
        parent
      )) {
        if (fileName === ".git") {
          repoRootFound = true;
        }

        if (fileName === ".gitignore") {
          this.entries.push(await this.createEntry(parent, fileName));
        }
      }
      if (repoRootFound) {
        break;
      }
      parent = getParent(parent);
    }

    this.entries.push({
      path: folder.path + "/",
      ignore: ignore().add(["/.vscode/", ".gitignore"]),
    });
  }

  async subContext(folder: vscode.Uri): Promise<IgnoreContext> {
    let result: IgnoreContext | undefined = undefined;

    for (const [fileName, type] of await vscode.workspace.fs.readDirectory(
      folder
    )) {
      if (fileName === ".gitignore") {
        if (result === undefined) {
          result = new IgnoreContext();
          result.entries = [...this.entries];
        }
        result.entries.push(await this.createEntry(folder, fileName));
      }
    }

    return result ?? this;
  }

  private async createEntry(folder: vscode.Uri, fileName: string) {
    return {
      path: folder.path + "/",
      ignore: ignore().add(
        new TextDecoder().decode(
          await vscode.workspace.fs.readFile(
            folder.with({ path: folder.path + "/" + fileName })
          )
        )
      ),
    };
  }

  ignores(file: vscode.Uri) {
    for (const entry of this.entries) {
      if (!file.path.startsWith(entry.path)) {
        continue;
      }
      const path = file.path.substring(entry.path.length);
      if (entry.ignore.ignores(path)) {
        return true;
      }
    }
    return false;
  }
}

function getParent(uri: vscode.Uri): vscode.Uri | undefined {
  const idx = uri.path.lastIndexOf("/");
  if (idx === -1) {
    // No parent
    return undefined;
  }
  return uri.with({ path: uri.path.substring(0, idx) });
}

function randomIntFromInterval(minInclusive: number, maxExclusive: number) {
  return Math.floor(
    Math.random() * (maxExclusive - minInclusive) + minInclusive
  );
}

export class DataExtractionService {
  constructor(private channel: vscode.LogOutputChannel) {}

  async extractAndSaveData() {
    const data = await this.extractData();
    this.saveData(data);
  }

  async saveData(
    data: { folder: vscode.WorkspaceFolder; examples: FimExample[] }[]
  ) {
    for (const { folder, examples } of data) {
      await vscode.workspace.fs.writeFile(
        folder.uri.with({ path: folder.uri.path + "/training.json" }),
        new TextEncoder().encode(JSON.stringify(examples, undefined, 2))
      );
    }
  }

  async extractData() {
    const data: { folder: vscode.WorkspaceFolder; examples: FimExample[] }[] =
      [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const examples: FimExample[] = [];
      this.channel.info?.(`Processing workspace folder: ${folder.uri.fsPath}`);

      const ig = new IgnoreContext();
      await ig.initialize(folder.uri);
      await this.processDirectory(folder.uri, ig, examples);

      data.push({ folder, examples });
    }
    return data;
  }

  private async processDirectory(
    dir: vscode.Uri,
    ig: IgnoreContext,
    examples: FimExample[]
  ) {
    this.channel.info?.(`Processing directory :${dir.path}`);
    for (const [fileName, type] of await vscode.workspace.fs.readDirectory(
      dir
    )) {
      const uri = dir.with({ path: dir.path + "/" + fileName });
      if (ig.ignores(uri)) {
        this.channel.info?.(`Ignoring ${uri.path}`);
        continue;
      }

      if ((type & vscode.FileType.Directory) !== 0) {
        await this.processDirectory(uri, await ig.subContext(uri), examples);
      }
      if ((type & vscode.FileType.File) !== 0) {
        if (uri.path.endsWith(".ts") || uri.path.endsWith(".cs")) {
          this.channel.info?.(`Processing file :${uri.path}`);
          await this.extractExamples(
            await new TextDecoder().decode(
              await vscode.workspace.fs.readFile(uri)
            ),
            examples
          );
        }
      }
    }
  }

  private async extractExamples(text: string, examples: FimExample[]) {
    const lines = text.split(/\r\n|\n/);

    // random
    {
      const chunkSize = 400;
      for (let baseIdx = 0; baseIdx < text.length; baseIdx += chunkSize) {
        for (const prefixSize of [100, 200, 400]) {
          for (const suffixSize of [100, 200, 400]) {
            for (const completionSize of [10, 40, 100, 200]) {
              const addExample = (
                split: number,
                category: FimExampleCategory
              ) => {
                const example = {
                  category: category,
                  prefix: text.substring(
                    Math.max(0, split - prefixSize),
                    split
                  ),
                  suffix: text.substring(
                    split + completionSize,
                    split + completionSize + suffixSize
                  ),
                  completion: text.substring(split, split + completionSize),
                };
                examples.push(example);
              };

              addExample(
                randomIntFromInterval(
                  baseIdx,
                  Math.min(text.length, baseIdx + chunkSize)
                ),
                "random"
              );
              const wordRegex = /(?<!\w)\w+/g;
              const searchStart = randomIntFromInterval(
                baseIdx,
                Math.min(text.length, baseIdx + chunkSize)
              );
              const match = wordRegex.exec(text.substring(searchStart));
              if (match !== null) {
                addExample(searchStart + match.index, "beginningOfWord");
              }
            }
          }
        }
      }
    }
  }
}
