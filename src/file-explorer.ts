import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as fileHandler from './utils/file-handler';
import { FileStat } from './utils/file-stat';

interface Entry {
  uri: vscode.Uri;
  type: vscode.FileType;
}

class FileSystemProvider implements vscode.TreeDataProvider<Entry>, vscode.FileSystemProvider {

  private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]>;

  constructor() {
    this._onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  }

  get onDidChangeFile(): vscode.Event<vscode.FileChangeEvent[]> {
    return this._onDidChangeFile.event;
  }

  watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    const watcher = fs.watch(uri.fsPath, { recursive: options.recursive }, async (event: string, filename: string | Buffer) => {
      const filepath = path.join(uri.fsPath, fileHandler.normalizeNFC(filename.toString()));

      // TODO support excludes (using minimatch library?)

      this._onDidChangeFile.fire([{
        type: event === 'change' ? vscode.FileChangeType.Changed : await fileHandler.exists(filepath) ? vscode.FileChangeType.Created : vscode.FileChangeType.Deleted,
        uri: uri.with({ path: filepath })
      } as vscode.FileChangeEvent]);
    });

    return { dispose: () => watcher.close() };
  }

  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    return this._stat(uri.fsPath);
  }

  async _stat(path: string): Promise<vscode.FileStat> {
    return new FileStat(await fileHandler.stat(path));
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
    return this._readDirectory(uri);
  }

  async _readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const children = await fileHandler.readdir(uri.fsPath);

    const result: [string, vscode.FileType][] = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const stat = await this._stat(path.join(uri.fsPath, child));
      result.push([child, stat.type]);
    }

    return Promise.resolve(result);
  }

  createDirectory(uri: vscode.Uri): void | Thenable<void> {
    return fileHandler.mkdir(uri.fsPath);
  }

  readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
    return fileHandler.readfile(uri.fsPath);
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): void | Thenable<void> {
    return this._writeFile(uri, content, options);
  }

  async _writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
    const exists = await fileHandler.exists(uri.fsPath);
    if (!exists) {
      if (!options.create) {
        throw vscode.FileSystemError.FileNotFound();
      }

      await fileHandler.mkdir(path.dirname(uri.fsPath));
    } else {
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists();
      }
    }

    return fileHandler.writefile(uri.fsPath, content as Buffer);
  }

  delete(uri: vscode.Uri, options: { recursive: boolean; }): void | Thenable<void> {
    if (options.recursive) {
      return fileHandler.rmrf(uri.fsPath);
    }

    return fileHandler.unlink(uri.fsPath);
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): void | Thenable<void> {
    return this._rename(oldUri, newUri, options);
  }

  async _rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
    const exists = await fileHandler.exists(newUri.fsPath);
    if (exists) {
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists();
      } else {
        await fileHandler.rmrf(newUri.fsPath);
      }
    }

    const parentExists = await fileHandler.exists(path.dirname(newUri.fsPath));
    if (!parentExists) {
      await fileHandler.mkdir(path.dirname(newUri.fsPath));
    }

    return fileHandler.rename(oldUri.fsPath, newUri.fsPath);
  }

  // tree data provider

  async getChildren(element?: Entry): Promise<Entry[]> {
    if (element) {
      const children = await this.readDirectory(element.uri);
      return children.map(([name, type]) => ({ uri: vscode.Uri.file(path.join(element.uri.fsPath, name)), type }));
    }

    // read workspace dir
    const workspaceFolder = vscode.workspace.getConfiguration().get('pomeloPeel.rootDir');
    // const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.filter(folder => folder.uri.scheme === 'file')[0];

    if (workspaceFolder) {
      const workspaceUri: vscode.Uri = vscode.Uri.parse(workspaceFolder.toString());
      const children = await this.readDirectory(workspaceUri);

      children.sort((a, b) => {
        if (a[1] === b[1]) {
          return a[0].localeCompare(b[0]);
        }
        return a[1] === vscode.FileType.Directory ? -1 : 1;
      });
      return children.map(([name, type]) => ({ uri: vscode.Uri.file(path.join(workspaceUri.fsPath, name)), type }));
    } else {
      const openDialogOptions: vscode.OpenDialogOptions = {
        canSelectFiles: false,
        canSelectFolders: true,
      };
      vscode.window.showOpenDialog(openDialogOptions).then((uris) => {
        if (uris && uris.length) {
          vscode.workspace.getConfiguration().update('pomeloPeel.rootDir', uris[0].path);
        }
      });
    }

    return [];
  }

  getTreeItem(element: Entry): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.uri, element.type === vscode.FileType.Directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    if (element.type === vscode.FileType.File) {
      treeItem.command = { command: 'pomeloPeel.openFile', title: "Open File", arguments: [element.uri], };
      treeItem.contextValue = 'file';
    }
    return treeItem;
  }
}

export class FileExplorer {

  private fileExplorer: vscode.TreeView<Entry>;

  constructor(context: vscode.ExtensionContext) {
    const treeDataProvider = new FileSystemProvider();
    this.fileExplorer = vscode.window.createTreeView('pomeloPeelDefault', { treeDataProvider });
    vscode.commands.registerCommand('pomeloPeel.openFile', (resource) => this.openResource(resource));
  }

  private openResource(resource: vscode.Uri): void {
    vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups').then(() => {
      vscode.window.showTextDocument(resource, { preview: false }).then(() => {
        vscode.commands.executeCommand('markdown.showPreviewToSide').then(() => { }, error => {
          console.error(error);
        });
      });
    });
  }
}