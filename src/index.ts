import { commands, ExtensionContext, LanguageClientOptions, ServerOptions, services, workspace } from 'coc.nvim';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FoldingRange, WorkDoneProgressCancelNotification } from 'vscode-languageserver-protocol';
import which from 'which';
import { BuildStatus, ForwardSearchStatus, LatexLanguageClient } from './client';
import { Commands, Selectors } from './constants';
import { downloadServer } from './downloader';

export async function activate(context: ExtensionContext): Promise<void> {
  const serverRoot = context.storagePath;
  if (!fs.existsSync(serverRoot)) {
    fs.mkdirSync(serverRoot);
  }

  const bin = os.platform() === 'win32' ? 'texlab.exe' : 'texlab';
  let serverPath = path.join(serverRoot, bin);

  const custom = workspace.getConfiguration('texlab').get('path') as string;
  if (custom && fs.existsSync(custom)) {
    serverPath = custom;
  }

  if (!fs.existsSync(serverPath)) {
    const first = which.sync(bin, { nothrow: true });
    if (first) {
      serverPath = first;
    } else {
      workspace.showMessage(`TexLab Server is not found, downloading...`);
      try {
        await downloadServer(serverRoot);
      } catch (e) {
        if (fs.existsSync(serverPath)) fs.unlinkSync(serverPath);
        workspace.showMessage(`Download TexLab Server failed`, 'error');
        console.error(e);
        return;
      }
    }
  }

  const outputChannel = workspace.createOutputChannel('TexLab');
  const serverOptions = getServerOptions(serverPath);
  const clientOptions: LanguageClientOptions = {
    documentSelector: Selectors,
    outputChannel,
    synchronize: {
      configurationSection: 'latex'
    },
    initializationOptions: {
      settings: { latex: workspace.getConfiguration('latex') }
    },
    middleware: {
      provideFoldingRanges: async (document, context, token, next) => {
        const ranges = (await next(document, context, token)) as FoldingRange[];
        return ranges.reverse();
      }
    }
  };

  const client = new LatexLanguageClient('TexLab', serverOptions, clientOptions);

  context.subscriptions.push(services.registLanguageClient(client));
  context.subscriptions.push(
    commands.registerCommand(Commands.BUILD, async () => {
      const doc = await workspace.document;
      if (workspace.match(Selectors, doc.textDocument) <= 0) {
        return;
      }

      outputChannel.clear();
      workspace.showMessage(`Build started`);

      const result = await client.build(doc);
      if (!result) {
        return;
      }

      switch (result.status) {
        case BuildStatus.Success:
          workspace.showMessage(`Build success`);
          break;
        case BuildStatus.Cancelled:
          workspace.showMessage(`Build cancelled`);
          break;
        case BuildStatus.Error:
          workspace.showMessage(`Build failed: build process terminated with errors`, 'error');
          break;
        case BuildStatus.Failure:
          workspace.showMessage(`Build failed: build process failed to start or crashed`, 'error');
          break;
      }
    }),

    commands.registerCommand(Commands.BUILD_CANCEL, () => {
      client.sendNotification(WorkDoneProgressCancelNotification.type.method, {
        token: 'texlab-build-*'
      });
    }),

    commands.registerCommand(Commands.FORWARD_SEARCH, async () => {
      const doc = await workspace.document;
      if (workspace.match(Selectors, doc.textDocument) <= 0) {
        return;
      }

      outputChannel.clear();
      const position = await workspace.getCursorPosition();
      const result = await client.forwardSearch(doc, position);
      switch (result.status) {
        case ForwardSearchStatus.Success:
          workspace.showMessage(`Preview success`);
          break;
        case ForwardSearchStatus.Error:
          workspace.showMessage(`Preview failed: previewer process executed the command with errors`, 'error');
          break;
        case ForwardSearchStatus.Failure:
          workspace.showMessage(`Preview failed: previewer process failed to start or crashed`, 'error');
          break;
        case ForwardSearchStatus.Unconfigured:
          workspace.showMessage(`Preview failed: previewer command is not configured`, 'warning');
          break;
      }
    }),

    commands.registerCommand(Commands.UPDATE_LANGUAGE_SERVER, async () => {
      await client.stop();
      try {
        await downloadServer(serverRoot);
      } catch (e) {
        if (fs.existsSync(serverPath)) fs.unlinkSync(serverPath);
        workspace.showMessage(`Update TexLab Server failed, please try again`);
        console.error(e);
        return;
      }
      client.start();
    })
  );

  client.onReady().then(() => {
    workspace.showMessage(`TexLab Server Started`);
  });
}

function getServerOptions(serverPath: string): ServerOptions {
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  return {
    run: {
      command: serverPath,
      options: {
        env
      }
    },
    debug: {
      command: serverPath,
      args: ['-vvvv'],
      options: {
        env: {
          ...env,
          RUST_BACKTRACE: '1'
        }
      }
    }
  };
}
