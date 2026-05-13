import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

const app = express();
  app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 40px; background: #1e1e1e; color: #fff;">
        <h1>🚀 Collab Server</h1>
        <p>✅ Server berjalan di port 3000</p>
        <p>📡 WebSocket siap menerima koneksi</p>
        <p>🏠 Rooms aktif: <strong id="rooms">...</strong></p>
      </body>
    </html>
  `);
});
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const rooms = new Map();

// Simpan cursor tiap user
const userCursors = new Map();

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('create-room', (callback) => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms.set(roomId, { users: [socket.id], content: '' });
    socket.join(roomId);
    socket.roomId = roomId;
    callback(roomId);
    console.log(`🏠 Room dibuat: ${roomId}`);
  });

  socket.on('join-room', (roomId) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Room tidak ditemukan');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    rooms.get(roomId).users.push(socket.id);

    // Kirim semua cursor yang ada ke user baru
    const existingCursors = [];
    userCursors.forEach((cursor, userId) => {
      if (userId !== socket.id) {
        existingCursors.push({ userId, ...cursor });
      }
    });
    socket.emit('existing-cursors', existingCursors);
    socket.emit('init-document', rooms.get(roomId).content);
    socket.to(roomId).emit('user-joined', { userId: socket.id });

    console.log(`👤 User ${socket.id} join room: ${roomId}`);
  });

  // ✅ Handler cursor update
  socket.on('cursor-update', (data) => {
    // Simpan cursor terbaru user ini
    userCursors.set(socket.id, {
      line: data.line,
      character: data.character,
      username: data.username,
      fileName: data.fileName,
    });

    // Broadcast ke user lain di room yang sama
    socket.to(socket.roomId).emit('cursor-update', {
      userId: socket.id,
      ...data,
    });
  });

  socket.on('text-change', (data) => {
    socket.to(socket.roomId).emit('text-change', data);
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
    userCursors.delete(socket.id); // Hapus cursor dari map

    if (socket.roomId) {
      socket.to(socket.roomId).emit('user-left', { userId: socket.id });
    }
  });
});

httpServer.listen(3000, () => {
  console.log('🚀 Server berjalan di http://localhost:3000');
});