import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const rooms = new Map();
const userInfo = new Map();

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

  // ✅ Fix: terima data object DAN callback terpisah
  socket.on('create-room', (data, callback) => {

    // Handle jika data adalah function (cara lama tanpa userId)
    if (typeof data === 'function') {
      callback = data;
      data = {};
    }

    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms.set(roomId, { users: [socket.id], content: '' });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = data.userId || socket.id;
    socket.username = data.username || 'Unknown';

    // Simpan info user
    userInfo.set(socket.id, {
      userId: socket.userId,
      username: socket.username,
      roomId
    });

    console.log(`🏠 Room dibuat: ${roomId} oleh ${socket.username} (${socket.userId}`);

    // Pastikan callback adalah function sebelum dipanggil
    if (typeof callback === 'function') {
      callback(roomId);
    } else {
      // Kirim balik roomId lewat event kalau tidak ada callback
      socket.emit('room-created', roomId);
    }
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

    console.log(`👤 ${username} (${userId}) join room: ${roomId}`);
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

  socket.on('disconnect', () => {
    const info = userInfo.get(socket.id);
    console.log(`❌ ${info?.username || socket.id} disconnected`);

    if (socket.roomId) {
      socket.to(socket.roomId).emit('user-left', {
        userId: info?.userId || socket.id,
        username: info?.username || 'User'
      });
    }
    userInfo.delete(socket.id);
  });
});

httpServer.listen(3000, () => {
  console.log('🚀 Server berjalan di http://localhost:3000');
});