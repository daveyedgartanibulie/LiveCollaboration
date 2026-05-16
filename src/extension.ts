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
      // Cek workspace folder dulu
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        const action = await vscode.window.showWarningMessage(
          '📁 Buka folder project dulu sebelum start session!',
          'Buka Folder'
        );
        if (action === 'Buka Folder') {
          await vscode.commands.executeCommand('vscode.openFolder');
        }
        return;
      }

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

      if (!socket) {
        vscode.window.showErrorMessage('❌ Gagal membuat koneksi socket!');
        return;
      }

      const emitCreate = () => {
        if (!socket) return;
        socket.emit(
          'create-room',
          { userId: myUserId, username: myUsername },
          async (roomId: string) => {
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

            // ✅ FIX: Otomatis kirim semua file project ke server
            // Agar saat User B join, server sudah punya data file
            await sendAllProjectFiles();
          }
        );
      };
      if (socket.connected) {
        emitCreate();
      } else {
        socket.once('connect', emitCreate);
      }

      // Hapus listener lama sebelum pasang yang baru (hindari duplikat)
      socket.off('text-change');
      socket.off('user-joined');
      socket.off('user-left');
      socket.off('connect_error');
      socket.off('room-created');

      // Terima perubahan dari user lain
      socket.on('text-change', (data: any) => {
        applyRemoteChange(data);
      });

      socket.on('user-joined', async (data: any) => {
        vscode.window.showInformationMessage(
          `👤 ${data.username} (${data.userId}) bergabung!`
        );
        // ✅ FIX: Kirim ulang semua file project ke server (update terbaru)
        // Agar user baru mendapat versi paling mutakhir
        await sendAllProjectFiles();
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

      // Hapus listener file sync lama
      socket.off('receive-file');
      socket.off('receive-project');

      // Terima file overwrite dari collaborator
      socket.on('receive-file', async (data: any) => {
        await receiveFile(data);
      });

      // Terima project overwrite dari collaborator
      socket.on('receive-project', async (data: any) => {
        await receiveProject(data);
      });

      setupDocumentSync();
    })
  );

  // ✅ Join Session
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.joinSession', async () => {

      // Cek workspace folder dulu
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        const action = await vscode.window.showWarningMessage(
          '📁 Buka folder dulu untuk menyimpan file project!',
          'Buka Folder'
        );
        if (action === 'Buka Folder') {
          await vscode.commands.executeCommand('vscode.openFolder');
        }
        return;
      }

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

      if (!socket) {
        vscode.window.showErrorMessage('❌ Gagal membuat koneksi socket!');
        return;
      }

      // ⚠️ Pasang semua listener DULU sebelum emit join-room
      // (kalau tidak, init-file dari server bisa terlewat)

      // Hapus listener lama sebelum pasang yang baru (hindari duplikat)
      socket.off('init-document');
      socket.off('init-file');
      socket.off('text-change');
      socket.off('user-joined');
      socket.off('user-left');
      socket.off('connect_error');
      socket.off('error');
      socket.off('receive-file');
      socket.off('receive-project');

      // Terima dokumen awal dari host (legacy single file)
      socket.on('init-document', (data: any) => {
        if (!data) return;
        // Support format lama (string) dan baru (object)
        if (typeof data === 'string') {
          applyFullDocument(data);
        } else if (data.relativePath && data.content) {
          applyFullDocumentToFile(data.content, data.relativePath);
        }
      });

      // Terima file individual dari host saat join
      socket.on('init-file', (data: any) => {
        if (!data || !data.relativePath || !data.content) return;
        applyFullDocumentToFile(data.content, data.relativePath);
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

      // Terima file overwrite dari collaborator
      socket.on('receive-file', async (data: any) => {
        await receiveFile(data);
      });

      // Terima project overwrite dari collaborator
      socket.on('receive-project', async (data: any) => {
        await receiveProject(data);
      });

      // ✅ Sekarang baru emit join-room (listener sudah siap)
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

  // ✅ Sync Current File
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.syncFile', async () => {
      if (!socket || !socket.connected) {
        vscode.window.showErrorMessage('❌ Belum terhubung! Start atau Join session dulu.');
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('❌ Tidak ada file yang terbuka!');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('❌ Buka folder/project dulu!');
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
      const content = editor.document.getText();

      const confirm = await vscode.window.showWarningMessage(
        `📄 Kirim file "${relativePath}" ke semua collaborator? File mereka akan di-overwrite.`,
        'Ya, Kirim', 'Batal'
      );
      if (confirm !== 'Ya, Kirim') return;

      socket.emit('sync-file', {
        relativePath,
        content,
        userId: myUserId,
        username: myUsername,
      });

      vscode.window.showInformationMessage(`✅ File "${relativePath}" terkirim!`);
    })
  );

  // ✅ Sync Entire Project
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.syncProject', async () => {
      if (!socket || !socket.connected) {
        vscode.window.showErrorMessage('❌ Belum terhubung! Start atau Join session dulu.');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('❌ Buka folder/project dulu!');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        '📁 Kirim SEMUA file project ke collaborator? File mereka akan di-overwrite.',
        'Ya, Kirim Semua', 'Batal'
      );
      if (confirm !== 'Ya, Kirim Semua') return;

      // Cari semua file, exclude node_modules, .git, out, dll
      const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/out/**,**/.vscode/**,**/dist/**,**/*.vsix}'
      );

      const fileDataArray: { relativePath: string; content: string }[] = [];

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '📦 Mengumpulkan file project...',
          cancellable: false,
        },
        async (progress) => {
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
              const rawBytes = await vscode.workspace.fs.readFile(file);
              const content = Buffer.from(rawBytes).toString('utf-8');
              const relativePath = vscode.workspace.asRelativePath(file);
              fileDataArray.push({ relativePath, content });
              progress.report({
                increment: (100 / files.length),
                message: `${i + 1}/${files.length} — ${relativePath}`,
              });
            } catch {
              // Skip file yang tidak bisa dibaca (binary, dll)
            }
          }
        }
      );

      if (fileDataArray.length === 0) {
        vscode.window.showWarningMessage('⚠️ Tidak ada file yang bisa dikirim.');
        return;
      }

      socket.emit('sync-project', {
        files: fileDataArray,
        userId: myUserId,
        username: myUsername,
      });

      vscode.window.showInformationMessage(
        `✅ ${fileDataArray.length} file project terkirim!`
      );
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
    withCredentials: false,
    extraHeaders: {
      'ngrok-skip-browser-warning': 'true',
    },
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

    // Gunakan relative path agar lintas mesin
    const relativePath = vscode.workspace.asRelativePath(event.document.uri);

    // Kirim perubahan ke server
    socket.emit('text-change', {
      changes,
      userId: myUserId,
      username: myUsername,
      relativePath,
      fileName: event.document.fileName, // backward compat
      fullContent: event.document.getText(), // ✅ Kirim full content sebagai backup
      version: event.document.version,
    });
  });
}

// Terapkan perubahan kecil dari remote ke file yang benar
async function applyRemoteChange(data: {
  changes: any[];
  relativePath?: string;
  userId?: string;
  username?: string;
  fullContent?: string;
  version?: number;
}) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  // Tentukan URI file target
  let fileUri: vscode.Uri | undefined;
  if (data.relativePath && workspaceFolder) {
    fileUri = vscode.Uri.joinPath(workspaceFolder.uri, data.relativePath);
  } else {
    // Fallback ke active editor kalau tidak ada relativePath
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    fileUri = editor.document.uri;
  }

  // Buka dokumen (background, tidak mengganggu tab user)
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(fileUri);
  } catch {
    // File belum ada, buat pakai fullContent
    if (data.fullContent && workspaceFolder && data.relativePath) {
      const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, data.relativePath);
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(data.fullContent, 'utf-8'));
    }
    return;
  }

  // Skip kalau konten sama persis
  if (data.fullContent !== undefined) {
    if (document.getText() === data.fullContent) return;
  }

  // ✅ FIX: try/finally agar isApplyingRemoteChange selalu direset
  isApplyingRemoteChange = true;
  try {
    // Gunakan WorkspaceEdit agar bisa edit file manapun (bukan hanya active editor)
    const edit = new vscode.WorkspaceEdit();
    data.changes.forEach((change: any) => {
      const start = new vscode.Position(change.startLine, change.startChar);
      const end = new vscode.Position(change.endLine, change.endChar);
      const range = new vscode.Range(start, end);
      edit.replace(fileUri!, range, change.text);
    });

    const success = await vscode.workspace.applyEdit(edit);

    if (!success && data.fullContent) {
      // Kalau edit gagal, pakai full document sync
      if (data.relativePath) {
        await applyFullDocumentToFile(data.fullContent, data.relativePath);
      } else {
        await applyFullDocument(data.fullContent);
      }
    }
  } catch (err) {
    // Kalau ada error, fallback ke full content sync
    if (data.fullContent) {
      if (data.relativePath) {
        await applyFullDocumentToFile(data.fullContent, data.relativePath);
      } else {
        await applyFullDocument(data.fullContent);
      }
    }
  } finally {
    isApplyingRemoteChange = false;
  }
}

// Terapkan full dokumen ke active editor (legacy/fallback)
async function applyFullDocument(content: string) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const currentContent = editor.document.getText();
  if (currentContent === content) return;

  isApplyingRemoteChange = true;
  try {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(currentContent.length)
    );
    edit.replace(editor.document.uri, fullRange, content);
    await vscode.workspace.applyEdit(edit);
  } finally {
    isApplyingRemoteChange = false;
  }
}

// Terapkan full dokumen ke file tertentu berdasarkan relativePath
async function applyFullDocumentToFile(content: string, relativePath: string) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

  // Coba buka dokumen yang sudah ada
  let document: vscode.TextDocument | undefined;
  try {
    document = await vscode.workspace.openTextDocument(fileUri);
  } catch {
    // File belum ada, buat baru langsung
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
    return;
  }

  const currentContent = document.getText();
  if (currentContent === content) return;

  isApplyingRemoteChange = true;
  try {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(currentContent.length)
    );
    edit.replace(fileUri, fullRange, content);
    await vscode.workspace.applyEdit(edit);
  } finally {
    isApplyingRemoteChange = false;
  }
}

// ✅ FIX: Kirim SEMUA file project ke server (bukan hanya yang terbuka)
// Ini dipanggil setelah room dibuat DAN saat user baru join
async function sendAllProjectFiles() {
  if (!socket || !socket.connected) return;

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  try {
    // Scan semua file di workspace, exclude node_modules, .git, out, dll
    const files = await vscode.workspace.findFiles(
      '**/*',
      '{**/node_modules/**,**/.git/**,**/out/**,**/.vscode/**,**/dist/**,**/*.vsix,**/.DS_Store}'
    );

    const fileDataArray: { relativePath: string; content: string }[] = [];

    for (const file of files) {
      try {
        const rawBytes = await vscode.workspace.fs.readFile(file);
        const content = Buffer.from(rawBytes).toString('utf-8');
        const relativePath = vscode.workspace.asRelativePath(file);
        fileDataArray.push({ relativePath, content });
      } catch {
        // Skip file yang tidak bisa dibaca (binary, dll)
      }
    }

    if (fileDataArray.length === 0) return;

    // Kirim semua file sekaligus ke server via sync-all-files event
    socket.emit('sync-all-files', {
      files: fileDataArray,
      userId: myUserId,
      username: myUsername,
    });

    console.log(`📦 Sent ${fileDataArray.length} project files to server`);
  } catch (err) {
    console.error('❌ Error sending project files:', err);
  }
}

// ─────────────────────────────────────────
// FILE & PROJECT SYNC (OVERWRITE)
// ─────────────────────────────────────────

// Terima single file dari collaborator
async function receiveFile(data: {
  relativePath: string;
  content: string;
  userId?: string;
  username?: string;
}) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const confirm = await vscode.window.showWarningMessage(
    `📄 ${data.username || 'User'} mengirim file: "${data.relativePath}". Overwrite?`,
    'Ya, Terima', 'Tolak'
  );
  if (confirm !== 'Ya, Terima') return;

  try {
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, data.relativePath);
    const encoded = Buffer.from(data.content, 'utf-8');
    await vscode.workspace.fs.writeFile(fileUri, encoded);
    vscode.window.showInformationMessage(`✅ File "${data.relativePath}" berhasil diterima!`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`❌ Gagal menulis file: ${err.message}`);
  }
}

// Terima seluruh project dari collaborator
async function receiveProject(data: {
  files: { relativePath: string; content: string }[];
  userId?: string;
  username?: string;
}) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const confirm = await vscode.window.showWarningMessage(
    `📁 ${data.username || 'User'} mengirim ${data.files.length} file project. Overwrite semua?`,
    'Ya, Terima Semua', 'Tolak'
  );
  if (confirm !== 'Ya, Terima Semua') return;

  let successCount = 0;
  let failCount = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '📥 Menerima project...',
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < data.files.length; i++) {
        const file = data.files[i];
        try {
          const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file.relativePath);
          const encoded = Buffer.from(file.content, 'utf-8');
          await vscode.workspace.fs.writeFile(fileUri, encoded);
          successCount++;
        } catch {
          failCount++;
        }
        progress.report({
          increment: (100 / data.files.length),
          message: `${i + 1}/${data.files.length} — ${file.relativePath}`,
        });
      }
    }
  );

  vscode.window.showInformationMessage(
    `✅ Project diterima! ${successCount} file berhasil${failCount > 0 ? `, ${failCount} gagal` : ''}.`
  );
}

export function deactivate() {
  socket?.disconnect();
  docSyncDisposable?.dispose();
}