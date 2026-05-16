import * as vscode from 'vscode';
const { io } = require('socket.io-client');

let socket: any = null;
let isApplyingRemoteChange = false;
let docSyncDisposable: vscode.Disposable | null = null;
let myUsername = '';
let myUserId = '';
let currentRoomId = '';
let currentServerUrl = '';

// Presence tracking
let statusBarItem: vscode.StatusBarItem | null = null;
let roomMembers: Map<string, { username: string; status: string }> = new Map();
let typingTimeout: ReturnType<typeof setTimeout> | null = null;

// Remote cursor tracking
interface RemoteCursor {
  userId: string;
  username: string;
  relativePath: string;
  line: number;
  character: number;
  color: string;
  cursorDecorationType: vscode.TextEditorDecorationType;
  labelDecorationType: vscode.TextEditorDecorationType;
  hideTimer?: ReturnType<typeof setTimeout>;
}
let remoteCursors: Map<string, RemoteCursor> = new Map();
let cursorSelectionDisposable: vscode.Disposable | null = null;
let cursorEditorChangeDisposable: vscode.Disposable | null = null;

// User Activity tracking (untuk sidebar TreeView)
interface UserActivity {
  userId: string;
  username: string;
  status: string; // 'idle' | 'typing'
  activeFile: string | null; // relativePath
  activeLine: number;
  activeCharacter: number;
  color: string;
}
let userActivities: Map<string, UserActivity> = new Map();
let activityProvider: UserActivityProvider | null = null;
let activeEditorDisposable: vscode.Disposable | null = null;

// Warna-warna untuk cursor remote user (unik per user)
const CURSOR_COLORS = [
  '#FF6B6B', // merah
  '#4ECDC4', // teal
  '#FFE66D', // kuning
  '#A78BFA', // ungu
  '#F97316', // orange
  '#22D3EE', // cyan
  '#F472B6', // pink
  '#34D399', // hijau
  '#818CF8', // indigo
  '#FB923C', // amber
];

export function activate(context: vscode.ExtensionContext) {

  // Buat status bar item untuk presence
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  // ✅ Register TreeView sidebar "Collaborators"
  activityProvider = new UserActivityProvider();
  const treeView = vscode.window.createTreeView('collabUsers', {
    treeDataProvider: activityProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // ✅ Follow User command — buka file yang sama & scroll ke posisi cursor user
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.followUser', async (item: UserItem) => {
      if (!item || !item.activity) return;
      const activity = item.activity;
      if (!activity.activeFile) {
        vscode.window.showInformationMessage(`${activity.username} belum membuka file.`);
        return;
      }
      await openAndScrollToUser(activity);
    })
  );

  // ✅ Open User's File command — buka file tanpa scroll
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.openUserFile', async (item: FileItem) => {
      if (!item || !item.relativePath) return;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, item.relativePath);
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        vscode.window.showErrorMessage(`❌ File "${item.relativePath}" tidak ditemukan.`);
      }
    })
  );

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
      socket.off('receive-file');
      socket.off('receive-project');
      socket.off('room-members');
      socket.off('presence-update');
      socket.off('cursor-update');
      socket.off('active-file');

      // Terima perubahan dari user lain
      socket.on('text-change', (data: any) => {
        applyRemoteChange(data);
      });

      socket.on('user-joined', async (data: any) => {
        vscode.window.showInformationMessage(
          `👤 ${data.username} (${data.userId}) bergabung!`
        );
        // Tambah ke daftar member
        roomMembers.set(data.userId, { username: data.username, status: 'idle' });
        updateStatusBar();
        // Kirim ulang semua file project ke server
        await sendAllProjectFiles();
      });

      socket.on('user-left', (data: any) => {
        vscode.window.showInformationMessage(
          `👋 ${data.username} keluar.`
        );
        // Hapus dari daftar member
        roomMembers.delete(data.userId);
        updateStatusBar();
        // Hapus cursor remote user yang keluar
        removeRemoteCursor(data.userId);
        // Hapus dari activity tracking
        userActivities.delete(data.userId);
        activityProvider?.refresh();
      });

      socket.on('connect_error', (err: any) => {
        vscode.window.showErrorMessage(`❌ Gagal konek: ${err.message}`);
      });

      socket.on('room-created', (roomId: string) => {
        currentRoomId = roomId;
      });

      // Terima daftar member saat ini
      socket.on('room-members', (members: any[]) => {
        roomMembers.clear();
        userActivities.clear();
        for (const m of members) {
          roomMembers.set(m.userId, { username: m.username, status: m.status || 'idle' });
          // Juga populate userActivities
          userActivities.set(m.userId, {
            userId: m.userId,
            username: m.username,
            status: m.status || 'idle',
            activeFile: m.activeFile || null,
            activeLine: m.activeLine || 0,
            activeCharacter: 0,
            color: getColorForUser(m.userId),
          });
        }
        // Tambah diri sendiri
        roomMembers.set(myUserId, { username: myUsername, status: 'idle' });
        const editor = vscode.window.activeTextEditor;
        userActivities.set(myUserId, {
          userId: myUserId,
          username: myUsername,
          status: 'idle',
          activeFile: editor ? vscode.workspace.asRelativePath(editor.document.uri) : null,
          activeLine: editor ? editor.selection.active.line : 0,
          activeCharacter: editor ? editor.selection.active.character : 0,
          color: getColorForUser(myUserId),
        });
        updateStatusBar();
        activityProvider?.refresh();
      });

      // Terima update presence dari user lain
      socket.on('presence-update', (data: any) => {
        if (data.userId && data.userId !== myUserId) {
          roomMembers.set(data.userId, { username: data.username, status: data.status });
          // Update activity status juga
          const activity = userActivities.get(data.userId);
          if (activity) {
            activity.status = data.status;
          }
          updateStatusBar();
          activityProvider?.refresh();
        }
      });

      // Terima file overwrite dari collaborator
      socket.on('receive-file', async (data: any) => {
        await receiveFile(data);
      });

      // Terima project overwrite dari collaborator
      socket.on('receive-project', async (data: any) => {
        await receiveProject(data);
      });

      // Terima posisi cursor dari user lain
      socket.on('cursor-update', (data: any) => {
        if (data.userId && data.userId !== myUserId) {
          updateRemoteCursor(data);
          // Update activity file & line juga
          const activity = userActivities.get(data.userId);
          if (activity) {
            activity.activeFile = data.relativePath;
            activity.activeLine = data.line;
            activity.activeCharacter = data.character;
            activityProvider?.refresh();
          }
        }
      });

      // Terima info file aktif dari user lain
      socket.on('active-file', (data: any) => {
        if (data.userId && data.userId !== myUserId) {
          let activity = userActivities.get(data.userId);
          if (!activity) {
            activity = {
              userId: data.userId,
              username: data.username,
              status: 'idle',
              activeFile: null,
              activeLine: 0,
              activeCharacter: 0,
              color: getColorForUser(data.userId),
            };
            userActivities.set(data.userId, activity);
          }
          activity.activeFile = data.relativePath;
          activity.activeLine = data.line || 0;
          activity.activeCharacter = data.character || 0;
          activityProvider?.refresh();
        }
      });

      // Tambah diri sendiri ke member list & activity
      roomMembers.clear();
      roomMembers.set(myUserId, { username: myUsername, status: 'idle' });
      const currentEditor = vscode.window.activeTextEditor;
      userActivities.clear();
      userActivities.set(myUserId, {
        userId: myUserId,
        username: myUsername,
        status: 'idle',
        activeFile: currentEditor ? vscode.workspace.asRelativePath(currentEditor.document.uri) : null,
        activeLine: currentEditor ? currentEditor.selection.active.line : 0,
        activeCharacter: currentEditor ? currentEditor.selection.active.character : 0,
        color: getColorForUser(myUserId),
      });
      updateStatusBar();
      activityProvider?.refresh();

      setupDocumentSync();
      setupCursorTracking();
      setupActiveFileTracking();
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
      socket.off('room-members');
      socket.off('presence-update');
      socket.off('cursor-update');
      socket.off('active-file');

      // Terima dokumen awal dari host (legacy single file)
      socket.on('init-document', (data: any) => {
        if (!data) return;
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
        roomMembers.set(data.userId, { username: data.username, status: 'idle' });
        updateStatusBar();
        // Tambah ke activity tracking
        userActivities.set(data.userId, {
          userId: data.userId,
          username: data.username,
          status: 'idle',
          activeFile: null,
          activeLine: 0,
          activeCharacter: 0,
          color: getColorForUser(data.userId),
        });
        activityProvider?.refresh();
      });

      socket.on('user-left', (data: any) => {
        vscode.window.showInformationMessage(
          `👋 ${data.username} keluar.`
        );
        roomMembers.delete(data.userId);
        updateStatusBar();
        // Hapus cursor remote user yang keluar
        removeRemoteCursor(data.userId);
        // Hapus dari activity tracking
        userActivities.delete(data.userId);
        activityProvider?.refresh();
      });

      socket.on('connect_error', (err: any) => {
        vscode.window.showErrorMessage(
          `❌ Gagal konek ke ${serverUrl}: ${err.message}`
        );
      });

      socket.on('error', (msg: string) => {
        vscode.window.showErrorMessage(`❌ Error: ${msg}`);
      });

      // Terima daftar member saat ini
      socket.on('room-members', (members: any[]) => {
        roomMembers.clear();
        userActivities.clear();
        for (const m of members) {
          roomMembers.set(m.userId, { username: m.username, status: m.status || 'idle' });
          userActivities.set(m.userId, {
            userId: m.userId,
            username: m.username,
            status: m.status || 'idle',
            activeFile: m.activeFile || null,
            activeLine: m.activeLine || 0,
            activeCharacter: 0,
            color: getColorForUser(m.userId),
          });
        }
        roomMembers.set(myUserId, { username: myUsername, status: 'idle' });
        const editor = vscode.window.activeTextEditor;
        userActivities.set(myUserId, {
          userId: myUserId,
          username: myUsername,
          status: 'idle',
          activeFile: editor ? vscode.workspace.asRelativePath(editor.document.uri) : null,
          activeLine: editor ? editor.selection.active.line : 0,
          activeCharacter: editor ? editor.selection.active.character : 0,
          color: getColorForUser(myUserId),
        });
        updateStatusBar();
        activityProvider?.refresh();
      });

      // Terima update presence dari user lain
      socket.on('presence-update', (data: any) => {
        if (data.userId && data.userId !== myUserId) {
          roomMembers.set(data.userId, { username: data.username, status: data.status });
          const activity = userActivities.get(data.userId);
          if (activity) {
            activity.status = data.status;
          }
          updateStatusBar();
          activityProvider?.refresh();
        }
      });

      // Terima file overwrite dari collaborator
      socket.on('receive-file', async (data: any) => {
        await receiveFile(data);
      });

      // Terima project overwrite dari collaborator
      socket.on('receive-project', async (data: any) => {
        await receiveProject(data);
      });

      // Terima posisi cursor dari user lain
      socket.on('cursor-update', (data: any) => {
        if (data.userId && data.userId !== myUserId) {
          updateRemoteCursor(data);
          const activity = userActivities.get(data.userId);
          if (activity) {
            activity.activeFile = data.relativePath;
            activity.activeLine = data.line;
            activity.activeCharacter = data.character;
            activityProvider?.refresh();
          }
        }
      });

      // Terima info file aktif dari user lain
      socket.on('active-file', (data: any) => {
        if (data.userId && data.userId !== myUserId) {
          let activity = userActivities.get(data.userId);
          if (!activity) {
            activity = {
              userId: data.userId,
              username: data.username,
              status: 'idle',
              activeFile: null,
              activeLine: 0,
              activeCharacter: 0,
              color: getColorForUser(data.userId),
            };
            userActivities.set(data.userId, activity);
          }
          activity.activeFile = data.relativePath;
          activity.activeLine = data.line || 0;
          activity.activeCharacter = data.character || 0;
          activityProvider?.refresh();
        }
      });

      // Tambah diri sendiri ke member list & activity
      roomMembers.clear();
      roomMembers.set(myUserId, { username: myUsername, status: 'idle' });
      const currentEditor = vscode.window.activeTextEditor;
      userActivities.clear();
      userActivities.set(myUserId, {
        userId: myUserId,
        username: myUsername,
        status: 'idle',
        activeFile: currentEditor ? vscode.workspace.asRelativePath(currentEditor.document.uri) : null,
        activeLine: currentEditor ? currentEditor.selection.active.line : 0,
        activeCharacter: currentEditor ? currentEditor.selection.active.character : 0,
        color: getColorForUser(myUserId),
      });
      updateStatusBar();
      activityProvider?.refresh();

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
      setupCursorTracking();
      setupActiveFileTracking();
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
      if (typingTimeout) {
        clearTimeout(typingTimeout);
        typingTimeout = null;
      }
      // Bersihkan semua cursor remote
      clearAllRemoteCursors();
      if (cursorSelectionDisposable) {
        cursorSelectionDisposable.dispose();
        cursorSelectionDisposable = null;
      }
      if (cursorEditorChangeDisposable) {
        cursorEditorChangeDisposable.dispose();
        cursorEditorChangeDisposable = null;
      }
      currentRoomId = '';
      roomMembers.clear();
      userActivities.clear();
      activityProvider?.refresh();
      if (activeEditorDisposable) {
        activeEditorDisposable.dispose();
        activeEditorDisposable = null;
      }
      updateStatusBar();
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

    // Update status typing
    emitPresence('typing');
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      emitPresence('idle');
    }, 3000);
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

// ─────────────────────────────────────────
// PRESENCE / STATUS BAR
// ─────────────────────────────────────────

function emitPresence(status: string) {
  if (!socket || !socket.connected) return;
  socket.emit('presence-update', {
    userId: myUserId,
    username: myUsername,
    status,
  });
  // Update diri sendiri di member list
  roomMembers.set(myUserId, { username: myUsername, status });
  updateStatusBar();
}

function updateStatusBar() {
  if (!statusBarItem) return;

  if (roomMembers.size === 0 || !currentRoomId) {
    statusBarItem.hide();
    return;
  }

  const entries = Array.from(roomMembers.values());
  const typingCount = entries.filter(m => m.status === 'typing').length;
  const idleCount = entries.filter(m => m.status !== 'typing').length;

  // Status bar text - compact
  const memberTexts = entries.map(m => {
    const icon = m.status === 'typing' ? '✏️' : '💤';
    return `${m.username} ${icon}`;
  });
  statusBarItem.text = `👥 ${memberTexts.join('  ·  ')}`;

  // Tooltip - detailed
  const tooltipLines = [
    `🏠 Room: ${currentRoomId}`,
    `👥 ${entries.length} user online`,
    '',
    ...entries.map(m => {
      const statusText = m.status === 'typing' ? '✏️ sedang mengetik' : '💤 idle';
      return `  ${m.username} — ${statusText}`;
    }),
    '',
    `✏️ Mengetik: ${typingCount}  |  💤 Idle: ${idleCount}`,
  ];
  statusBarItem.tooltip = tooltipLines.join('\n');
  statusBarItem.show();
}

// ─────────────────────────────────────────
// REMOTE CURSOR NAMETAG
// ─────────────────────────────────────────

// Dapatkan warna unik untuk setiap user
function getColorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

// Setup listener untuk mengirim posisi cursor lokal ke server
function setupCursorTracking() {
  // Bersihkan listener lama
  if (cursorSelectionDisposable) {
    cursorSelectionDisposable.dispose();
  }
  if (cursorEditorChangeDisposable) {
    cursorEditorChangeDisposable.dispose();
  }

  // Kirim posisi cursor saat selection berubah
  cursorSelectionDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!socket || !socket.connected) return;
    if (isApplyingRemoteChange) return;

    const editor = event.textEditor;
    if (editor.document.uri.scheme !== 'file') return;

    const position = editor.selection.active;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);

    socket.emit('cursor-update', {
      userId: myUserId,
      username: myUsername,
      relativePath,
      line: position.line,
      character: position.character,
    });
  });

  // Re-render cursor saat pindah editor/tab
  cursorEditorChangeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    renderCursorsForEditor(editor);
  });
}

// Update/tambah cursor remote user
function updateRemoteCursor(data: {
  userId: string;
  username: string;
  relativePath: string;
  line: number;
  character: number;
}) {
  const existing = remoteCursors.get(data.userId);
  const color = getColorForUser(data.userId);

  // Hapus decoration lama kalau ada
  if (existing) {
    existing.cursorDecorationType.dispose();
    existing.labelDecorationType.dispose();
    if (existing.hideTimer) {
      clearTimeout(existing.hideTimer);
    }
  }

  // Buat decoration type baru untuk cursor (garis vertikal berwarna)
  const cursorDecorationType = vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: color,
    overviewRulerColor: color,
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  // Buat decoration type untuk nametag label (di atas cursor)
  const labelDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: ` ${data.username}`,
      color: '#ffffff',
      backgroundColor: color,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: `;
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 3px;
        margin-left: 4px;
        position: relative;
        top: -1px;
      `,
    },
  });

  // Auto-hide cursor setelah 10 detik tanpa update
  const hideTimer = setTimeout(() => {
    const cursor = remoteCursors.get(data.userId);
    if (cursor) {
      cursor.cursorDecorationType.dispose();
      cursor.labelDecorationType.dispose();
      remoteCursors.delete(data.userId);
    }
  }, 10000);

  const cursor: RemoteCursor = {
    userId: data.userId,
    username: data.username,
    relativePath: data.relativePath,
    line: data.line,
    character: data.character,
    color,
    cursorDecorationType,
    labelDecorationType,
    hideTimer,
  };

  remoteCursors.set(data.userId, cursor);

  // Render di editor yang sesuai
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    renderCursorsForEditor(editor);
  }
}

// Render semua cursor remote di editor yang diberikan
function renderCursorsForEditor(editor: vscode.TextEditor) {
  if (editor.document.uri.scheme !== 'file') return;

  const currentRelativePath = vscode.workspace.asRelativePath(editor.document.uri);

  for (const [, cursor] of remoteCursors) {
    if (cursor.relativePath === currentRelativePath) {
      // Cursor ini ada di file yang sama — tampilkan
      const line = Math.min(cursor.line, editor.document.lineCount - 1);
      const lineText = editor.document.lineAt(line).text;
      const char = Math.min(cursor.character, lineText.length);

      const pos = new vscode.Position(line, char);
      const range = new vscode.Range(pos, pos);

      // Render cursor line
      editor.setDecorations(cursor.cursorDecorationType, [range]);

      // Render nametag label
      editor.setDecorations(cursor.labelDecorationType, [range]);
    } else {
      // Cursor ini di file lain — sembunyikan dari editor ini
      editor.setDecorations(cursor.cursorDecorationType, []);
      editor.setDecorations(cursor.labelDecorationType, []);
    }
  }
}

// Hapus cursor remote untuk user tertentu
function removeRemoteCursor(userId: string) {
  const cursor = remoteCursors.get(userId);
  if (cursor) {
    cursor.cursorDecorationType.dispose();
    cursor.labelDecorationType.dispose();
    if (cursor.hideTimer) {
      clearTimeout(cursor.hideTimer);
    }
    remoteCursors.delete(userId);
  }
}

// Hapus semua cursor remote
function clearAllRemoteCursors() {
  for (const [, cursor] of remoteCursors) {
    cursor.cursorDecorationType.dispose();
    cursor.labelDecorationType.dispose();
    if (cursor.hideTimer) {
      clearTimeout(cursor.hideTimer);
    }
  }
  remoteCursors.clear();
}

// ─────────────────────────────────────────
// ACTIVE FILE TRACKING
// ─────────────────────────────────────────

// Emit active-file event saat user pindah tab editor
function setupActiveFileTracking() {
  if (activeEditorDisposable) {
    activeEditorDisposable.dispose();
  }

  activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!socket || !socket.connected) return;
    if (!editor) return;
    if (editor.document.uri.scheme !== 'file') return;

    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    const position = editor.selection.active;

    // Kirim ke server
    socket.emit('active-file', {
      userId: myUserId,
      username: myUsername,
      relativePath,
      line: position.line,
      character: position.character,
    });

    // Update diri sendiri di activity list
    const myActivity = userActivities.get(myUserId);
    if (myActivity) {
      myActivity.activeFile = relativePath;
      myActivity.activeLine = position.line;
      myActivity.activeCharacter = position.character;
      activityProvider?.refresh();
    }
  });
}

// ─────────────────────────────────────────
// USER ACTIVITY TREEVIEW PROVIDER
// ─────────────────────────────────────────

class UserActivityProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    // Root level — tampilkan semua user
    if (!element) {
      if (userActivities.size === 0 && !currentRoomId) {
        // Belum ada session — tampilkan pesan
        const noSession = new vscode.TreeItem(
          'Belum ada session aktif',
          vscode.TreeItemCollapsibleState.None
        );
        noSession.description = 'Start atau Join session dulu';
        noSession.iconPath = new vscode.ThemeIcon('info');
        return [noSession];
      }

      if (userActivities.size === 0) {
        const noUsers = new vscode.TreeItem(
          'Belum ada user',
          vscode.TreeItemCollapsibleState.None
        );
        noUsers.iconPath = new vscode.ThemeIcon('info');
        return [noUsers];
      }

      // Urutkan: diri sendiri di atas, lalu alphabetical
      const sorted = Array.from(userActivities.values()).sort((a, b) => {
        if (a.userId === myUserId) return -1;
        if (b.userId === myUserId) return 1;
        return a.username.localeCompare(b.username);
      });

      return sorted.map(activity => new UserItem(activity));
    }

    // Child level — tampilkan file aktif user
    if (element instanceof UserItem) {
      const activity = element.activity;
      const items: vscode.TreeItem[] = [];

      if (activity.activeFile) {
        const fileItem = new FileItem(activity);
        items.push(fileItem);
      } else {
        const noFile = new vscode.TreeItem(
          'Belum membuka file',
          vscode.TreeItemCollapsibleState.None
        );
        noFile.description = '';
        noFile.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        items.push(noFile);
      }

      return items;
    }

    return [];
  }
}

// TreeItem untuk menampilkan user di sidebar
class UserItem extends vscode.TreeItem {
  public activity: UserActivity;

  constructor(activity: UserActivity) {
    const isMe = activity.userId === myUserId;
    const statusIcon = activity.status === 'typing' ? '✏️' : '🟢';
    const label = `${statusIcon} ${activity.username}${isMe ? ' (kamu)' : ''}`;

    super(label, vscode.TreeItemCollapsibleState.Expanded);

    this.activity = activity;
    this.contextValue = isMe ? 'localUser' : 'remoteUser';

    // Tooltip detail
    const statusText = activity.status === 'typing' ? 'sedang mengetik' : 'idle';
    const fileText = activity.activeFile
      ? `📄 ${activity.activeFile} — baris ${activity.activeLine + 1}`
      : 'Belum membuka file';
    this.tooltip = `${activity.username}\nStatus: ${statusText}\n${fileText}`;

    // Icon berdasarkan status
    if (isMe) {
      this.iconPath = new vscode.ThemeIcon('account', new vscode.ThemeColor('charts.green'));
    } else if (activity.status === 'typing') {
      this.iconPath = new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.yellow'));
    } else {
      this.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.blue'));
    }

    // Description — status singkat
    this.description = activity.status === 'typing' ? 'mengetik...' : 'idle';
  }
}

// TreeItem untuk menampilkan file aktif user
class FileItem extends vscode.TreeItem {
  public relativePath: string;
  public activity: UserActivity;

  constructor(activity: UserActivity) {
    const fileName = activity.activeFile!.split('/').pop() || activity.activeFile!;
    const lineNum = activity.activeLine + 1;

    super(`${fileName}`, vscode.TreeItemCollapsibleState.None);

    this.relativePath = activity.activeFile!;
    this.activity = activity;

    // Tampilkan path lengkap di description
    this.description = `baris ${lineNum}`;
    this.tooltip = `${activity.activeFile}\nBaris ${lineNum}, Kolom ${activity.activeCharacter + 1}\nKlik untuk membuka file`;

    this.iconPath = new vscode.ThemeIcon('file-code');

    // Context untuk menu button
    const isMe = activity.userId === myUserId;
    this.contextValue = isMe ? 'localFile' : 'userFile';

    // Klik langsung membuka file
    if (!isMe) {
      this.command = {
        command: 'collab.openUserFile',
        title: 'Open File',
        arguments: [this],
      };
    }
  }
}

// Buka file yang user lain sedang edit dan scroll ke posisi cursor mereka
async function openAndScrollToUser(activity: UserActivity) {
  if (!activity.activeFile) return;

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, activity.activeFile);

  try {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    // Scroll ke posisi cursor user target
    const line = Math.min(activity.activeLine, doc.lineCount - 1);
    const lineText = doc.lineAt(line).text;
    const char = Math.min(activity.activeCharacter, lineText.length);

    const position = new vscode.Position(line, char);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter
    );

    vscode.window.showInformationMessage(
      `👁️ Mengikuti ${activity.username} di ${activity.activeFile} baris ${line + 1}`
    );
  } catch {
    vscode.window.showErrorMessage(`❌ File "${activity.activeFile}" tidak ditemukan.`);
  }
}

export function deactivate() {
  if (typingTimeout) clearTimeout(typingTimeout);
  roomMembers.clear();
  userActivities.clear();
  clearAllRemoteCursors();
  if (cursorSelectionDisposable) cursorSelectionDisposable.dispose();
  if (cursorEditorChangeDisposable) cursorEditorChangeDisposable.dispose();
  if (activeEditorDisposable) activeEditorDisposable.dispose();
  statusBarItem?.hide();
  socket?.disconnect();
  docSyncDisposable?.dispose();
}