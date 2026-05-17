import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import ngrok from '@ngrok/ngrok';

const app = express();

// ✅ Fix ngrok header
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',          // ✅ Izinkan semua origin
    methods: ['GET', 'POST'],
    credentials: false
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 50e6, // 50MB untuk sync project
  transports: ['websocket', 'polling'],
});

const rooms = new Map();
const userInfo = new Map();

let ngrokUrl = '';

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;background:#1e1e1e;color:#fff;">
        <h1>🚀 Collab Server</h1>
        <p>✅ Server berjalan</p>
        <p>🌐 URL: ${ngrokUrl || 'localhost'}</p>
        <p>🏠 Rooms aktif: ${rooms.size}</p>
        <p>👥 Users online: ${userInfo.size}</p>
      </body>
    </html>
  `);
});

// ✅ Join via shareable link — redirect browser ke vscode:// URI
app.get('/join/:roomId', (req, res) => {
  const roomId = req.params.roomId.toUpperCase().replace(/-/g, '');
  const serverUrl = ngrokUrl || `http://localhost:${PORT}`;
  const vsCodeUri = `vscode://sitewhiz.live-collaboration/join?server=${encodeURIComponent(serverUrl)}&room=${encodeURIComponent(roomId)}`;

  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="2;url=${vsCodeUri}">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, #0d1117 0%, #161b22 50%, #0d1117 100%);
            color: #e6edf3;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .card {
            background: rgba(22, 27, 34, 0.8);
            border: 1px solid #30363d;
            border-radius: 16px;
            padding: 48px;
            text-align: center;
            max-width: 480px;
            backdrop-filter: blur(20px);
            box-shadow: 0 16px 48px rgba(0,0,0,0.4);
          }
          .icon { font-size: 64px; margin-bottom: 16px; }
          h1 { font-size: 24px; margin-bottom: 8px; color: #58a6ff; }
          p { color: #8b949e; margin-bottom: 24px; line-height: 1.6; }
          .room-id {
            display: inline-block;
            background: #21262d;
            border: 1px solid #30363d;
            border-radius: 8px;
            padding: 8px 20px;
            font-family: 'Cascadia Code', monospace;
            font-size: 20px;
            color: #58a6ff;
            letter-spacing: 3px;
            margin-bottom: 24px;
          }
          .btn {
            display: inline-block;
            background: linear-gradient(135deg, #238636, #2ea043);
            color: #fff;
            text-decoration: none;
            padding: 12px 32px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            transition: all 0.2s;
          }
          .btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(46,160,67,0.4); }
          .spinner {
            display: inline-block;
            width: 20px; height: 20px;
            border: 2px solid #30363d;
            border-top-color: #58a6ff;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
          }
          @keyframes spin { to { transform: rotate(360deg); } }
          .status { font-size: 14px; color: #8b949e; margin-top: 16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🚀</div>
          <h1>Live Collaboration</h1>
          <p>Kamu diundang untuk bergabung ke session kolaborasi</p>
          <div class="room-id">${roomId}</div>
          <br><br>
          <a class="btn" href="${vsCodeUri}">Buka di VS Code</a>
          <div class="status"><span class="spinner"></span>Membuka VS Code secara otomatis...</div>
        </div>
      </body>
    </html>
  `);
});

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('create-room', (data, callback) => {
    if (typeof data === 'function') { callback = data; data = {}; }

    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms.set(roomId, {
      users: [socket.id],
      files: {},
      hostSocketId: socket.id,
      hostUserId: data.userId || socket.id,
      hostUsername: data.username || 'Unknown',
    });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = data.userId || socket.id;
    socket.username = data.username || 'Unknown';

    userInfo.set(socket.id, {
      userId: socket.userId,
      username: socket.username,
      roomId,
      status: 'idle',
      activeFile: null,
      activeLine: 0
    });

    console.log(`🏠 Room dibuat: ${roomId} oleh ${socket.username}`);

    if (typeof callback === 'function') callback(roomId);
    else socket.emit('room-created', roomId);
  });

  // ✅ Host mengirim semua file project sekaligus setelah room dibuat
  socket.on('sync-all-files', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) {
      console.log('⚠️ sync-all-files: room tidak valid');
      return;
    }
    const room = rooms.get(socket.roomId);
    if (!data.files || !Array.isArray(data.files)) {
      console.log('⚠️ sync-all-files: data.files tidak valid');
      return;
    }
    // Simpan semua file ke room.files
    for (const file of data.files) {
      if (file.relativePath && file.content !== undefined) {
        room.files[file.relativePath] = file.content;
      }
    }
    console.log(`📦 ${socket.username} mengirim ${data.files.length} file ke room ${socket.roomId} (total tersimpan: ${Object.keys(room.files).length})`);
  });

  socket.on('join-room', ({ roomId, userId, username }) => {
    if (!rooms.has(roomId)) {
      console.log(`⚠️ join-room: Room ${roomId} tidak ditemukan`);
      socket.emit('error', `Room "${roomId}" tidak ditemukan. Pastikan Room ID benar dan host masih aktif.`);
      return;
    }

    const room = rooms.get(roomId);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;
    socket.username = username;

    userInfo.set(socket.id, { userId, username, roomId, status: 'idle', activeFile: null, activeLine: 0 });
    room.users.push(socket.id);

    // ✅ Cek apakah ini HOST yang reconnect (userId sama dengan hostUserId)
    if (room.hostUserId === userId) {
      console.log(`✅ Host ${username} reconnected via join-room`);
      // Update hostSocketId ke socket baru
      room.hostSocketId = socket.id;
      // Cancel timer penutupan room kalau ada
      if (room.hostDisconnectTimer) {
        clearTimeout(room.hostDisconnectTimer);
        room.hostDisconnectTimer = null;
        console.log(`✅ Timer penutupan room ${roomId} dibatalkan — host kembali`);
      }
      // Beritahu semua guest bahwa host kembali
      socket.to(roomId).emit('host-reconnected', { userId, username });
    }

    // Kirim daftar member yang sudah ada di room ke user baru
    const members = [];
    for (const [sid, info] of userInfo.entries()) {
      if (info.roomId === roomId) {
        members.push({
          userId: info.userId,
          username: info.username,
          status: info.status || 'idle',
          activeFile: info.activeFile || null,
          activeLine: info.activeLine || 0,
        });
      }
    }
    socket.emit('room-members', members);

    // Kirim pin terakhir ke joiner baru (jika ada)
    if (room.lastPin) {
      socket.emit('pin-location', room.lastPin);
    }

    // Kirim semua file yang tersimpan ke joiner dalam satu batch
    const fileKeys = Object.keys(room.files);
    console.log(`📂 Mengirim ${fileKeys.length} file tersimpan ke ${username}...`);
    if (fileKeys.length > 0) {
      const projectFiles = fileKeys.map(relativePath => ({
        relativePath,
        content: room.files[relativePath]
      }));
      socket.emit('init-project', { files: projectFiles });
    }
    console.log(`✅ ${fileKeys.length} file terkirim ke ${username}`);
    if (fileKeys.length === 0) {
      console.log(`⚠️ Room ${roomId} belum punya file tersimpan — host belum sync`);
    }

    // Beritahu host dan member lain bahwa user baru bergabung
    socket.to(roomId).emit('user-joined', { userId, username });

    console.log(`👤 ${username} (${userId}) join room: ${roomId}`);
  });

  socket.on('sync-document', (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      if (data.relativePath) {
        // Simpan per-file
        room.files[data.relativePath] = data.content;
        console.log(`📄 sync-document: ${data.relativePath} disimpan (dari ${socket.username})`);
        // Relay ke collaborator sebagai init-file
        socket.to(socket.roomId).emit('init-file', {
          relativePath: data.relativePath,
          content: data.content,
        });
      } else {
        // Legacy: simpan sebagai single content
        socket.to(socket.roomId).emit('init-document', data.content);
      }
    }
  });

  socket.on('create-folder', (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      console.log(`📁 create-folder: ${data.relativePath} (dari ${socket.username})`);
      socket.to(socket.roomId).emit('create-folder', data);
    }
  });

  socket.on('delete-file', (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      if (room.files[data.relativePath]) {
        delete room.files[data.relativePath]; // Hapus dari cache server
      }
      console.log(`🗑️ delete-file: ${data.relativePath} (dari ${socket.username})`);
      socket.to(socket.roomId).emit('delete-file', data);
    }
  });

  socket.on('rename-file', (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      if (room.files[data.oldPath]) {
        room.files[data.newPath] = room.files[data.oldPath];
        delete room.files[data.oldPath];
      }
      console.log(`✏️ rename-file: ${data.oldPath} -> ${data.newPath} (dari ${socket.username})`);
      socket.to(socket.roomId).emit('rename-file', data);
    }
  });

  socket.on('text-change', (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      // Simpan content per-file agar user yang join nanti dapat versi terbaru
      if (data.relativePath && data.fullContent) {
        rooms.get(socket.roomId).files[data.relativePath] = data.fullContent;
      }
      // Relay perubahan ke semua user lain di room
      socket.to(socket.roomId).emit('text-change', data);
    } else {
      console.log(`⚠️ text-change: socket ${socket.id} tidak ada di room`);
    }
  });

  socket.on('cursor-update', (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('cursor-update', {
        ...data,
        userId: socket.userId,
        username: socket.username,
      });
    }
  });

  // Relay presence update (typing/idle) ke room
  socket.on('presence-update', (data) => {
    // Update status di userInfo
    const info = userInfo.get(socket.id);
    if (info) {
      info.status = data.status;
    }
    // Relay ke semua user lain di room
    if (socket.roomId) {
      socket.to(socket.roomId).emit('presence-update', {
        userId: socket.userId,
        username: socket.username,
        status: data.status,
      });
    }
  });

  // Track file aktif yang sedang dibuka user
  socket.on('active-file', (data) => {
    const info = userInfo.get(socket.id);
    if (info) {
      info.activeFile = data.relativePath || null;
      info.activeLine = data.line || 0;
    }
    // Relay ke semua user lain di room
    if (socket.roomId) {
      socket.to(socket.roomId).emit('active-file', {
        userId: socket.userId,
        username: socket.username,
        relativePath: data.relativePath,
        line: data.line || 0,
        character: data.character || 0,
      });
    }
  });

  // ✅ Pin Location — broadcast pin ke semua user di room
  socket.on('pin-location', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);

    const pinData = {
      userId: socket.userId,
      username: socket.username,
      relativePath: data.relativePath,
      line: data.line,
      character: data.character,
      message: data.message || '',
      timestamp: Date.now(),
    };

    // Simpan pin terakhir di room
    room.lastPin = pinData;

    // Broadcast ke semua user di room (termasuk pengirim)
    io.to(socket.roomId).emit('pin-location', pinData);

    console.log(`📌 ${socket.username} pin location: ${data.relativePath}:${data.line + 1} di room ${socket.roomId}`);
  });

  // Relay single file overwrite ke room
  socket.on('sync-file', (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('receive-file', {
        ...data,
        userId: socket.userId,
        username: socket.username,
      });
      console.log(`📄 ${socket.username} mengirim file: ${data.relativePath}`);
    }
  });

  // Relay project overwrite ke room
  socket.on('sync-project', (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('receive-project', {
        ...data,
        userId: socket.userId,
        username: socket.username,
      });
      console.log(`📁 ${socket.username} mengirim project (${data.files?.length || 0} files)`);
    }
  });

  // ─── SHARED TERMINAL ───────────────────────────────

  // Host memulai share terminal
  socket.on('terminal-start', (data, callback) => {
    console.log(`🖥️ [SERVER] Received terminal-start from ${socket.username}`);
    if (!socket.roomId || !rooms.has(socket.roomId)) {
      console.log('⚠️ terminal-start: room tidak valid');
      if (typeof callback === 'function') callback({ ok: false, error: 'room tidak valid' });
      return;
    }
    const room = rooms.get(socket.roomId);

    // Hanya host yang boleh share terminal
    if (room.hostSocketId !== socket.id) {
      socket.emit('error', 'Hanya host yang bisa share terminal.');
      if (typeof callback === 'function') callback({ ok: false, error: 'bukan host' });
      return;
    }

    room.terminalSharing = true;
    room.terminalAllowInput = data?.allowInput || false;

    const guestCount = room.users.filter(id => id !== socket.id).length;
    console.log(`🖥️ [SERVER] Broadcasting terminal-started to ${guestCount} guests in room ${socket.roomId}`);

    socket.to(socket.roomId).emit('terminal-started', {
      hostUsername: socket.username,
      allowInput: room.terminalAllowInput,
    });

    console.log(`🖥️ ${socket.username} memulai share terminal di room ${socket.roomId}`);
    if (typeof callback === 'function') callback({ ok: true, guestCount });
  });

  // Host mengirim output terminal
  socket.on('terminal-data', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    if (room.hostSocketId !== socket.id) return;

    socket.to(socket.roomId).emit('terminal-data', {
      data: data.data,
    });
  });

  // Guest mengirim command request ke host (staging — host harus approve)
  socket.on('terminal-command-request', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    if (!room.terminalAllowInput) return;

    // Kirim command request ke host
    const hostSocket = io.sockets.sockets.get(room.hostSocketId);
    if (hostSocket) {
      hostSocket.emit('terminal-command-request', {
        command: data.command,
        userId: socket.userId,
        username: socket.username,
      });
      console.log(`🖥️ ${socket.username} request command: "${data.command}" → waiting host approval`);
    }
  });

  // Host menolak command dari guest
  socket.on('terminal-command-rejected', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    if (room.hostSocketId !== socket.id) return;

    socket.to(socket.roomId).emit('terminal-command-rejected', {
      command: data.command,
      username: data.username,
      reason: data.reason || 'rejected',
    });
    console.log(`🖥️ Host menolak command dari ${data.username}: "${data.command}" (${data.reason || 'rejected'})`);
  });

  // Host menyetujui command dari guest
  socket.on('terminal-command-approved', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    if (room.hostSocketId !== socket.id) return;

    socket.to(socket.roomId).emit('terminal-command-approved', {
      command: data.command,
      username: data.username,
    });
    console.log(`🖥️ Host menyetujui command dari ${data.username}: "${data.command}"`);
  });

  // Guest membatalkan command request
  socket.on('terminal-command-cancel', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);

    // Kirim cancel ke host
    const hostSocket = io.sockets.sockets.get(room.hostSocketId);
    if (hostSocket) {
      hostSocket.emit('terminal-command-cancel', {
        userId: socket.userId,
        username: socket.username,
      });
      console.log(`🖥️ ${socket.username} membatalkan command request`);
    }
  });

  // Host mengirim resize terminal
  socket.on('terminal-resize', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    if (room.hostSocketId !== socket.id) return;

    socket.to(socket.roomId).emit('terminal-resize', {
      cols: data.cols,
      rows: data.rows,
    });
  });

  // Host menghentikan share terminal
  socket.on('terminal-stop', () => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    if (room.hostSocketId !== socket.id) return;

    room.terminalSharing = false;
    room.terminalAllowInput = false;

    socket.to(socket.roomId).emit('terminal-stopped', {
      hostUsername: socket.username,
    });

    console.log(`🖥️ ${socket.username} menghentikan share terminal di room ${socket.roomId}`);
  });

  // ─── END SHARED TERMINAL ──────────────────────────

  socket.on('reconnect-room', ({ roomId, userId, username }) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Room tidak ditemukan');
      return;
    }

    const room = rooms.get(roomId);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;
    socket.username = username;

    userInfo.set(socket.id, { userId, username, roomId, status: 'idle', activeFile: null, activeLine: 0 });

    // Cek apakah ini host yang reconnect
    if (room.hostUserId === userId) {
      // Host reconnect — cancel timer penutupan room
      if (room.hostDisconnectTimer) {
        clearTimeout(room.hostDisconnectTimer);
        room.hostDisconnectTimer = null;
        console.log(`✅ Host ${username} reconnected — timer penutupan room dibatalkan`);
      }
      // Update hostSocketId ke socket baru
      room.hostSocketId = socket.id;
      room.users.push(socket.id);

      // Beritahu semua guest bahwa host kembali
      socket.to(roomId).emit('host-reconnected', { userId, username });
    } else {
      // Guest reconnect
      room.users.push(socket.id);
    }

    socket.emit('reconnected', {
      files: room.files,
    });

    socket.to(roomId).emit('user-reconnected', { userId, username });
    console.log(`🔄 ${username} reconnected ke room: ${roomId}`);
  });

  socket.on('disconnect', (reason) => {
    const info = userInfo.get(socket.id);
    console.log(`❌ ${info?.username || socket.id} disconnected: ${reason}`);

    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);

      // Hapus socket dari daftar user room
      room.users = room.users.filter((id) => id !== socket.id);

      // Cek apakah yang disconnect adalah HOST
      if (room.hostSocketId === socket.id) {
        // HOST disconnect → beri grace period 30 detik untuk reconnect
        console.log(`⏳ Host ${info?.username} disconnect — menunggu 30 detik sebelum menutup room ${socket.roomId}`);

        // Beritahu semua guest bahwa host sementara disconnect
        socket.to(socket.roomId).emit('host-disconnected', {
          username: info?.username || 'Unknown',
          message: `Host (${info?.username}) terputus. Menunggu reconnect... (30 detik)`,
        });

        const roomIdToClose = socket.roomId;

        // Set timer: kalau host tidak reconnect dalam 30 detik, tutup room
        room.hostDisconnectTimer = setTimeout(() => {
          if (rooms.has(roomIdToClose)) {
            const r = rooms.get(roomIdToClose);
            console.log(`🔒 Host ${info?.username} tidak reconnect — menutup room ${roomIdToClose}`);

            // Emit room-closed ke semua user yang masih di room
            io.to(roomIdToClose).emit('room-closed', {
              reason: `Host (${info?.username || 'Unknown'}) telah meninggalkan room dan tidak kembali. Session ditutup.`,
              hostUsername: info?.username || 'Unknown',
            });

            rooms.delete(roomIdToClose);
            console.log(`🗑️ Room ${roomIdToClose} dihapus (host timeout)`);
          }
        }, 30000);
      } else {
        // GUEST disconnect → kirim user-left
        socket.to(socket.roomId).emit('user-left', {
          userId: info?.userId || socket.id,
          username: info?.username || 'User'
        });
        console.log(`👋 Guest ${info?.username} keluar dari room ${socket.roomId}`);
      }
    }

    userInfo.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  });

  // Buat tunnel ngrok
  const authtoken = process.env.NGROK_AUTHTOKEN || '2Akj2JNpEJibFWnesMguIQaox8A_3iAHEvdmTqAua61wFTSHa';
  if (!authtoken) {
    console.log('⚠️  NGROK_AUTHTOKEN tidak ditemukan!');
    console.log('💡 Jalankan dengan: NGROK_AUTHTOKEN=token_kamu node server.js');
    console.log('📌 Server tetap berjalan di localhost saja.');
    return;
  }

  try {
    const listener = await ngrok.forward({
      addr: PORT,
      authtoken: authtoken,
    });

    ngrokUrl = listener.url();
    console.log(`🌐 Ngrok tunnel aktif: ${ngrokUrl}`);
    console.log(`📋 Gunakan URL ini di VS Code extension!`);
  } catch (err) {
    console.error('❌ Gagal membuat ngrok tunnel:', err.message);
    console.log('📌 Server tetap berjalan di localhost saja.');
  }
}

startServer();