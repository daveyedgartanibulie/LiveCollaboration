import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

const app = express();
const httpServer = createServer(app);

// ✅ Tambah reconnect settings
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  transports: ['websocket', 'polling'], // fallback ke polling kalau websocket gagal
});

const rooms = new Map();
const userInfo = new Map();
const terminals = new Map();
const debugSessions = new Map();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;background:#1e1e1e;color:#fff;">
        <h1>🚀 Collab Server</h1>
        <p>✅ Server berjalan di port 3000</p>
        <p>🏠 Rooms aktif: ${rooms.size}</p>
        <p>👥 Users online: ${userInfo.size}</p>
      </body>
    </html>
  `);
});

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  // ✅ Handle reconnect — restore state user
  socket.on('reconnect-room', ({ roomId, userId, username }) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Room tidak ditemukan atau sudah expired');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;
    socket.username = username;

    userInfo.set(socket.id, { userId, username, roomId });

    // Kirim state terakhir ke user yang reconnect
    socket.emit('reconnected', {
      content: rooms.get(roomId).content,
      debugSession: debugSessions.get(roomId) || null,
    });

    socket.to(roomId).emit('user-reconnected', { userId, username });
    console.log(`🔄 ${username} reconnected ke room: ${roomId}`);
  });

  socket.on('create-room', (data, callback) => {
    if (typeof data === 'function') { callback = data; data = {}; }

    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms.set(roomId, { users: [socket.id], content: '' });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = data.userId || socket.id;
    socket.username = data.username || 'Unknown';

    userInfo.set(socket.id, {
      userId: socket.userId,
      username: socket.username,
      roomId
    });

    if (typeof callback === 'function') callback(roomId);
    else socket.emit('room-created', roomId);
  });

  socket.on('join-room', ({ roomId, userId, username }) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Room tidak ditemukan');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;
    socket.username = username;

    userInfo.set(socket.id, { userId, username, roomId });
    rooms.get(roomId).users.push(socket.id);

    socket.emit('init-document', rooms.get(roomId).content);
    socket.to(roomId).emit('user-joined', { userId, username });

    if (debugSessions.has(roomId)) {
      socket.emit('debug-session-started', debugSessions.get(roomId));
    }

    if (terminals.has(roomId)) {
      socket.emit('terminal-available');
    }
  });
  
  // ✅ Host kirim full document ke guest baru
  socket.on('sync-document', (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      // Update konten room
      rooms.get(socket.roomId).content = data.content;
      // Kirim ke semua guest
      socket.to(socket.roomId).emit('init-document', data.content);
    }
  });

  // ✅ Handle reconnect
  socket.on('reconnect-room', ({ roomId, userId, username }) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Room tidak ditemukan');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;
    socket.username = username;

    userInfo.set(socket.id, { userId, username, roomId });

    // Kirim state terakhir
    socket.emit('reconnected', {
      content: rooms.get(roomId).content,
    });

    socket.to(roomId).emit('user-reconnected', { userId, username });
    console.log(🔄 ${username} reconnected ke room: ${roomId});
  });

  socket.on('text-change', (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      rooms.get(socket.roomId).content = data.fullContent || '';
    }
    socket.to(socket.roomId).emit('text-change', data);
  });

  socket.on('cursor-update', (data) => {
    socket.to(socket.roomId).emit('cursor-update', {
      ...data,
      userId: socket.userId,
      username: socket.username,
    });
  });

  socket.on('debug-started', (data) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    debugSessions.set(roomId, {
      sessionId: data.sessionId,
      language: data.language,
      fileName: data.fileName,
      breakpoints: data.breakpoints || [],
      startedBy: socket.username,
      isPaused: false,
    });

    socket.to(roomId).emit('debug-session-started', debugSessions.get(roomId));
  });

  socket.on('debug-stopped', () => {
    debugSessions.delete(socket.roomId);
    socket.to(socket.roomId).emit('debug-session-stopped');
  });

  socket.on('debug-paused', (data) => {
    const session = debugSessions.get(socket.roomId);
    if (session) {
      session.isPaused = true;
      session.currentLine = data.currentLine;
      session.variables = data.variables;
      session.callStack = data.callStack;
    }
    socket.to(socket.roomId).emit('debug-paused', data);
  });

  socket.on('debug-resumed', () => {
    const session = debugSessions.get(socket.roomId);
    if (session) session.isPaused = false;
    socket.to(socket.roomId).emit('debug-resumed');
  });

  socket.on('debug-breakpoints-updated', (data) => {
    const session = debugSessions.get(socket.roomId);
    if (session) session.breakpoints = data.breakpoints;
    socket.to(socket.roomId).emit('debug-breakpoints-updated', data);
  });

  socket.on('debug-step-request', (data) => {
    socket.to(socket.roomId).emit('debug-step-request', {
      type: data.type,
      requestedBy: socket.username,
    });
  });

  socket.on('start-terminal', () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    try {
      const pty = require('node-pty');
      const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: process.env.HOME,
        env: process.env
      });

      terminals.set(roomId, ptyProcess);
      ptyProcess.onData((data) => io.to(roomId).emit('terminal-output', data));
      ptyProcess.onExit(() => {
        terminals.delete(roomId);
        io.to(roomId).emit('terminal-closed');
      });

      io.to(roomId).emit('terminal-available');
    } catch (err) {
      console.error('Terminal error:', err);
      socket.emit('error', 'Gagal membuat terminal');
    }
  });

  socket.on('terminal-input', (data) => {
    const ptyProcess = terminals.get(socket.roomId);
    if (ptyProcess) ptyProcess.write(data);
  });

  socket.on('terminal-resize', ({ cols, rows }) => {
    const ptyProcess = terminals.get(socket.roomId);
    if (ptyProcess) ptyProcess.resize(cols, rows);
  });

  socket.on('stop-terminal', () => {
    const ptyProcess = terminals.get(socket.roomId);
    if (ptyProcess) {
      ptyProcess.kill();
      terminals.delete(socket.roomId);
      io.to(socket.roomId).emit('terminal-closed');
    }
  });

  socket.on('disconnect', (reason) => {
    const info = userInfo.get(socket.id);
    console.log(`❌ ${info?.username || socket.id} disconnected: ${reason}`);

    if (socket.roomId) {
      socket.to(socket.roomId).emit('user-left', {
        userId: info?.userId || socket.id,
        username: info?.username || 'User'
      });
    }

    // ✅ Jangan hapus room saat disconnect
    // Beri waktu 30 detik untuk reconnect
    setTimeout(() => {
      if (!io.sockets.adapter.rooms.has(socket.roomId)) {
        rooms.delete(socket.roomId);
        debugSessions.delete(socket.roomId);
        console.log(`🗑️ Room ${socket.roomId} dihapus karena kosong`);
      }
    }, 30000);

    userInfo.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});