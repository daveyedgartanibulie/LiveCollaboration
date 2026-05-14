import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

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
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

const rooms = new Map();
const userInfo = new Map();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;background:#1e1e1e;color:#fff;">
        <h1>🚀 Collab Server</h1>
        <p>✅ Server berjalan</p>
        <p>🏠 Rooms aktif: ${rooms.size}</p>
        <p>👥 Users online: ${userInfo.size}</p>
      </body>
    </html>
  `);
});

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

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

    console.log(`🏠 Room dibuat: ${roomId} oleh ${socket.username}`);

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

    // Kirim konten dokumen ke guest
    socket.emit('init-document', rooms.get(roomId).content);
    socket.to(roomId).emit('user-joined', { userId, username });

    console.log(`👤 ${username} (${userId}) join room: ${roomId}`);
  });

  socket.on('sync-document', (data) => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      rooms.get(socket.roomId).content = data.content;
      socket.to(socket.roomId).emit('init-document', data.content);
    }
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

    socket.emit('reconnected', {
      content: rooms.get(roomId).content,
    });

    socket.to(roomId).emit('user-reconnected', { userId, username });
    console.log(`🔄 ${username} reconnected ke room: ${roomId}`);
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

    // Hapus room setelah 30 detik kalau kosong
    setTimeout(() => {
      if (socket.roomId && rooms.has(socket.roomId)) {
        const room = rooms.get(socket.roomId);
        room.users = room.users.filter((id) => id !== socket.id);
        if (room.users.length === 0) {
          rooms.delete(socket.roomId);
          console.log(`🗑️ Room ${socket.roomId} dihapus`);
        }
      }
    }, 30000);

    userInfo.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});