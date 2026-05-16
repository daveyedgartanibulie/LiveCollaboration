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

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('create-room', (data, callback) => {
    if (typeof data === 'function') { callback = data; data = {}; }

    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms.set(roomId, { users: [socket.id], files: {} });
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

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;
    socket.username = username;

    userInfo.set(socket.id, { userId, username, roomId });
    rooms.get(roomId).users.push(socket.id);

    // Kirim semua file yang tersimpan ke guest
    const room = rooms.get(roomId);
    const fileKeys = Object.keys(room.files);
    console.log(`📂 Mengirim ${fileKeys.length} file tersimpan ke ${username}...`);
    if (fileKeys.length > 0) {
      for (const relativePath of fileKeys) {
        socket.emit('init-file', {
          relativePath,
          content: room.files[relativePath],
        });
      }
      console.log(`✅ ${fileKeys.length} file terkirim ke ${username}`);
    } else {
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
      files: rooms.get(roomId).files,
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

async function startServer() {
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  });

  // Buat tunnel ngrok
  const authtoken = process.env.NGROK_AUTHTOKEN || '3Dhk3Y4n7PojDAbleZ4bSeFEl3R_29fMGSayNtScjM3W3qnJm';
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