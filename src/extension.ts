import * as vscode from 'vscode';

const { io } = require('socket.io-client');

let socket: any = null;
let isApplyingRemoteChange = false;
let docSyncDisposable: vscode.Disposable | null = null;
let myUsername = 'User'; // ✅ Simpan username global

export function activate(context: vscode.ExtensionContext) {

  // ✅ Start Session (jadi host)
  context.subscriptions.push(
    vscode.commands.registerCommand('live-collaboration.startSession', async () => {

      // Input username dulu
      const username = await vscode.window.showInputBox({
        prompt: 'Masukkan nama kamu',
        placeHolder: 'Contoh: Budi, Sari, John...',
        validateInput: (val) => val.trim() === '' ? 'Nama tidak boleh kosong!' : null
      });
      if (!username) return;
      myUsername = username.trim();

      const serverUrl = await vscode.window.showInputBox({
        prompt: 'URL Server',
        value: 'http://localhost:3000',
      });
      if (!serverUrl) return;

      socket = io(serverUrl);

      socket.on('connect', () => {
        socket.emit('create-room', (roomId: string) => {
          vscode.window.showInformationMessage(
            `✅ Halo ${myUsername}! Session ID: ${roomId}`,
            'Copy ID'
          ).then(action => {
            if (action === 'Copy ID') {
              vscode.env.clipboard.writeText(roomId);
              vscode.window.showInformationMessage('📋 ID berhasil dicopy!');
            }
          });
        });
      });

      socket.on('text-change', (data: any) => {
        applyRemoteChange(data);
      });

      socket.on('user-joined', (data: any) => {
        vscode.window.showInformationMessage(`👤 ${data.username || 'User'} bergabung!`);
      });

      socket.on('user-left', (data: any) => {
        vscode.window.showInformationMessage(`👋 ${data.username || 'User'} keluar.`);
      });

      setupDocumentSync();
    })
  );

  // ✅ Join Session (jadi member)
  context.subscriptions.push(
    vscode.commands.registerCommand('live-collaboration.joinSession', async () => {

      // Input username dulu
      const username = await vscode.window.showInputBox({
        prompt: 'Masukkan nama kamu',
        placeHolder: 'Contoh: Budi, Sari, John...',
        validateInput: (val) => val.trim() === '' ? 'Nama tidak boleh kosong!' : null
      });
      if (!username) return;
      myUsername = username.trim();

      // Input Session ID
      const roomId = await vscode.window.showInputBox({
        prompt: 'Masukkan Session ID dari teman kamu',
        placeHolder: 'Contoh: AB12CD34',
        validateInput: (val) => val.trim() === '' ? 'Session ID tidak boleh kosong!' : null
      });
      if (!roomId) return;

      socket = io('http://localhost:3000');

      socket.on('connect', () => {
        // Kirim username saat join
        socket.emit('join-room', { roomId: roomId.toUpperCase(), username: myUsername });
        vscode.window.showInformationMessage(`✅ Halo ${myUsername}! Berhasil join room: ${roomId}`);
      });

      socket.on('init-document', (content: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !content) return;

        isApplyingRemoteChange = true;
        editor.edit(editBuilder => {
          const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
          );
          editBuilder.replace(fullRange, content);
        }).then(() => { isApplyingRemoteChange = false; });
      });

      socket.on('text-change', (data: any) => {
        applyRemoteChange(data);
      });

      socket.on('user-joined', (data: any) => {
        vscode.window.showInformationMessage(`👤 ${data.username || 'User'} bergabung!`);
      });

      socket.on('user-left', (data: any) => {
        vscode.window.showInformationMessage(`👋 ${data.username || 'User'} keluar.`);
      });

      setupDocumentSync();
    })
  );

  // ✅ Stop Session
  context.subscriptions.push(
    vscode.commands.registerCommand('live-collaboration.stopSession', () => {
      if (socket) {
        socket.disconnect();
        socket = null;
      }
      if (docSyncDisposable) {
        docSyncDisposable.dispose();
        docSyncDisposable = null;
      }
      vscode.window.showInformationMessage('❌ Session dihentikan.');
    })
  );
}

function setupDocumentSync() {
  if (docSyncDisposable) {
    docSyncDisposable.dispose();
  }

  docSyncDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    if (isApplyingRemoteChange) return;
    if (!socket) return;

    const changes = event.contentChanges.map(change => ({
      text: change.text,
      startLine: change.range.start.line,
      startChar: change.range.start.character,
      endLine: change.range.end.line,
      endChar: change.range.end.character,
    }));

    if (changes.length > 0) {
      socket.emit('text-change', { changes, username: myUsername });
    }
  });
}

function applyRemoteChange(data: { changes: any[], username?: string }) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  isApplyingRemoteChange = true;
  editor.edit(editBuilder => {
    data.changes.forEach((change: any) => {
      const range = new vscode.Range(
        change.startLine, change.startChar,
        change.endLine, change.endChar
      );
      editBuilder.replace(range, change.text);
    });
  }).then(() => { isApplyingRemoteChange = false; });
}

export function deactivate() {
  socket?.disconnect();
  docSyncDisposable?.dispose();
}