import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', (callback) => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms.set(roomId, { users: [socket.id], content: '' });
    socket.join(roomId);
    socket.roomId = roomId;
    callback(roomId);
  });

  socket.on('join-room', (roomId) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Room tidak ditemukan');
      return;
    }
    socket.join(roomId);
    socket.roomId = roomId;
    rooms.get(roomId).users.push(socket.id);

    socket.emit('init-document', rooms.get(roomId).content);
    socket.to(roomId).emit('user-joined', { userId: socket.id });
  });

  socket.on('text-change', (data) => {
    socket.to(socket.roomId).emit('text-change', data);
  });

  socket.on('cursor-update', (data) => {
    socket.to(socket.roomId).emit('cursor-update', {
      ...data,
      userId: socket.id
    });
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('user-left', { userId: socket.id });
    }
  });
});

httpServer.listen(3000, () => console.log('Server berjalan di port 3000'));