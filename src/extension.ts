import * as vscode from 'vscode';

const { io } = require('socket.io-client');

let socket: any = null;
let isApplyingRemoteChange = false;
let docSyncDisposable: vscode.Disposable | null = null;
let myUsername = '';
let myUserId = '';

export function activate(context: vscode.ExtensionContext) {

  // ✅ Set User ID & Username
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.setUser', async () => {

      const userId = await vscode.window.showInputBox({
        prompt: '🪪 Masukkan ID kamu (bebas, unik)',
        placeHolder: 'Contoh: budi123, sari_dev, john99',
        validateInput: (val) => {
          if (val.trim() === '') return 'ID tidak boleh kosong!';
          if (val.includes(' ')) return 'ID tidak boleh mengandung spasi!';
          if (val.length < 3) return 'ID minimal 3 karakter!';
          return null;
        }
      });
      if (!userId) return;

      const username = await vscode.window.showInputBox({
        prompt: '👤 Masukkan nama tampilan kamu',
        placeHolder: 'Contoh: Budi, Sari, John...',
        validateInput: (val) => val.trim() === '' ? 'Nama tidak boleh kosong!' : null
      });
      if (!username) return;

      myUserId = userId.trim();
      myUsername = username.trim();

      // Simpan ke VS Code storage supaya tidak perlu input ulang
      context.globalState.update('collab.userId', myUserId);
      context.globalState.update('collab.username', myUsername);

      vscode.window.showInformationMessage(
        `✅ ID: ${myUserId} | Nama: ${myUsername} tersimpan!`
      );
    })
  );

  // ✅ Start Session (jadi host)
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.startSession', async () => {

      // Load dari storage kalau sudah pernah set
      myUserId = context.globalState.get('collab.userId', '');
      myUsername = context.globalState.get('collab.username', '');

      // Kalau belum set, minta input dulu
      if (!myUserId || !myUsername) {
        const userId = await vscode.window.showInputBox({
          prompt: '🪪 Masukkan ID kamu',
          placeHolder: 'Contoh: budi123',
          validateInput: (val) => {
            if (val.trim() === '') return 'ID tidak boleh kosong!';
            if (val.includes(' ')) return 'ID tidak boleh mengandung spasi!';
            if (val.length < 3) return 'ID minimal 3 karakter!';
            return null;
          }
        });
        if (!userId) return;

        const username = await vscode.window.showInputBox({
          prompt: '👤 Masukkan nama tampilan kamu',
          placeHolder: 'Contoh: Budi, Sari...',
          validateInput: (val) => val.trim() === '' ? 'Nama tidak boleh kosong!' : null
        });
        if (!username) return;

        myUserId = userId.trim();
        myUsername = username.trim();
        context.globalState.update('collab.userId', myUserId);
        context.globalState.update('collab.username', myUsername);
      }

      const serverUrl = await vscode.window.showInputBox({
        prompt: '🌐 URL Server',
        value: 'http://localhost:3000',
      });
      if (!serverUrl) return;

      socket = io(serverUrl);

      socket.on('connect', () => {
        socket.emit('create-room', { userId: myUserId, username: myUsername },
          (roomId: string) => {
            showRoomId(roomId);
            vscode.window.showInformationMessage(
              `🚀 Halo ${myUsername} (${myUserId})! Session ID: ${roomId}`,
              'Copy ID'
            ).then(action => {
              if (action === 'Copy ID') {
                vscode.env.clipboard.writeText(roomId);
                vscode.window.showInformationMessage('📋 ID berhasil dicopy!');
              }
            });
          }
        );
      });

      socket.on('room-created', (roomId: string) => {
        showRoomId(roomId);
      });

      socket.on('text-change', (data: any) => {
        applyRemoteChange(data);
      });

      socket.on('user-joined', (data: any) => {
        vscode.window.showInformationMessage(
          `👤 ${data.username} (${data.userId}) bergabung!`
        );
      });

      socket.on('user-left', (data: any) => {
        vscode.window.showInformationMessage(
          `👋 ${data.username} (${data.userId}) keluar.`
        );
      });

      setupDocumentSync();
    })
  );

  // ✅ Join Session (jadi member)
  context.subscriptions.push(
  vscode.commands.registerCommand('collab.joinSession', async () => {

    // Load user dari storage
    myUserId = context.globalState.get('collab.userId', '');
    myUsername = context.globalState.get('collab.username', '');

    // Kalau belum set, minta input
    if (!myUserId || !myUsername) {
      const userId = await vscode.window.showInputBox({
        prompt: '🪪 Masukkan ID kamu',
        placeHolder: 'Contoh: budi123',
        validateInput: (val) => {
          if (val.trim() === '') return 'ID tidak boleh kosong!';
          if (val.includes(' ')) return 'ID tidak boleh mengandung spasi!';
          if (val.length < 3) return 'ID minimal 3 karakter!';
          return null;
        }
      });
      if (!userId) return;

      const username = await vscode.window.showInputBox({
        prompt: '👤 Masukkan nama tampilan kamu',
        placeHolder: 'Contoh: Budi, Sari...',
        validateInput: (val) => val.trim() === '' ? 'Nama tidak boleh kosong!' : null
      });
      if (!username) return;

      myUserId = userId.trim();
      myUsername = username.trim();
      context.globalState.update('collab.userId', myUserId);
      context.globalState.update('collab.username', myUsername);
    }

    // ✅ Input URL server (bisa ganti ke IP teman)
    const serverUrl = await vscode.window.showInputBox({
      prompt: '🌐 URL Server (localhost atau IP teman)',
      value: context.globalState.get('collab.serverUrl', 'http://localhost:3000'),
      placeHolder: 'http://192.168.1.5:3000'
    });
    if (!serverUrl) return;

    // Simpan URL server untuk next time
    context.globalState.update('collab.serverUrl', serverUrl);

    // ✅ Input Session ID
    const roomId = await vscode.window.showInputBox({
      prompt: '🔑 Masukkan Session ID dari teman kamu',
      placeHolder: 'Contoh: AB12CD34',
      validateInput: (val) => val.trim() === '' ? 'Session ID tidak boleh kosong!' : null
    });
    if (!roomId) return;

    socket = io(serverUrl);

    socket.on('connect', () => {
      socket.emit('join-room', {
        roomId: roomId.toUpperCase(),
        userId: myUserId,
        username: myUsername
      });
      vscode.window.showInformationMessage(
        `✅ Halo ${myUsername} (${myUserId})! Berhasil join: ${roomId}`
      );
    });

    socket.on('connect_error', (err: any) => {
      vscode.window.showErrorMessage(
        `❌ Gagal konek ke server: ${serverUrl} — ${err.message}`
      );
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
      vscode.window.showInformationMessage(
        `👤 ${data.username} (${data.userId}) bergabung!`
      );
    });

    socket.on('user-left', (data: any) => {
      vscode.window.showInformationMessage(
        `👋 ${data.username} (${data.userId}) keluar.`
      );
    });

    socket.on('error', (msg: string) => {
      vscode.window.showErrorMessage(`❌ Error: ${msg}`);
    });

    setupDocumentSync();
  }));

  // ✅ Lihat ID saya sekarang
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.myProfile', () => {
      const savedId = context.globalState.get('collab.userId', '');
      const savedName = context.globalState.get('collab.username', '');

      if (!savedId) {
        vscode.window.showInformationMessage('❌ Belum set ID. Jalankan "Set User ID"');
        return;
      }
      vscode.window.showInformationMessage(
        `🪪 ID: ${savedId} | 👤 Nama: ${savedName}`
      );
    })
  );

  // ✅ Reset ID
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.resetUser', async () => {
      await context.globalState.update('collab.userId', '');
      await context.globalState.update('collab.username', '');
      myUserId = '';
      myUsername = '';
      vscode.window.showInformationMessage('🔄 ID dan nama berhasil direset!');
    })
  );

  // ✅ Stop Session
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.stopSession', () => {
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
  if (docSyncDisposable) docSyncDisposable.dispose();

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
      socket.emit('text-change', {
        changes,
        userId: myUserId,
        username: myUsername
      });
    }
  });
}

function applyRemoteChange(data: { changes: any[] }) {
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

function showRoomId(roomId: string) {
  vscode.window.showInformationMessage(
    `🚀 Halo ${myUsername} (${myUserId})! Session ID: ${roomId}`,
    'Copy ID'
  ).then(action => {
    if (action === 'Copy ID') {
      vscode.env.clipboard.writeText(roomId);
      vscode.window.showInformationMessage('📋 ID berhasil dicopy!');
    }
  });
}

export function deactivate() {
  socket?.disconnect();
  docSyncDisposable?.dispose();
}