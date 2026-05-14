import * as vscode from 'vscode';
const { io } = require('socket.io-client');

let socket: any = null;
let isApplyingRemoteChange = false;
let docSyncDisposable: vscode.Disposable | null = null;
let myUsername = '';
let myUserId = '';
let currentRoomId = '';
let currentServerUrl = '';

export function activate(context: vscode.ExtensionContext) {

  // ✅ Set User ID & Name
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.setUser', async () => {
      const userId = await vscode.window.showInputBox({
        prompt: '🪪 Masukkan ID kamu',
        placeHolder: 'Contoh: budi123',
        validateInput: (val) => {
          if (val.trim() === '') return 'ID tidak boleh kosong!';
          if (val.includes(' ')) return 'ID tidak boleh ada spasi!';
          if (val.length < 3) return 'ID minimal 3 karakter!';
          return null;
        }
      });
      if (!userId) return;

      const username = await vscode.window.showInputBox({
        prompt: '👤 Masukkan nama kamu',
        placeHolder: 'Contoh: Budi, Sari...',
        validateInput: (val) => val.trim() === '' ? 'Nama tidak boleh kosong!' : null
      });
      if (!username) return;

      myUserId = userId.trim();
      myUsername = username.trim();
      context.globalState.update('collab.userId', myUserId);
      context.globalState.update('collab.username', myUsername);

      vscode.window.showInformationMessage(
        `✅ ID: ${myUserId} | Nama: ${myUsername} tersimpan!`
      );
    })
  );

  // ✅ Start Session
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.startSession', async () => {

      myUserId = context.globalState.get('collab.userId', '');
      myUsername = context.globalState.get('collab.username', '');

      if (!myUserId || !myUsername) {
        vscode.window.showErrorMessage('❌ Set ID dulu! Jalankan "Set User ID & Name"');
        return;
      }

      const serverUrl = await vscode.window.showInputBox({
        prompt: '🌐 URL Server',
        value: context.globalState.get('collab.serverUrl', 'http://localhost:3000'),
        placeHolder: 'https://nama-app.up.railway.app'
      });
      if (!serverUrl) return;

      context.globalState.update('collab.serverUrl', serverUrl);
      currentServerUrl = serverUrl;

      // Koneksikan socket
      connectSocket(serverUrl);

      const emitCreate = () => {
        if (!socket) return;
        socket.emit(
          'create-room',
          { userId: myUserId, username: myUsername },
          (roomId: string) => {
            currentRoomId = roomId;
            context.globalState.update('collab.lastRoomId', roomId);

            vscode.window.showInformationMessage(
              `🚀 Session dimulai! ID: ${roomId}`,
              'Copy ID'
            ).then(action => {
              if (action === 'Copy ID') {
                vscode.env.clipboard.writeText(roomId);
                vscode.window.showInformationMessage('📋 ID berhasil dicopy!');
              }
            });
          }
        );
      };
      if (socket.connected) {
        emitCreate();
      } else {
        socket.once('connect', emitCreate);
      }

      // Terima perubahan dari user lain
      socket.on('text-change', (data: any) => {
        applyRemoteChange(data);
      });

      socket.on('user-joined', (data: any) => {
        vscode.window.showInformationMessage(
          `👤 ${data.username} (${data.userId}) bergabung!`
        );
        // Kirim isi dokumen saat ini ke user baru
        sendCurrentDocument();
      });

      socket.on('user-left', (data: any) => {
        vscode.window.showInformationMessage(
          `👋 ${data.username} keluar.`
        );
      });

      socket.on('connect_error', (err: any) => {
        vscode.window.showErrorMessage(`❌ Gagal konek: ${err.message}`);
      });

      socket.on('room-created', (roomId: string) => {
        currentRoomId = roomId;
      });

      setupDocumentSync();
    })
  );

  // ✅ Join Session
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.joinSession', async () => {

      myUserId = context.globalState.get('collab.userId', '');
      myUsername = context.globalState.get('collab.username', '');

      if (!myUserId || !myUsername) {
        vscode.window.showErrorMessage('❌ Set ID dulu! Jalankan "Set User ID & Name"');
        return;
      }

      const serverUrl = await vscode.window.showInputBox({
        prompt: '🌐 URL Server',
        value: context.globalState.get('collab.serverUrl', 'http://localhost:3000'),
        placeHolder: 'https://nama-app.up.railway.app'
      });
      if (!serverUrl) return;
      context.globalState.update('collab.serverUrl', serverUrl);
      currentServerUrl = serverUrl;

      const roomId = await vscode.window.showInputBox({
        prompt: '🔑 Masukkan Session ID',
        placeHolder: 'Contoh: AB12CD34',
        validateInput: (val) => val.trim() === '' ? 'Session ID tidak boleh kosong!' : null
      });
      if (!roomId) return;
      currentRoomId = roomId.trim().toUpperCase().replace(/-/g, '');

      // Koneksikan socket
      connectSocket(serverUrl);

      const emitJoin = () => {
        if (!socket || !currentRoomId) return;
        socket.emit('join-room', {
          roomId: currentRoomId,
          userId: myUserId,
          username: myUsername,
        });
        vscode.window.showInformationMessage(
          `✅ Halo ${myUsername}! Bergabung ke room: ${currentRoomId}`
        );
      };
      // Jangan hanya .on('connect'): kalau sudah connected, event bisa terlewat → server tidak pernah dapat join-room
      if (socket.connected) {
        emitJoin();
      } else {
        socket.once('connect', emitJoin);
      }

      // Terima dokumen awal dari host
      socket.on('init-document', (content: string) => {
        if (!content) return;
        applyFullDocument(content);
      });

      // Terima perubahan realtime
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
          `👋 ${data.username} keluar.`
        );
      });

      socket.on('connect_error', (err: any) => {
        vscode.window.showErrorMessage(
          `❌ Gagal konek ke ${serverUrl}: ${err.message}`
        );
      });

      socket.on('error', (msg: string) => {
        vscode.window.showErrorMessage(`❌ Error: ${msg}`);
      });

      setupDocumentSync();
    })
  );

  // ✅ My Profile
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.myProfile', () => {
      const savedId = context.globalState.get('collab.userId', '');
      const savedName = context.globalState.get('collab.username', '');
      if (!savedId) {
        vscode.window.showInformationMessage('❌ Belum set ID.');
        return;
      }
      vscode.window.showInformationMessage(
        `🪪 ID: ${savedId} | 👤 Nama: ${savedName}`
      );
    })
  );

  // ✅ Reset User
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.resetUser', async () => {
      await context.globalState.update('collab.userId', '');
      await context.globalState.update('collab.username', '');
      myUserId = '';
      myUsername = '';
      vscode.window.showInformationMessage('🔄 ID dan nama direset!');
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
      currentRoomId = '';
      vscode.window.showInformationMessage('❌ Session dihentikan.');
    })
  );
}

// ─────────────────────────────────────────
// SOCKET CONNECTION
// ─────────────────────────────────────────

function connectSocket(serverUrl: string) {
  // Putuskan socket lama kalau ada
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  socket = io(serverUrl, {
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    transports: ['websocket', 'polling'],
  });

  socket.on('reconnect', (attempt: number) => {
    vscode.window.showInformationMessage(
      `🔄 Reconnected! (percobaan ke-${attempt})`
    );
    // Masuk kembali ke room
    if (currentRoomId) {
      socket.emit('reconnect-room', {
        roomId: currentRoomId,
        userId: myUserId,
        username: myUsername,
      });
    }
  });

  socket.on('reconnect_attempt', (attempt: number) => {
    vscode.window.showWarningMessage(
      `⚠️ Reconnecting... (${attempt}/10)`
    );
  });

  socket.on('reconnect_failed', () => {
    vscode.window.showErrorMessage(
      '❌ Gagal reconnect! Coba join ulang.'
    );
  });
}

// ─────────────────────────────────────────
// DOCUMENT SYNC
// ─────────────────────────────────────────

function setupDocumentSync() {
  if (docSyncDisposable) {
    docSyncDisposable.dispose();
  }

  docSyncDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    // Skip kalau perubahan dari remote (hindari loop)
    if (isApplyingRemoteChange) return;
    if (!socket) return;
    if (!socket.connected) return;

    // Skip dokumen yang bukan file biasa
    if (event.document.uri.scheme !== 'file') return;

    const changes = event.contentChanges.map(change => ({
      text: change.text,
      startLine: change.range.start.line,
      startChar: change.range.start.character,
      endLine: change.range.end.line,
      endChar: change.range.end.character,
      rangeLength: change.rangeLength,
    }));

    if (changes.length === 0) return;

    // Kirim perubahan ke server
    socket.emit('text-change', {
      changes,
      userId: myUserId,
      username: myUsername,
      fileName: event.document.fileName,
      fullContent: event.document.getText(), // ✅ Kirim full content sebagai backup
      version: event.document.version,
    });
  });
}

// Terapkan perubahan kecil dari remote
function applyRemoteChange(data: {
  changes: any[];
  userId?: string;
  username?: string;
  fullContent?: string;
  version?: number;
}) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  // Kalau ada fullContent, pakai sebagai fallback
  if (data.fullContent !== undefined) {
    const currentContent = editor.document.getText();

    // Skip kalau konten sama persis
    if (currentContent === data.fullContent) return;
  }

  isApplyingRemoteChange = true;

  editor.edit(editBuilder => {
    data.changes.forEach((change: any) => {
      const start = new vscode.Position(change.startLine, change.startChar);
      const end = new vscode.Position(change.endLine, change.endChar);
      const range = new vscode.Range(start, end);
      editBuilder.replace(range, change.text);
    });
  }).then(success => {
    isApplyingRemoteChange = false;

    if (!success && data.fullContent) {
      // Kalau edit gagal, pakai full document sync
      applyFullDocument(data.fullContent);
    }
  });
}

// Terapkan full dokumen (untuk init atau fallback)
function applyFullDocument(content: string) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const currentContent = editor.document.getText();
  if (currentContent === content) return;

  isApplyingRemoteChange = true;
  editor.edit(editBuilder => {
    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(currentContent.length)
    );
    editBuilder.replace(fullRange, content);
  }).then(() => {
    isApplyingRemoteChange = false;
  });
}

// Kirim isi dokumen saat ini ke user yang baru join
function sendCurrentDocument() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !socket) return;

  const content = editor.document.getText();
  if (!content) return;

  socket.emit('sync-document', {
    content,
    userId: myUserId,
    username: myUsername,
  });
}

export function deactivate() {
  socket?.disconnect();
  docSyncDisposable?.dispose();
}