import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const rooms = new Map();
const userInfo = new Map(); // ✅ Simpan username tiap user

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

  socket.on('create-room', (callback) => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms.set(roomId, { users: [socket.id], content: '' });
    socket.join(roomId);
    socket.roomId = roomId;
    callback(roomId);
    console.log(`🏠 Room dibuat: ${roomId}`);
  });

  // ✅ Terima username saat join
  socket.on('join-room', ({ roomId, username }) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Room tidak ditemukan');
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;

    // Simpan info user
    userInfo.set(socket.id, { username, roomId });
    rooms.get(roomId).users.push(socket.id);

    socket.emit('init-document', rooms.get(roomId).content);

    // Beritahu user lain dengan username
    socket.to(roomId).emit('user-joined', { userId: socket.id, username });

    console.log(`👤 ${username} join room: ${roomId}`);
  });

  socket.on('text-change', (data) => {
    // Simpan konten terbaru
    if (socket.roomId && rooms.has(socket.roomId)) {
      rooms.get(socket.roomId).content = data.fullContent || '';
    }
    socket.to(socket.roomId).emit('text-change', data);
  });

  socket.on('cursor-update', (data) => {
    socket.to(socket.roomId).emit('cursor-update', {
      ...data,
      userId: socket.id,
      username: socket.username || 'Unknown',
    });
  });

  socket.on('disconnect', () => {
    const info = userInfo.get(socket.id);
    console.log(`❌ ${info?.username || socket.id} disconnected`);

    if (socket.roomId) {
      socket.to(socket.roomId).emit('user-left', {
        userId: socket.id,
        username: info?.username || 'User'
      });
    }
    userInfo.delete(socket.id);
  });
});

httpServer.listen(3000, () => {
  console.log('🚀 Server berjalan di http://localhost:3000');
});