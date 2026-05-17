import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
const { io } = require('socket.io-client');

let socket: any = null;
let isApplyingRemoteChange = false;
let docSyncDisposable: vscode.Disposable | null = null;
let fileCreateWatcherDisposable: vscode.Disposable | null = null;
let fileSaveWatcherDisposable: vscode.Disposable | null = null;
let fileDeleteWatcherDisposable: vscode.Disposable | null = null;
let fileRenameWatcherDisposable: vscode.Disposable | null = null;
let myUsername = '';
let myUserId = '';
let currentRoomId = '';
let currentServerUrl = '';
let isHost: boolean = false; // ✅ Identifikasi peran user

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

// Following mode tracking
let followingUserId: string | null = null;
let followingUsername: string | null = null;
let followingStatusBarItem: vscode.StatusBarItem | null = null;
let followingDecorationType: vscode.TextEditorDecorationType | null = null;

// Pin Location tracking
interface PinLocation {
  userId: string;
  username: string;
  relativePath: string;
  line: number;
  character: number;
  message: string;
  timestamp: number;
}
let lastReceivedPin: PinLocation | null = null;
let pinDecorationType: vscode.TextEditorDecorationType | null = null;
let pinGutterDecorationType: vscode.TextEditorDecorationType | null = null;

// Pending join via link (URI handler)
let pendingJoinLink: { serverUrl: string; roomId: string } | null = null;
let extensionContext: vscode.ExtensionContext | null = null;

// Shared Terminal tracking
let sharedTerminal: vscode.Terminal | null = null;
let sharedTerminalWriteEmitter: vscode.EventEmitter<string> | null = null;
let terminalViewerPanel: vscode.WebviewPanel | null = null;
let isTerminalSharing = false;
let terminalDataListener: vscode.Disposable | null = null;

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

  // Buat status bar item untuk following badge (kuning)
  followingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  followingStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  followingStatusBarItem.command = 'collab.unfollowUser';
  context.subscriptions.push(followingStatusBarItem);

  // ✅ Register TreeView sidebar "Collaborators"
  activityProvider = new UserActivityProvider();
  const treeView = vscode.window.createTreeView('collabUsers', {
    treeDataProvider: activityProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // ✅ Simpan context untuk dipakai di URI handler
  extensionContext = context;

  // ✅ Register URI handler untuk join via shareable link
  // Format: vscode://sitewhiz.live-collaboration/join?server=<url>&room=<roomId>
  const uriHandler: vscode.UriHandler = {
    handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
      console.log(`🔗 URI handler received: ${uri.toString()}`);

      if (uri.path === '/join') {
        const query = new URLSearchParams(uri.query);
        const serverUrl = query.get('server');
        const roomId = query.get('room');

        if (!serverUrl || !roomId) {
          vscode.window.showErrorMessage('❌ Link tidak valid! Parameter server dan room diperlukan.');
          return;
        }

        // Langsung simpan ke globalState agar bisa dibaca setelah VS Code reload
        context.globalState.update('collab.pendingJoinUrl', decodeURIComponent(serverUrl));
        context.globalState.update('collab.pendingRoomId', decodeURIComponent(roomId).toUpperCase().replace(/-/g, ''));

        // Langsung trigger join
        vscode.commands.executeCommand('collab.joinViaLink');
      }
    }
  };
  context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

  // ✅ Join via Link (internal command — dipanggil oleh URI handler atau saat startup)
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.joinViaLink', async () => {
      const pendingUrl = context.globalState.get<string>('collab.pendingJoinUrl');
      const pendingRoom = context.globalState.get<string>('collab.pendingRoomId');

      if (!pendingUrl || !pendingRoom) {
        return; // Tidak ada pending join
      }

      const serverUrl = pendingUrl;
      const roomId = pendingRoom;

      // Guard: cek apakah sudah ada session aktif
      if (socket && socket.connected && currentRoomId) {
        const action = await vscode.window.showWarningMessage(
          `⚠️ Kamu sudah terhubung ke room ${currentRoomId}. Hentikan session dulu sebelum join yang baru.`,
          'Stop & Join', 'Batal'
        );
        if (action === 'Stop & Join') {
          await vscode.commands.executeCommand('collab.stopSession');
        } else {
          return;
        }
      }

      // Cek apakah saat ini kita berada di temporary folder '.collab-session'
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const isCollabWorkspace = workspaceFolders && workspaceFolders.length > 0 && 
                                workspaceFolders[0].name.startsWith('.collab-session');

      if (!isCollabWorkspace) {
        // Jika bukan di temporary folder, kita BIKIN temporary folder lalu buka
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '.collab-session-'));
        const uri = vscode.Uri.file(tempDir);
        
        // Membuka folder ini akan ME-RELOAD VS Code
        await vscode.commands.executeCommand('vscode.openFolder', uri);
        return; // Stop eksekusi di sini karena window akan reload
      }

      // Jika kita sampai sini, artinya window sudah reload dan kita sudah di dalam temp folder
      // Bersihkan state pending join agar tidak looping
      context.globalState.update('collab.pendingJoinUrl', undefined);
      context.globalState.update('collab.pendingRoomId', undefined);

      // Cek Username
      let userId = context.globalState.get<string>('collab.userId', '');
      myUsername = context.globalState.get<string>('collab.username', '');

      if (!userId || !myUsername) {
        const username = await vscode.window.showInputBox({
          prompt: '👤 Masukkan nama kamu untuk join',
          placeHolder: 'Contoh: Budi, Sari...',
          validateInput: (val) => val.trim() === '' ? 'Nama tidak boleh kosong!' : null
        });
        if (!username) return;

        userId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        myUserId = userId;
        myUsername = username.trim();
        context.globalState.update('collab.userId', myUserId);
        context.globalState.update('collab.username', myUsername);
      } else {
        myUserId = userId;
      }

      // Tampilkan konfirmasi
      const confirm = await vscode.window.showInformationMessage(
        `🔗 Join room ${roomId} di ${serverUrl}?`,
        'Ya, Join!', 'Batal'
      );
      if (confirm !== 'Ya, Join!') return;

      // Simpan server URL
      context.globalState.update('collab.serverUrl', serverUrl);
      currentServerUrl = serverUrl;
      currentRoomId = roomId;

      // Connect & join (reuse logic dari joinSession)
      connectSocket(serverUrl);

      if (!socket) {
        vscode.window.showErrorMessage('❌ Gagal membuat koneksi socket!');
        return;
      }

      // Setup semua listener (sama seperti joinSession)
      setupJoinListeners(context);

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

      // Emit join-room
      const emitJoin = () => {
        if (!socket || !currentRoomId) return;
        socket.emit('join-room', {
          roomId: currentRoomId,
          userId: myUserId,
          username: myUsername,
        });
        vscode.window.showInformationMessage(
          `✅ Halo ${myUsername}! Bergabung ke room: ${currentRoomId} via link`
        );
      };
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

  // ✅ Pin Location — broadcast posisi cursor saat ini ke semua collaborator
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.pinLocation', async () => {
      if (!socket || !socket.connected || !currentRoomId) {
        vscode.window.showErrorMessage('❌ Belum terhubung! Start atau Join session dulu.');
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('❌ Tidak ada file yang terbuka!');
        return;
      }

      if (editor.document.uri.scheme !== 'file') {
        vscode.window.showErrorMessage('❌ Hanya bisa pin file biasa.');
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
      const position = editor.selection.active;

      // Optional: tambah pesan
      const message = await vscode.window.showInputBox({
        prompt: '💬 Tambah pesan (opsional)',
        placeHolder: 'Contoh: Lihat bug di baris ini...',
      });

      socket.emit('pin-location', {
        relativePath,
        line: position.line,
        character: position.character,
        message: message || '',
      });

      vscode.window.showInformationMessage(
        `📌 Pin dikirim: ${relativePath}:${position.line + 1}`
      );
    })
  );

  // ✅ Go to Pin — lompat ke pin terakhir yang diterima
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.goToPin', async () => {
      if (!lastReceivedPin) {
        vscode.window.showInformationMessage('📌 Belum ada pin yang diterima.');
        return;
      }

      await goToPinLocation(lastReceivedPin);
    })
  );

  // ✅ Copy Invite Link — generate shareable link dan copy ke clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.copyInviteLink', async () => {
      if (!currentRoomId || !currentServerUrl) {
        vscode.window.showErrorMessage('❌ Belum ada session aktif! Start session dulu.');
        return;
      }

      // Buat HTTP link (fallback browser)
      const httpLink = `${currentServerUrl}/join/${currentRoomId}`;

      await vscode.env.clipboard.writeText(httpLink);
      vscode.window.showInformationMessage(`📋 Link Invite Browser berhasil di-copy! Kirim ke collaborator.`);
    })
  );

  // ✅ Go to User — one-shot jump ke posisi user (tanpa persistent follow)
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.goToUser', async (item: UserItem) => {
      if (!item || !item.activity) return;
      const activity = item.activity;
      if (activity.userId === myUserId) {
        vscode.window.showInformationMessage('Itu posisi kamu sendiri.');
        return;
      }

      if (!activity.activeFile) {
        vscode.window.showInformationMessage(`${activity.username} belum membuka file.`);
        return;
      }

      await openAndScrollToUser(activity);
      vscode.window.showInformationMessage(
        `📍 Melompat ke posisi ${activity.username}: ${activity.activeFile}:${activity.activeLine + 1}`
      );
    })
  );

  // ✅ Follow User command — persistent follow mode
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.followUser', async (item: UserItem) => {
      if (!item || !item.activity) return;
      const activity = item.activity;
      if (activity.userId === myUserId) {
        vscode.window.showInformationMessage('Tidak bisa follow diri sendiri.');
        return;
      }

      // Toggle — kalau sudah follow user ini, unfollow
      if (followingUserId === activity.userId) {
        stopFollowing();
        return;
      }

      // Start following
      followingUserId = activity.userId;
      followingUsername = activity.username;

      // Tampilkan yellow badge di status bar
      updateFollowingBadge();

      // Tampilkan decoration "Following [username]" di editor
      updateFollowingDecoration();

      // Refresh sidebar agar icon berubah
      activityProvider?.refresh();

      vscode.window.showInformationMessage(
        `👁️ Following ${activity.username}...`
      );

      // Langsung scroll ke posisi user yang di-follow
      if (activity.activeFile) {
        await openAndScrollToUser(activity);
      }
    })
  );

  // ✅ Unfollow User command
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.unfollowUser', () => {
      if (!followingUserId) {
        vscode.window.showInformationMessage('Tidak sedang follow siapapun.');
        return;
      }
      const name = followingUsername;
      stopFollowing();
      vscode.window.showInformationMessage(`👁️ Berhenti follow ${name}.`);
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

  // ✅ Set Username
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.setUsername', async () => {
      const username = await vscode.window.showInputBox({
        prompt: '👤 Masukkan nama kamu',
        placeHolder: 'Contoh: Budi, Sari...',
        validateInput: (val) => val.trim() === '' ? 'Nama tidak boleh kosong!' : null
      });
      if (!username) return;

      // Auto-generate hidden User ID if not exists
      let userId = context.globalState.get('collab.userId', '');
      if (!userId) {
        userId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        context.globalState.update('collab.userId', userId);
      }

      myUserId = userId;
      myUsername = username.trim();
      context.globalState.update('collab.username', myUsername);

      vscode.window.showInformationMessage(`✅ Username diset sebagai: ${myUsername}`);
      updateStatusBar();
      activityProvider?.refresh();
    })
  );

  // ✅ Start Session
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.startSession', async () => {
      // Guard: cek apakah sudah ada session aktif
      if (socket && socket.connected && currentRoomId) {
        const action = await vscode.window.showWarningMessage(
          `⚠️ Kamu sudah terhubung ke room ${currentRoomId}. Hentikan session dulu sebelum memulai yang baru.`,
          'Stop Session', 'Batal'
        );
        if (action === 'Stop Session') {
          await vscode.commands.executeCommand('collab.stopSession');
        }
        return;
      }
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
        vscode.window.showErrorMessage('❌ Set Nama dulu! Jalankan "Set Username"');
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
            isHost = true; // ✅ Tandai sebagai host
            context.globalState.update('collab.lastRoomId', roomId);

            vscode.window.showInformationMessage(
              `🚀 Session dimulai! Bagikan link untuk mengundang teman.`,
              'Copy Invite Link'
            ).then(action => {
              if (action === 'Copy Invite Link') {
                vscode.commands.executeCommand('collab.copyInviteLink');
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
      socket.off('room-closed');
      socket.off('pin-location');

      // Terima perubahan dari user lain
      socket.on('text-change', (data: any) => {
        applyRemoteChange(data);
      });

      // Terima file baru yang dibuat guest
      socket.on('init-file', (data: any) => {
        if (!data || !data.relativePath || data.content === undefined) return;
        applyFullDocumentToFile(data.content, data.relativePath);
      });

      socket.on('create-folder', async (data: any) => {
        isApplyingRemoteChange = true;
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) return;
          const folderUri = vscode.Uri.joinPath(workspaceFolder.uri, data.relativePath);
          await vscode.workspace.fs.createDirectory(folderUri);
        } catch (e) {
          console.error('Gagal membuat folder:', e);
        } finally {
          isApplyingRemoteChange = false;
        }
      });

      socket.on('delete-file', async (data: any) => {
        isApplyingRemoteChange = true;
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) return;
          const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, data.relativePath);
          await vscode.workspace.fs.delete(targetUri, { recursive: true });
        } catch (e) {
          console.error('Gagal menghapus file/folder:', e);
        } finally {
          isApplyingRemoteChange = false;
        }
      });

      socket.on('rename-file', async (data: any) => {
        isApplyingRemoteChange = true;
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) return;
          const oldUri = vscode.Uri.joinPath(workspaceFolder.uri, data.oldPath);
          const newUri = vscode.Uri.joinPath(workspaceFolder.uri, data.newPath);
          await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: true });
        } catch (e) {
          console.error('Gagal merename file/folder:', e);
        } finally {
          isApplyingRemoteChange = false;
        }
      });

      socket.on('user-joined', async (data: any) => {
        vscode.window.showInformationMessage(
          `👤 ${data.username} bergabung!`
        );
        // Tambah ke daftar member
        roomMembers.set(data.userId, { username: data.username, status: 'idle' });
        // Tambah ke activity tracking (agar muncul di sidebar)
        userActivities.set(data.userId, {
          userId: data.userId,
          username: data.username,
          status: 'idle',
          activeFile: null,
          activeLine: 0,
          activeCharacter: 0,
          color: getColorForUser(data.userId),
        });
        updateStatusBar();
        activityProvider?.refresh();
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
        // Stop following jika user yang di-follow keluar
        if (followingUserId === data.userId) {
          stopFollowing();
        }
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
          // Auto-follow: scroll ke posisi user yang di-follow
          if (followingUserId === data.userId) {
            const updatedActivity = userActivities.get(data.userId);
            if (updatedActivity && updatedActivity.activeFile) {
              openAndScrollToUser(updatedActivity);
            }
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
          // Auto-follow: scroll ke posisi user yang di-follow
          if (followingUserId === data.userId) {
            openAndScrollToUser(activity);
          }
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

      // 📌 Terima pin location dari user lain
      socket.on('pin-location', (data: any) => {
        handlePinReceived(data);
      });

      setupDocumentSync();
      setupCursorTracking();
      setupActiveFileTracking();
    })
  );

  // ✅ Join Session
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.joinSession', async () => {
      // Guard: cek apakah sudah ada session aktif
      if (socket && socket.connected && currentRoomId) {
        const action = await vscode.window.showWarningMessage(
          `⚠️ Kamu sudah terhubung ke room ${currentRoomId}. Hentikan session dulu sebelum join yang baru.`,
          'Stop Session', 'Batal'
        );
        if (action === 'Stop Session') {
          await vscode.commands.executeCommand('collab.stopSession');
        }
        return;
      }

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
        vscode.window.showErrorMessage('❌ Set Nama dulu! Jalankan "Set Username"');
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
      setupJoinListeners(context);

      // ✅ Log koneksi untuk debugging
      socket.on('connect', () => {
        console.log(`✅ Socket connected for join! ID: ${socket?.id}`);
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
        console.log(`🔗 Emitting join-room: roomId=${currentRoomId}, userId=${myUserId}`);
        socket.emit('join-room', {
          roomId: currentRoomId,
          userId: myUserId,
          username: myUsername,
        });
        vscode.window.showInformationMessage(
          `✅ Halo ${myUsername}! Bergabung ke room: ${currentRoomId}`
        );
      };
      if (socket.connected) {
        emitJoin();
      } else {
        socket.once('connect', emitJoin);
        // ✅ Timeout: jika belum connect dalam 15 detik, tampilkan error
        setTimeout(() => {
          if (socket && !socket.connected) {
            vscode.window.showErrorMessage(
              `❌ Tidak bisa terhubung ke server ${serverUrl} dalam 15 detik. Pastikan server berjalan dan URL benar.`
            );
          }
        }, 15000);
      }

      setupDocumentSync();
      setupCursorTracking();
      setupActiveFileTracking();
    })
  );

  // ✅ Show Active Users
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.showActiveUsers', () => {
      if (!currentRoomId || userActivities.size === 0) {
        vscode.window.showInformationMessage('📋 Tidak ada session aktif atau belum ada user.');
        return;
      }
      const users = Array.from(userActivities.values()).map(a => {
        const status = a.status === 'typing' ? '✏️ mengetik' : '● online';
        const file = a.activeFile ? ` — ${a.activeFile}:${a.activeLine + 1}` : '';
        return `${a.username} ${status}${file}`;
      });
      vscode.window.showInformationMessage(
        `👥 Room ${currentRoomId}: ${users.join('  |  ')}`
      );
    })
  );

  // ✅ My Profile
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.myProfile', () => {
      const savedName = context.globalState.get('collab.username', '');
      if (!savedName) {
        vscode.window.showInformationMessage('❌ Belum set Username.');
        return;
      }
      vscode.window.showInformationMessage(
        `👤 Nama: ${savedName}`
      );
    })
  );

  // ✅ Reset User
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.resetUser', () => {
      context.globalState.update('collab.userId', undefined);
      context.globalState.update('collab.username', undefined);
      myUserId = '';
      myUsername = '';
      vscode.window.showInformationMessage('🔄 Data user direset!');
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
      if (fileCreateWatcherDisposable) {
        fileCreateWatcherDisposable.dispose();
        fileCreateWatcherDisposable = null;
      }
      if (fileSaveWatcherDisposable) {
        fileSaveWatcherDisposable.dispose();
        fileSaveWatcherDisposable = null;
      }
      if (fileDeleteWatcherDisposable) {
        fileDeleteWatcherDisposable.dispose();
        fileDeleteWatcherDisposable = null;
      }
      if (fileRenameWatcherDisposable) {
        fileRenameWatcherDisposable.dispose();
        fileRenameWatcherDisposable = null;
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
      // Bersihkan following mode
      stopFollowing();
      // Bersihkan pin
      clearPinDecoration();
      lastReceivedPin = null;
      currentRoomId = '';
      isHost = false; // Reset role
      roomMembers.clear();
      userActivities.clear();
      activityProvider?.refresh();
      if (activeEditorDisposable) {
        activeEditorDisposable.dispose();
        activeEditorDisposable = null;
      }
      updateStatusBar();
      // Bersihkan shared terminal
      stopSharingTerminal();
      if (terminalViewerPanel) {
        terminalViewerPanel.dispose();
        terminalViewerPanel = null;
      }
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

  // ✅ Share Terminal (host only)
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.shareTerminal', async () => {
      if (!socket || !socket.connected || !currentRoomId) {
        vscode.window.showErrorMessage('❌ Belum terhubung! Start session dulu.');
        return;
      }
      if (isTerminalSharing) {
        vscode.window.showWarningMessage('⚠️ Terminal sudah di-share.');
        return;
      }

      const allowInput = await vscode.window.showQuickPick(
        ['Read-only (guest hanya bisa melihat)', 'Allow Input (guest bisa mengetik)'],
        { placeHolder: '🖥️ Pilih mode share terminal' }
      );
      if (!allowInput) return;

      const allowInputFlag = allowInput.startsWith('Allow');

      const writeEmitter = new vscode.EventEmitter<string>();
      const closeEmitter = new vscode.EventEmitter<number | void>();
      sharedTerminalWriteEmitter = writeEmitter;

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || '.';
      const shellPath = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');

      // === Spawn shell process ===
      let ptyProcess: any = null;
      let shellProcess: any = null;
      let useNodePty = false;

      // Coba child_process langsung (paling stabil)
      try {
        const cp = require('child_process');
        const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoExit'] : [];
        shellProcess = cp.spawn(shellPath, shellArgs, {
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!shellProcess || !shellProcess.pid) {
          vscode.window.showErrorMessage('❌ Gagal memulai shell process.');
          return;
        }

        console.log(`🖥️ Shell spawned OK: PID=${shellProcess.pid}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`❌ Gagal membuat shell: ${err.message}`);
        return;
      }

      vscode.window.showInformationMessage('🖥️ Terminal sedang dimulai...');

      // === Fallback readline state (untuk child_process mode) ===
      let fallbackInputLine = '';
      let fallbackCursorPos = 0;
      const commandHistory: string[] = [];
      let historyIndex = -1;

      const getPrompt = () => {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        return `PS ${wsPath}> `;
      };

      // Helper: redraw baris input (clear current line, tulis ulang)
      const redrawLine = () => {
        // Pindah ke awal baris, hapus, tulis ulang
        writeEmitter.fire('\r\x1b[K'); // carriage return + clear line
        writeEmitter.fire(getPrompt()); // prompt
        writeEmitter.fire(fallbackInputLine);
        // Posisikan cursor
        const backCount = fallbackInputLine.length - fallbackCursorPos;
        if (backCount > 0) {
          writeEmitter.fire(`\x1b[${backCount}D`);
        }
      };

      // === Buat VS Code terminal dengan custom Pseudoterminal ===
      const customPty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => {
          writeEmitter.fire('🖥️ Shared Terminal — output di-share ke collaborator\r\n');
          writeEmitter.fire('   ↑↓ = History | ←→ = Cursor | Backspace | Ctrl+C\r\n\r\n');
          writeEmitter.fire(getPrompt());
        },
        close: () => {
          try { if (shellProcess) { shellProcess.kill(); } } catch {}
          stopSharingTerminal();
        },
        handleInput: (data: string) => {
          try {
            if (!shellProcess || shellProcess.killed) return;

            // === child_process fallback dengan readline ===
            if (data === '\r') {
              // Enter — kirim command
              writeEmitter.fire('\r\n');
              if (fallbackInputLine.trim()) {
                commandHistory.unshift(fallbackInputLine);
                if (commandHistory.length > 50) commandHistory.pop();
              }
              shellProcess.stdin.write(fallbackInputLine + '\n');
              fallbackInputLine = '';
              fallbackCursorPos = 0;
              historyIndex = -1;

            } else if (data.charCodeAt(0) === 127 || data.charCodeAt(0) === 8) {
              // Backspace
              if (fallbackCursorPos > 0) {
                fallbackInputLine = fallbackInputLine.slice(0, fallbackCursorPos - 1) + fallbackInputLine.slice(fallbackCursorPos);
                fallbackCursorPos--;
                redrawLine();
              }

            } else if (data === '\x03') {
              // Ctrl+C — interrupt current command tanpa kill shell
              writeEmitter.fire('^C\r\n');
              fallbackInputLine = '';
              fallbackCursorPos = 0;
              historyIndex = -1;
              
              // Kirim \x03\n agar shell mengevaluasi ^C tanpa mati (karena tanpa PTY, kill SIGINT akan mematikan shell)
              try { shellProcess.stdin.write('\x03\n'); } catch {}
              
              writeEmitter.fire(getPrompt());

            } else if (data === '\x1b[A') {
              // Arrow Up — history sebelumnya
              if (commandHistory.length > 0 && historyIndex < commandHistory.length - 1) {
                historyIndex++;
                fallbackInputLine = commandHistory[historyIndex];
                fallbackCursorPos = fallbackInputLine.length;
                redrawLine();
              }

            } else if (data === '\x1b[B') {
              // Arrow Down — history berikutnya
              if (historyIndex > 0) {
                historyIndex--;
                fallbackInputLine = commandHistory[historyIndex];
                fallbackCursorPos = fallbackInputLine.length;
                redrawLine();
              } else if (historyIndex === 0) {
                historyIndex = -1;
                fallbackInputLine = '';
                fallbackCursorPos = 0;
                redrawLine();
              }

            } else if (data === '\x1b[C') {
              // Arrow Right
              if (fallbackCursorPos < fallbackInputLine.length) {
                fallbackCursorPos++;
                writeEmitter.fire('\x1b[C');
              }

            } else if (data === '\x1b[D') {
              // Arrow Left
              if (fallbackCursorPos > 0) {
                fallbackCursorPos--;
                writeEmitter.fire('\x1b[D');
              }

            } else if (data === '\x1b[H' || data === '\x1b[1~') {
              // Home
              if (fallbackCursorPos > 0) {
                writeEmitter.fire(`\x1b[${fallbackCursorPos}D`);
                fallbackCursorPos = 0;
              }

            } else if (data === '\x1b[F' || data === '\x1b[4~') {
              // End
              const diff = fallbackInputLine.length - fallbackCursorPos;
              if (diff > 0) {
                writeEmitter.fire(`\x1b[${diff}C`);
                fallbackCursorPos = fallbackInputLine.length;
              }

            } else if (data === '\x1b[3~') {
              // Delete key
              if (fallbackCursorPos < fallbackInputLine.length) {
                fallbackInputLine = fallbackInputLine.slice(0, fallbackCursorPos) + fallbackInputLine.slice(fallbackCursorPos + 1);
                redrawLine();
              }

            } else if (!data.startsWith('\x1b') && data.charCodeAt(0) >= 32) {
              // Printable karakter — insert di posisi cursor
              fallbackInputLine = fallbackInputLine.slice(0, fallbackCursorPos) + data + fallbackInputLine.slice(fallbackCursorPos);
              fallbackCursorPos += data.length;
              redrawLine();
            }
          } catch {}
        },
      };

      sharedTerminal = vscode.window.createTerminal({ name: '🖥️ Shared Terminal', pty: customPty });
      sharedTerminal.show();

      // === Buffer untuk mengurangi socket emit (anti-lag) ===
      let terminalBuffer = '';
      let bufferTimer: ReturnType<typeof setTimeout> | null = null;
      const BUFFER_INTERVAL = 50;

      const flushBuffer = () => {
        if (terminalBuffer.length > 0 && socket && socket.connected) {
          socket.emit('terminal-data', { data: terminalBuffer });
          terminalBuffer = '';
        }
        bufferTimer = null;
      };

      const bufferAndSend = (str: string) => {
        writeEmitter.fire(str);
        terminalBuffer += str;
        if (!bufferTimer) {
          bufferTimer = setTimeout(flushBuffer, BUFFER_INTERVAL);
        }
      };

      // === Capture output ===
      let promptTimer: ReturnType<typeof setTimeout> | null = null;
      const showPromptAfterOutput = () => {
        if (!useNodePty) {
          if (promptTimer) clearTimeout(promptTimer);
          promptTimer = setTimeout(() => {
            writeEmitter.fire(getPrompt());
          }, 300);
        }
      };

      // === Capture output ===
      shellProcess.stdout.on('data', (chunk: Buffer) => {
        if (promptTimer) clearTimeout(promptTimer);
        const str = chunk.toString().replace(/(?<!\r)\n/g, '\r\n');
        bufferAndSend(str);
        showPromptAfterOutput();
      });
      shellProcess.stderr.on('data', (chunk: Buffer) => {
        if (promptTimer) clearTimeout(promptTimer);
        const str = chunk.toString().replace(/(?<!\r)\n/g, '\r\n');
        bufferAndSend(str);
        showPromptAfterOutput();
      });
      shellProcess.on('exit', (code: number) => {
        if (promptTimer) clearTimeout(promptTimer);
        flushBuffer();
        writeEmitter.fire(`\r\n[Process exited with code ${code}]\r\n`);
        closeEmitter.fire(code);
      });
      shellProcess.on('error', (err: any) => {
        vscode.window.showErrorMessage(`❌ Shell error: ${err.message}`);
      });

      // Listen command request dari guest (staging — host harus approve)
      if (allowInputFlag) {
        console.log('🖥️ [HOST] Registering terminal-command-request listener');
        let pendingCommandTimeout: ReturnType<typeof setTimeout> | null = null;
        let pendingCommandResolved = false;

        socket.on('terminal-command-request', (reqData: any) => {
          if (reqData.data?.includes('PS>')) return; // Abaikan pantulan prompt
          if (reqData.data?.trim() === '') {
            writeEmitter.fire('\r\n');
            writeEmitter.fire(getPrompt());
            return;
          }
          console.log('🖥️ [HOST] Received command request:', reqData);
          if (!reqData?.command || !shellProcess || shellProcess.killed) {
            console.log('🖥️ [HOST] Rejected: missing data or shell killed');
            return;
          }
          const cmd = reqData.command;
          const guestName = reqData.username || 'Guest';
          pendingCommandResolved = false;

          // Auto-reject setelah 30 detik
          if (pendingCommandTimeout) clearTimeout(pendingCommandTimeout);
          pendingCommandTimeout = setTimeout(() => {
            if (!pendingCommandResolved) {
              pendingCommandResolved = true;
              writeEmitter.fire(`\r\n\x1b[33m[AUTO] Command dari ${guestName} ditolak otomatis (timeout 30 detik)\x1b[0m\r\n`);
              if (socket && socket.connected) {
                socket.emit('terminal-command-rejected', {
                  command: cmd,
                  username: guestName,
                  reason: 'timeout',
                });
              }
            }
          }, 30000);

          vscode.window.showWarningMessage(
            `🖥️ ${guestName} ingin menjalankan: "${cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd}" (auto-tolak dalam 30 detik)`,
            'Izinkan', 'Tolak'
          ).then(action => {
            if (pendingCommandResolved) return; // Sudah di-timeout atau di-cancel
            pendingCommandResolved = true;
            if (pendingCommandTimeout) clearTimeout(pendingCommandTimeout);

            if (action === 'Izinkan') {
              try {
                if (shellProcess && !shellProcess.killed) {
                  shellProcess.stdin.write(cmd + '\n');
                }
                writeEmitter.fire(`\r\n\x1b[36m[${guestName}]\x1b[0m $ ${cmd}\r\n`);
              } catch {}
              // Notify guest command approved
              if (socket && socket.connected) {
                socket.emit('terminal-command-approved', { command: cmd, username: guestName });
              }
            } else {
              // Beritahu guest bahwa command ditolak
              if (socket && socket.connected) {
                socket.emit('terminal-command-rejected', {
                  command: cmd,
                  username: guestName,
                  reason: 'rejected',
                });
              }
            }
          });
        });

        // Guest membatalkan command yang pending
        socket.on('terminal-command-cancel', (cancelData: any) => {
          if (pendingCommandTimeout) clearTimeout(pendingCommandTimeout);
          pendingCommandResolved = true;
          const guestName = cancelData?.username || 'Guest';
          writeEmitter.fire(`\r\n\x1b[33m[${guestName}] Membatalkan command request\x1b[0m\r\n`);
        });
      }

      // Store process reference untuk cleanup
      (sharedTerminal as any)._shellProcess = shellProcess;

      isTerminalSharing = true;

      // Emit terminal-start ke server (dengan acknowledgment)
      console.log('🖥️ Emitting terminal-start to server...');
      socket.emit('terminal-start', { allowInput: allowInputFlag }, (response: any) => {
        if (response && response.ok) {
          console.log(`🖥️ Server acknowledged: ${response.guestCount} guests notified`);
          vscode.window.showInformationMessage(
            `🖥️ Terminal di-share! ${response.guestCount} guest akan menerima.`
          );
        } else {
          console.error('🖥️ Server did NOT acknowledge terminal-start:', response);
          vscode.window.showWarningMessage(
            `⚠️ Server belum menerima terminal-start. Pastikan server sudah di-restart!`
          );
        }
      });

      // Track terminal close
      terminalDataListener = vscode.window.onDidCloseTerminal((t) => {
        if (t === sharedTerminal) {
          stopSharingTerminal();
        }
      });

      vscode.window.showInformationMessage(
        `🖥️ Terminal di-share ke room! Mode: ${allowInputFlag ? 'Allow Input' : 'Read-only'}`
      );
    })
  );

  // ✅ Stop Share Terminal
  context.subscriptions.push(
    vscode.commands.registerCommand('collab.stopShareTerminal', () => {
      if (!isTerminalSharing) {
        vscode.window.showWarningMessage('⚠️ Tidak ada terminal yang sedang di-share.');
        return;
      }
      stopSharingTerminal();
      vscode.window.showInformationMessage('🖥️ Share terminal dihentikan.');
    })
  );

  // ✅ AUTO-JOIN LOGIC
  // Cek apakah ada pending join dari URI handler sebelum VS Code di-reload
  const pendingUrl = context.globalState.get<string>('collab.pendingJoinUrl');
  if (pendingUrl) {
    // Beri jeda sedikit agar workspace selesai loading
    setTimeout(() => {
      vscode.commands.executeCommand('collab.joinViaLink');
    }, 1500);
  }
}


// ─────────────────────────────────────────
// SHARED TERMINAL HELPERS
// ─────────────────────────────────────────

function stopSharingTerminal() {
  if (!isTerminalSharing) return;

  // Kill process (node-pty atau child_process)
  if (sharedTerminal) {
    try {
      const pp = (sharedTerminal as any)._ptyProcess;
      if (pp) { pp.kill(); }
      const sp = (sharedTerminal as any)._shellProcess;
      if (sp && !sp.killed) { sp.kill(); }
    } catch { /* ignore */ }
    sharedTerminal.dispose();
    sharedTerminal = null;
  }

  if (sharedTerminalWriteEmitter) {
    sharedTerminalWriteEmitter.dispose();
    sharedTerminalWriteEmitter = null;
  }

  if (terminalDataListener) {
    terminalDataListener.dispose();
    terminalDataListener = null;
  }

  isTerminalSharing = false;

  // Notify server
  if (socket && socket.connected) {
    socket.emit('terminal-stop');
    socket.off('terminal-command-request');
    socket.off('terminal-command-rejected');
    socket.off('terminal-command-approved');
    socket.off('terminal-command-cancel');
  }
}

function openTerminalViewer(hostUsername: string, allowInput: boolean) {
  // Tutup panel lama kalau ada
  if (terminalViewerPanel) {
    terminalViewerPanel.dispose();
  }

  terminalViewerPanel = vscode.window.createWebviewPanel(
    'sharedTerminalViewer',
    `🖥️ Terminal — ${hostUsername}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  terminalViewerPanel.webview.html = getTerminalViewerHtml(hostUsername, allowInput);

  // Handle pesan dari webview (input dari guest)
  terminalViewerPanel.webview.onDidReceiveMessage((message: any) => {
    if (message.type === 'terminal-command' && allowInput && socket && socket.connected) {
      // Guest mengirim full command untuk di-staging ke host
      socket.emit('terminal-command-request', {
        command: message.command,
        userId: myUserId,
        username: myUsername,
      });
    } else if (message.type === 'terminal-command-cancel' && allowInput && socket && socket.connected) {
      // Guest membatalkan command pending
      socket.emit('terminal-command-cancel', {
        userId: myUserId,
        username: myUsername,
      });
    }
  });

  // Listen untuk command rejected/approved
  if (allowInput && socket) {
    socket.on('terminal-command-rejected', (data: any) => {
      if (terminalViewerPanel) {
        terminalViewerPanel.webview.postMessage({
          type: 'command-rejected',
          command: data.command,
          reason: data.reason || 'rejected',
        });
      }
    });
    socket.on('terminal-command-approved', (data: any) => {
      if (terminalViewerPanel) {
        terminalViewerPanel.webview.postMessage({
          type: 'command-approved',
          command: data.command,
        });
      }
    });
  }

  terminalViewerPanel.onDidDispose(() => {
    terminalViewerPanel = null;
  });
}

function getTerminalViewerHtml(hostUsername: string, allowInput: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shared Terminal — ${hostUsername}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1e1e1e;
      color: #cccccc;
      font-family: 'Consolas', 'Courier New', monospace;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .header {
      background: #252526;
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid #333;
      flex-shrink: 0;
    }
    .header .title {
      font-size: 11px;
      color: #9cdcfe;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .header .badge {
      background: ${allowInput ? '#1e4620' : '#4d4d4d'};
      color: ${allowInput ? '#4CAF50' : '#cccccc'};
      border: 1px solid ${allowInput ? '#4CAF50' : '#888'};
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 3px;
      margin-left: auto;
      text-transform: uppercase;
    }
    #terminal-container {
      flex: 1;
      padding: 8px 4px 4px 8px;
      overflow: hidden;
    }
    .xterm { height: 100%; }
  </style>
</head>
<body>
  <div class="header">
    <span class="title">Terminal: ${hostUsername}</span>
    <span class="badge">${allowInput ? 'Input Enabled' : 'Read Only'}</span>
  </div>
  <div id="terminal-container"></div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    const vscodeApi = acquireVsCodeApi();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#d7ba7d',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    // Resize on window resize
    window.addEventListener('resize', () => fitAddon.fit());

    // Handle input from guest (jika allowInput)
    ${allowInput ? `
    let guestInput = '';
    let guestCursorPos = 0;
    let waitingApproval = false;
    const guestHistory = [];
    let guestHistoryIdx = -1;
    term.writeln('\\x1b[32m[ Input mode — ketik command lalu Enter. Host akan memvalidasi. ]\\x1b[0m');
    term.writeln('\\x1b[32m[ ↑↓ = History | ←→ = Cursor | Ctrl+C = Batal ]\\x1b[0m');
    term.write('\\r\\n\\x1b[36m> \\x1b[0m');

    // Helper: redraw guest input line
    function redrawGuestLine() {
      term.write('\\r\\x1b[K'); // clear line
      term.write('\\x1b[36m> \\x1b[0m'); // prompt
      term.write(guestInput);
      const back = guestInput.length - guestCursorPos;
      if (back > 0) term.write('\\x1b[' + back + 'D');
    }

    term.onData((data) => {
      if (data === '\\r') {
        if (waitingApproval) return;
        if (guestInput.trim()) {
          guestHistory.unshift(guestInput.trim());
          if (guestHistory.length > 30) guestHistory.pop();
          term.write('\\r\\n\\x1b[33m⏳ Menunggu persetujuan host... (Ctrl+C untuk batal, auto-tolak 30 detik)\\x1b[0m\\r\\n');
          vscodeApi.postMessage({ type: 'terminal-command', command: guestInput.trim() });
          waitingApproval = true;
        } else {
          term.write('\\r\\n\\x1b[36m> \\x1b[0m');
        }
        guestInput = '';
        guestCursorPos = 0;
        guestHistoryIdx = -1;
      } else if (data === '\\x03') {
        if (waitingApproval) {
          vscodeApi.postMessage({ type: 'terminal-command-cancel' });
          term.writeln('\\r\\n\\x1b[33m⚠️ Request dibatalkan.\\x1b[0m');
          waitingApproval = false;
        } else {
          term.write('^C');
        }
        guestInput = '';
        guestCursorPos = 0;
        guestHistoryIdx = -1;
        term.write('\\r\\n\\x1b[36m> \\x1b[0m');
      } else if (data === '\\x1b[A') {
        // Arrow Up — history
        if (waitingApproval) return;
        if (guestHistory.length > 0 && guestHistoryIdx < guestHistory.length - 1) {
          guestHistoryIdx++;
          guestInput = guestHistory[guestHistoryIdx];
          guestCursorPos = guestInput.length;
          redrawGuestLine();
        }
      } else if (data === '\\x1b[B') {
        // Arrow Down — history
        if (waitingApproval) return;
        if (guestHistoryIdx > 0) {
          guestHistoryIdx--;
          guestInput = guestHistory[guestHistoryIdx];
          guestCursorPos = guestInput.length;
          redrawGuestLine();
        } else if (guestHistoryIdx === 0) {
          guestHistoryIdx = -1;
          guestInput = '';
          guestCursorPos = 0;
          redrawGuestLine();
        }
      } else if (data === '\\x1b[C') {
        // Arrow Right
        if (waitingApproval) return;
        if (guestCursorPos < guestInput.length) {
          guestCursorPos++;
          term.write('\\x1b[C');
        }
      } else if (data === '\\x1b[D') {
        // Arrow Left
        if (waitingApproval) return;
        if (guestCursorPos > 0) {
          guestCursorPos--;
          term.write('\\x1b[D');
        }
      } else if (data.charCodeAt(0) === 127 || data.charCodeAt(0) === 8) {
        if (waitingApproval) return;
        if (guestCursorPos > 0) {
          guestInput = guestInput.slice(0, guestCursorPos - 1) + guestInput.slice(guestCursorPos);
          guestCursorPos--;
          redrawGuestLine();
        }
      } else if (data.charCodeAt(0) >= 32) {
        if (waitingApproval) return;
        guestInput = guestInput.slice(0, guestCursorPos) + data + guestInput.slice(guestCursorPos);
        guestCursorPos += data.length;
        redrawGuestLine();
      }
    });

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'command-rejected') {
        waitingApproval = false;
        if (msg.reason === 'timeout') {
          term.writeln('\\x1b[31m⏰ Command auto-ditolak (host tidak merespon dalam 30 detik)\\x1b[0m');
        } else {
          term.writeln('\\x1b[31m❌ Host menolak command: ' + msg.command + '\\x1b[0m');
        }
        term.write('\\x1b[36m> \\x1b[0m');
      } else if (msg.type === 'command-approved') {
        waitingApproval = false;
        term.writeln('\\x1b[32m✅ Command disetujui dan dijalankan!\\x1b[0m');
        term.write('\\x1b[36m> \\x1b[0m');
      }
    });
    ` : `
    term.writeln('\\x1b[33m[ Read-only mode — kamu hanya bisa melihat ]\\x1b[0m\\r\\n');
    `}

    // Receive data from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'terminal-data') {
        term.write(msg.data);
      } else if (msg.type === 'terminal-resize') {
        term.resize(msg.cols, msg.rows);
      }
    });
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────
// SETUP JOIN LISTENERS (shared for joinSession & joinViaLink)
// ─────────────────────────────────────────

function setupJoinListeners(context: vscode.ExtensionContext) {
  if (!socket) return;

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
  socket.off('room-closed');
  socket.off('host-disconnected');
  socket.off('host-reconnected');
  socket.off('terminal-started');
  socket.off('terminal-data');
  socket.off('terminal-stopped');
  socket.off('terminal-resize');
  socket.off('pin-location');
  socket.off('create-folder');
  socket.off('delete-file');
  socket.off('rename-file');

  // Terima dokumen awal dari host (legacy single file)
  socket.on('init-document', (data: any) => {
    if (!data) return;
    if (typeof data === 'string') {
      applyFullDocument(data);
    } else if (data.relativePath && data.content) {
      applyFullDocumentToFile(data.content, data.relativePath);
    }
  });

  // Terima file individual dari host saat join (legacy)
  socket.on('init-file', (data: any) => {
    if (!data || !data.relativePath || data.content === undefined) return;
    applyFullDocumentToFile(data.content, data.relativePath);
  });

  // Terima seluruh project dalam satu batch saat pertama kali join
  socket.on('init-project', async (data: { files: { relativePath: string; content: string }[] }) => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder || !data.files || data.files.length === 0) return;

    isApplyingRemoteChange = true;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '📥 Mengunduh workspace...',
          cancellable: false,
        },
        async (progress) => {
          for (let i = 0; i < data.files.length; i++) {
            const file = data.files[i];
            try {
              const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file.relativePath);
              await vscode.workspace.fs.writeFile(fileUri, Buffer.from(file.content, 'utf-8'));
            } catch (e) {
              console.error(e);
            }
            if (i % 10 === 0 || i === data.files.length - 1) { // report UI periodically
              progress.report({
                increment: (100 / data.files.length) * (i % 10 === 0 ? 10 : data.files.length % 10),
                message: `${i + 1}/${data.files.length} file...`,
              });
            }
          }
        }
      );
      vscode.window.showInformationMessage(`✅ Workspace sinkronisasi selesai (${data.files.length} file).`);
    } finally {
      // Tunggu sedikit agar FS watcher OS tidak menangkap writeFile sebagai creation manual
      setTimeout(() => { isApplyingRemoteChange = false; }, 1000);
    }
  });

  socket.on('create-folder', async (data: any) => {
    isApplyingRemoteChange = true;
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;
      const folderUri = vscode.Uri.joinPath(workspaceFolder.uri, data.relativePath);
      await vscode.workspace.fs.createDirectory(folderUri);
    } catch (e) {
      console.error('Gagal membuat folder:', e);
    } finally {
      isApplyingRemoteChange = false;
    }
  });

  socket.on('delete-file', async (data: any) => {
    isApplyingRemoteChange = true;
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;
      const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, data.relativePath);
      await vscode.workspace.fs.delete(targetUri, { recursive: true });
    } catch (e) {
      console.error('Gagal menghapus file/folder:', e);
    } finally {
      isApplyingRemoteChange = false;
    }
  });

  socket.on('rename-file', async (data: any) => {
    isApplyingRemoteChange = true;
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;
      const oldUri = vscode.Uri.joinPath(workspaceFolder.uri, data.oldPath);
      const newUri = vscode.Uri.joinPath(workspaceFolder.uri, data.newPath);
      await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: true });
    } catch (e) {
      console.error('Gagal merename file/folder:', e);
    } finally {
      isApplyingRemoteChange = false;
    }
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
    removeRemoteCursor(data.userId);
    userActivities.delete(data.userId);
    activityProvider?.refresh();
    if (followingUserId === data.userId) {
      stopFollowing();
    }
  });

  socket.on('connect_error', (err: any) => {
    vscode.window.showErrorMessage(
      `❌ Gagal konek ke ${currentServerUrl}: ${err.message}`
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
      if (followingUserId === data.userId) {
        const updatedActivity = userActivities.get(data.userId);
        if (updatedActivity && updatedActivity.activeFile) {
          openAndScrollToUser(updatedActivity);
        }
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
      if (followingUserId === data.userId) {
        openAndScrollToUser(activity);
      }
    }
  });

  // 📌 Terima pin location dari user lain
  socket.on('pin-location', (data: any) => {
    handlePinReceived(data);
  });

  // 🔒 Handle room-closed — host disconnect (setelah 30 detik)
  socket.on('room-closed', (data: any) => {
    handleRoomClosed(data);
  });

  // ⏳ Host sementara disconnect — tampilkan warning
  socket.on('host-disconnected', (data: any) => {
    vscode.window.showWarningMessage(
      `⏳ ${data.message || 'Host terputus. Menunggu reconnect...'}`,
    );
  });

  // ✅ Host kembali online
  socket.on('host-reconnected', (data: any) => {
    vscode.window.showInformationMessage(
      `✅ Host (${data.username}) telah kembali online!`
    );
  });

  // 🖥️ Shared Terminal — host memulai share terminal
  socket.on('terminal-started', (data: any) => {
    console.log('🖥️ [GUEST] Received terminal-started event:', data);
    vscode.window.showInformationMessage(
      `🖥️ ${data.hostUsername} membagikan terminal!`,
      'Buka Terminal'
    ).then(action => {
      if (action === 'Buka Terminal') {
        openTerminalViewer(data.hostUsername, data.allowInput);
      }
    });
    openTerminalViewer(data.hostUsername, data.allowInput);
  });

  // 🖥️ Shared Terminal — terima data output
  socket.on('terminal-data', (data: any) => {
    if (terminalViewerPanel && data?.data) {
      terminalViewerPanel.webview.postMessage({ type: 'terminal-data', data: data.data });
    }
  });

  // 🖥️ Shared Terminal — host stop share
  socket.on('terminal-stopped', (data: any) => {
    if (terminalViewerPanel) {
      terminalViewerPanel.dispose();
      terminalViewerPanel = null;
    }
    vscode.window.showInformationMessage(
      `🖥️ ${data.hostUsername} menghentikan share terminal.`
    );
  });

  // 🖥️ Shared Terminal — resize
  socket.on('terminal-resize', (data: any) => {
    if (terminalViewerPanel && data?.cols && data?.rows) {
      terminalViewerPanel.webview.postMessage({ type: 'terminal-resize', cols: data.cols, rows: data.rows });
    }
  });
}

// ─────────────────────────────────────────
// PIN LOCATION HELPERS
// ─────────────────────────────────────────

function handlePinReceived(data: PinLocation) {
  if (!data || !data.relativePath) return;

  lastReceivedPin = data;
  const isMe = data.userId === myUserId;

  // Tampilkan notifikasi (kecuali dari diri sendiri)
  if (!isMe) {
    const msgParts = [`📌 ${data.username} mengirim pin: ${data.relativePath}:${data.line + 1}`];
    if (data.message) {
      msgParts.push(`💬 "${data.message}"`);
    }

    vscode.window.showInformationMessage(
      msgParts.join(' — '),
      'Go to Pin'
    ).then(action => {
      if (action === 'Go to Pin') {
        goToPinLocation(data);
      }
    });
  }

  // Tampilkan pin decoration di editor jika file yang di-pin sedang terbuka
  showPinDecoration(data);

  // Refresh sidebar
  activityProvider?.refresh();
}

async function goToPinLocation(pin: PinLocation) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, pin.relativePath);

  try {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });

    const line = Math.min(pin.line, doc.lineCount - 1);
    const lineText = doc.lineAt(line).text;
    const char = Math.min(pin.character, lineText.length);

    const position = new vscode.Position(line, char);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter
    );

    // Tampilkan pin decoration di editor
    showPinDecoration(pin);
  } catch {
    vscode.window.showErrorMessage(`❌ File "${pin.relativePath}" tidak ditemukan.`);
  }
}

function showPinDecoration(pin: PinLocation) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const currentRelativePath = vscode.workspace.asRelativePath(editor.document.uri);
  if (currentRelativePath !== pin.relativePath) return;

  // Hapus decoration lama
  clearPinDecoration();

  const line = Math.min(pin.line, editor.document.lineCount - 1);

  // Pin gutter decoration (📌 icon)
  pinGutterDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: undefined, // VS Code doesn't support emoji in gutter, use color instead
    overviewRulerColor: '#FF6B6B',
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    isWholeLine: true,
    backgroundColor: 'rgba(255, 107, 107, 0.1)',
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: '#FF6B6B',
  });

  // Pin label decoration
  const msgText = pin.message ? ` — "${pin.message}"` : '';
  pinDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: ` 📌 ${pin.username}${msgText}`,
      color: '#ffffff',
      backgroundColor: '#FF6B6B',
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: `;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 4px;
        margin-left: 8px;
      `,
    },
  });

  const range = new vscode.Range(line, 0, line, 0);
  editor.setDecorations(pinGutterDecorationType, [range]);
  editor.setDecorations(pinDecorationType, [range]);

  // Auto-hide pin decoration setelah 30 detik
  setTimeout(() => {
    clearPinDecoration();
  }, 30000);
}

function clearPinDecoration() {
  if (pinDecorationType) {
    pinDecorationType.dispose();
    pinDecorationType = null;
  }
  if (pinGutterDecorationType) {
    pinGutterDecorationType.dispose();
    pinGutterDecorationType = null;
  }
}

// ─────────────────────────────────────────
// SOCKET CONNECTION
// ─────────────────────────────────────────

function connectSocket(serverUrl: string) {
  // ✅ Reuse socket kalau sudah terkoneksi ke server yang sama
  if (socket && currentServerUrl === serverUrl) {
    if (socket.connected) {
      console.log('♻️ Reuse existing socket connection');
      return;
    }
    // Socket ada tapi tidak connected — disconnect dulu, buat baru
    socket.disconnect();
    socket = null;
  }

  // Putuskan socket lama kalau ada (berbeda server)
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  socket = io(serverUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity, // ✅ Jangan pernah menyerah reconnect
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    transports: ['websocket', 'polling'],
    withCredentials: false,
    extraHeaders: {
      'ngrok-skip-browser-warning': 'true',
    },
  });

  // ✅ Log disconnect untuk debugging
  socket.on('disconnect', (reason: string) => {
    console.log(`⚠️ Socket disconnected: ${reason}`);
    vscode.window.showWarningMessage(
      `⚠️ Koneksi terputus: ${reason}. Auto-reconnecting...`
    );
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
    if (attempt % 5 === 1) { // Hanya tampilkan setiap 5 percobaan
      vscode.window.showWarningMessage(
        `⚠️ Reconnecting... (percobaan ke-${attempt})`
      );
    }
  });

  socket.on('reconnect_failed', () => {
    vscode.window.showErrorMessage(
      '❌ Gagal reconnect! Session akan dihentikan.'
    );
    // Bersihkan state saat gagal reconnect
    handleRoomClosed({ reason: 'Koneksi ke server terputus dan gagal reconnect.' });
  });
}

// ─────────────────────────────────────────
// DOCUMENT SYNC
// ─────────────────────────────────────────

function setupDocumentSync() {
  if (docSyncDisposable) {
    docSyncDisposable.dispose();
  }
  if (fileCreateWatcherDisposable) {
    fileCreateWatcherDisposable.dispose();
  }
  if (fileSaveWatcherDisposable) {
    fileSaveWatcherDisposable.dispose();
  }

  if (fileDeleteWatcherDisposable) {
    fileDeleteWatcherDisposable.dispose();
  }
  if (fileRenameWatcherDisposable) {
    fileRenameWatcherDisposable.dispose();
  }

  // 1️⃣ Sync perubahan teks real-time
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

    // Auto-unfollow saat user lokal mengetik
    if (followingUserId) {
      stopFollowing();
    }
  });

  // 2️⃣ Sync file/folder baru yang dibuat oleh user (Semua User)
  fileCreateWatcherDisposable = vscode.workspace.onDidCreateFiles(async (event) => {
    if (isApplyingRemoteChange) return;
    if (!socket || !socket.connected) return;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    for (const fileUri of event.files) {
      if (fileUri.scheme !== 'file') continue;

      const relativePath = vscode.workspace.asRelativePath(fileUri);

      // Skip file di folder yang dikecualikan
      if (relativePath.includes('node_modules/') ||
        relativePath.includes('.git/') ||
        relativePath.includes('out/') ||
        relativePath.includes('dist/') ||
        relativePath.includes('.vscode/')) {
        continue;
      }

      try {
        const stat = await vscode.workspace.fs.stat(fileUri);
        if (stat.type === vscode.FileType.Directory) {
          socket.emit('create-folder', { relativePath, userId: myUserId, username: myUsername });
          console.log(`📁 Folder baru dibuat dan di-sync: ${relativePath}`);
        } else {
          const rawBytes = await vscode.workspace.fs.readFile(fileUri);
          const content = Buffer.from(rawBytes).toString('utf-8');
          socket.emit('sync-document', {
            relativePath,
            content,
            userId: myUserId,
            username: myUsername,
          });
          console.log(`🆕 File baru dibuat dan di-sync: ${relativePath}`);
        }
      } catch (err) {
        console.error(`❌ Gagal baca/sync item baru ${relativePath}:`, err);
      }
    }
  });

  // 3️⃣ Sync file saat disimpan (Semua User)
  fileSaveWatcherDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
    if (isApplyingRemoteChange) return;
    if (!socket || !socket.connected) return;
    if (document.uri.scheme !== 'file') return;

    const relativePath = vscode.workspace.asRelativePath(document.uri);

    // Skip file di folder yang dikecualikan
    if (relativePath.includes('node_modules/') ||
      relativePath.includes('.git/') ||
      relativePath.includes('out/') ||
      relativePath.includes('dist/') ||
      relativePath.includes('.vscode/')) {
      return;
    }

    // Kirim full content saat save
    socket.emit('sync-document', {
      relativePath,
      content: document.getText(),
      userId: myUserId,
      username: myUsername,
    });

    console.log(`💾 File disimpan dan di-sync: ${relativePath}`);
  });

  // 4️⃣ Sync penghapusan file/folder (Semua User)
  fileDeleteWatcherDisposable = vscode.workspace.onDidDeleteFiles(async (event) => {
    if (isApplyingRemoteChange) return;
    if (!socket || !socket.connected) return;

    for (const fileUri of event.files) {
      if (fileUri.scheme !== 'file') continue;
      const relativePath = vscode.workspace.asRelativePath(fileUri);
      socket.emit('delete-file', { relativePath, userId: myUserId, username: myUsername });
      console.log(`🗑️ Item dihapus dan di-sync: ${relativePath}`);
    }
  });

  // 5️⃣ Sync perubahan nama (rename) file/folder (Semua User)
  fileRenameWatcherDisposable = vscode.workspace.onDidRenameFiles(async (event) => {
    if (isApplyingRemoteChange) return;
    if (!socket || !socket.connected) return;

    for (const file of event.files) {
      if (file.oldUri.scheme !== 'file' || file.newUri.scheme !== 'file') continue;
      const oldPath = vscode.workspace.asRelativePath(file.oldUri);
      const newPath = vscode.workspace.asRelativePath(file.newUri);
      socket.emit('rename-file', { oldPath, newPath, userId: myUserId, username: myUsername });
      console.log(`✏️ Item di-rename dan di-sync: ${oldPath} -> ${newPath}`);
    }
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
    isApplyingRemoteChange = true;
    try {
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
    } finally {
      // Timeout kecil agar watcher OS tidak tertrigger saat isApplyingRemoteChange sudah false
      setTimeout(() => { isApplyingRemoteChange = false; }, 500);
    }
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
    // Root level — tampilkan header + semua user
    if (!element) {
      if (userActivities.size === 0 && !currentRoomId) {
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

      const items: vscode.TreeItem[] = [];

      // Room info header
      if (currentRoomId) {
        const roomHeader = new vscode.TreeItem(
          `Room: ${currentRoomId}`,
          vscode.TreeItemCollapsibleState.None
        );
        roomHeader.description = `${userActivities.size} user online`;
        roomHeader.iconPath = new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('charts.green'));
        roomHeader.tooltip = `Room ID: ${currentRoomId}\nKlik untuk copy ID`;
        roomHeader.contextValue = 'roomHeader';
        items.push(roomHeader);
      }

      // Urutkan: diri sendiri di atas, lalu alphabetical
      const sorted = Array.from(userActivities.values()).sort((a, b) => {
        if (a.userId === myUserId) return -1;
        if (b.userId === myUserId) return 1;
        return a.username.localeCompare(b.username);
      });

      items.push(...sorted.map(activity => new UserItem(activity)));
      return items;
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

// TreeItem untuk menampilkan user di sidebar (cleaner)
class UserItem extends vscode.TreeItem {
  public activity: UserActivity;

  constructor(activity: UserActivity) {
    const isMe = activity.userId === myUserId;
    const isFollowed = followingUserId === activity.userId;
    const label = `${activity.username}${isMe ? ' (kamu)' : ''}`;

    super(label, vscode.TreeItemCollapsibleState.Expanded);

    this.activity = activity;

    // Context value — determines which menu buttons show
    if (isMe) {
      this.contextValue = 'localUser';
    } else if (isFollowed) {
      this.contextValue = 'followedUser';
    } else {
      this.contextValue = 'remoteUser';
    }

    // Tooltip detail
    const statusText = activity.status === 'typing' ? 'sedang mengetik' : 'online';
    const fileText = activity.activeFile
      ? `📄 ${activity.activeFile} — baris ${activity.activeLine + 1}`
      : 'Belum membuka file';
    const followText = isFollowed ? '\n👁️ Sedang kamu follow' : '';
    this.tooltip = `${activity.username}\nStatus: ${statusText}\n${fileText}${followText}`;

    // Icon berdasarkan status
    if (isMe) {
      this.iconPath = new vscode.ThemeIcon('account', new vscode.ThemeColor('charts.green'));
    } else if (isFollowed) {
      this.iconPath = new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.orange'));
    } else if (activity.status === 'typing') {
      this.iconPath = new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.yellow'));
    } else {
      this.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.blue'));
    }

    // Description — status singkat
    if (isFollowed) {
      this.description = '👁️ following';
    } else if (activity.status === 'typing') {
      this.description = '✏️ mengetik...';
    } else {
      this.description = '● online';
    }
  }
}

// TreeItem untuk menampilkan file aktif user (cleaner)
class FileItem extends vscode.TreeItem {
  public relativePath: string;
  public activity: UserActivity;

  constructor(activity: UserActivity) {
    const fileName = activity.activeFile!.split('/').pop() || activity.activeFile!;
    const lineNum = activity.activeLine + 1;

    super(`${fileName}`, vscode.TreeItemCollapsibleState.None);

    this.relativePath = activity.activeFile!;
    this.activity = activity;

    // Path info di description
    const dirPath = activity.activeFile!.includes('/')
      ? activity.activeFile!.substring(0, activity.activeFile!.lastIndexOf('/'))
      : '';
    this.description = dirPath ? `${dirPath} · Ln ${lineNum}` : `Ln ${lineNum}`;
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
    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });

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

    // Update following decoration
    if (followingUserId === activity.userId) {
      updateFollowingDecoration();
    }
  } catch {
    vscode.window.showErrorMessage(`❌ File "${activity.activeFile}" tidak ditemukan.`);
  }
}

// ─────────────────────────────────────────
// FOLLOWING MODE HELPERS
// ─────────────────────────────────────────

// Berhenti mengikuti user
function stopFollowing() {
  followingUserId = null;
  followingUsername = null;

  // Sembunyikan status bar badge
  if (followingStatusBarItem) {
    followingStatusBarItem.hide();
  }

  // Hapus decoration dari editor
  if (followingDecorationType) {
    followingDecorationType.dispose();
    followingDecorationType = null;
  }

  // Refresh sidebar agar icon kembali normal
  activityProvider?.refresh();
}

// Update yellow badge di status bar
function updateFollowingBadge() {
  if (!followingStatusBarItem || !followingUsername) return;

  followingStatusBarItem.text = `$(eye) Following ${followingUsername}`;
  followingStatusBarItem.tooltip = `Sedang mengikuti ${followingUsername}\nKlik untuk berhenti follow`;
  followingStatusBarItem.show();
}

// Update decoration "Following [username]" di editor (kuning seperti di screenshot)
function updateFollowingDecoration() {
  if (!followingUsername) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  // Hapus decoration lama
  if (followingDecorationType) {
    followingDecorationType.dispose();
  }

  // Buat decoration baru — badge kuning di pojok kanan atas
  followingDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
      contentText: `  Following ${followingUsername}  `,
      color: '#000000',
      backgroundColor: '#FFE500',
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: `;
        font-size: 12px;
        padding: 2px 10px;
        border-radius: 4px;
        margin-left: 20px;
        border: 1px solid #000000;
      `,
    },
  });

  // Tampilkan di baris pertama yang terlihat
  const visibleRange = editor.visibleRanges[0];
  if (visibleRange) {
    const topLine = visibleRange.start.line;
    const range = new vscode.Range(topLine, 0, topLine, 0);
    editor.setDecorations(followingDecorationType, [range]);
  }
}

// ─────────────────────────────────────────
// ROOM CLOSED HANDLER
// ─────────────────────────────────────────

// Dipanggil saat host disconnect → semua guest harus keluar
function handleRoomClosed(data: { reason?: string; hostUsername?: string }) {
  const reason = data.reason || 'Room telah ditutup oleh host.';

  // Tampilkan pesan peringatan yang jelas
  vscode.window.showErrorMessage(
    `🔒 SESSION DITUTUP: ${reason}`,
    'OK'
  );

  // Disconnect socket
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  // Bersihkan semua state
  if (docSyncDisposable) {
    docSyncDisposable.dispose();
    docSyncDisposable = null;
  }
  if (fileCreateWatcherDisposable) {
    fileCreateWatcherDisposable.dispose();
    fileCreateWatcherDisposable = null;
  }
  if (fileSaveWatcherDisposable) {
    fileSaveWatcherDisposable.dispose();
    fileSaveWatcherDisposable = null;
  }
  if (typingTimeout) {
    clearTimeout(typingTimeout);
    typingTimeout = null;
  }

  clearAllRemoteCursors();

  if (cursorSelectionDisposable) {
    cursorSelectionDisposable.dispose();
    cursorSelectionDisposable = null;
  }
  if (cursorEditorChangeDisposable) {
    cursorEditorChangeDisposable.dispose();
    cursorEditorChangeDisposable = null;
  }
  if (activeEditorDisposable) {
    activeEditorDisposable.dispose();
    activeEditorDisposable = null;
  }

  // Bersihkan following
  stopFollowing();
  // Bersihkan pin
  clearPinDecoration();
  lastReceivedPin = null;

  currentRoomId = '';
  roomMembers.clear();
  userActivities.clear();
  activityProvider?.refresh();
  updateStatusBar();

  console.log(`🔒 Room closed: ${reason}`);
}

export function deactivate() {
  if (typingTimeout) clearTimeout(typingTimeout);
  roomMembers.clear();
  userActivities.clear();
  clearAllRemoteCursors();
  stopFollowing();
  clearPinDecoration();
  lastReceivedPin = null;
  if (cursorSelectionDisposable) cursorSelectionDisposable.dispose();
  if (cursorEditorChangeDisposable) cursorEditorChangeDisposable.dispose();
  if (activeEditorDisposable) activeEditorDisposable.dispose();
  if (fileCreateWatcherDisposable) fileCreateWatcherDisposable.dispose();
  if (fileSaveWatcherDisposable) fileSaveWatcherDisposable.dispose();
  if (fileDeleteWatcherDisposable) fileDeleteWatcherDisposable.dispose();
  if (fileRenameWatcherDisposable) fileRenameWatcherDisposable.dispose();
  statusBarItem?.hide();
  followingStatusBarItem?.hide();
  socket?.disconnect();
  docSyncDisposable?.dispose();
}