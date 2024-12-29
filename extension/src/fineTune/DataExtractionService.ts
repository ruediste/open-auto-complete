import ignore, { Ignore } from "ignore";
import * as vscode from "vscode";

export interface FimExample {
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

export class DataExtractionService {
  constructor(private channel: vscode.LogOutputChannel) {}
  async extractData() {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.channel.info?.(`Processing workspace folder: ${folder.uri.fsPath}`);

      const examples: FimExample[] = [];
      const ig = new IgnoreContext();
      await ig.initialize(folder.uri);
      await this.processDirectory(folder.uri, ig, examples);

      await vscode.workspace.fs.writeFile(
        folder.uri.with({ path: folder.uri.path + "/training.json" }),
        new TextEncoder().encode(JSON.stringify(examples))
      );
    }
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

  private async extractExamples(text: string, examples: FimExample[]) {
    const lines = text.split(/\r\n|\n/);
    for (let i = 0; i < lines.length - 2; i++) {
      const prefix = lines[i];
      const completion = lines[i + 1];
      const suffix = lines[i + 2];
      examples.push({
        prefix,
        completion,
        suffix,
      });
    }
  }
}
