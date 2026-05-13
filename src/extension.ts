import * as vscode from 'vscode';
import { CollaborationClient } from './collaborationClient';

let client: CollaborationClient;

export function activate(context: vscode.ExtensionContext) {
  // Command: Start Session
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.startSession', async () => {
      const serverUrl = await vscode.window.showInputBox({
        prompt: 'Masukkan URL server',
        value: 'http://localhost:3000'
      });
      if (!serverUrl) return;

      client = new CollaborationClient(serverUrl);
      const roomId = await client.createRoom();
      vscode.window.showInformationMessage(`Session ID: ${roomId}`);
    })
  );

  // Command: Join Session
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.joinSession', async () => {
      const roomId = await vscode.window.showInputBox({
        prompt: 'Masukkan Session ID'
      });
      if (!roomId) return;

      client = new CollaborationClient('http://localhost:3000');
      await client.joinRoom(roomId);
    })
  );
}

export function deactivate() {
  client?.disconnect();
}