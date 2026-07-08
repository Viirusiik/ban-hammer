const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const AI_API_URL = "https://text.pollinations.ai/";

async function moderateRoom(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameOver) return;

    const players = Object.keys(room.users).filter(id => !room.users[id].banned);
    if (players.length <= 1) {
        if (!room.gameOver && players.length === 1) {
            room.gameOver = true;
            io.to(roomId).emit('gameOver', room.users[players[0]].name);
        }
        return;
    }

    const history = room.messages.slice(-10).map(m => `${room.users[m.id]?.name || 'Unknown'}: ${m.text}`).join('\n');
    
    const prompt = `Ты — сумасшедший ИИ-модератор чата. Твоя цель — забанить одного из участников за максимально абсурдную, смешную и нелепую причину. 
    Вот история чата:\n${history}\n
    Выбери одного юзера и придумай смешную причину бана. Ответь СТРОГО в формате JSON без markdown: {"username": "имя_юзера", "reason": "причина"}`;

    try {
        const response = await fetch(`${AI_API_URL}${encodeURIComponent(prompt)}`);
        let data = await response.text();
        data = data.replace(/```json/g, '').replace(/```/g, '').trim();
        const banData = JSON.parse(data);
        
        const targetId = Object.keys(room.users).find(id => room.users[id].name === banData.username);
        
        if (targetId && !room.users[targetId].banned) {
            room.users[targetId].banned = true;
            io.to(roomId).emit('ban', { id: targetId, name: banData.username, reason: banData.reason });
            
            const alive = Object.keys(room.users).filter(id => !room.users[id].banned);
            if (alive.length === 1) {
                room.gameOver = true;
                io.to(roomId).emit('gameOver', room.users[alive[0]].name);
            }
        }
    } catch (e) {
        const randomId = players[Math.floor(Math.random() * players.length)];
        room.users[randomId].banned = true;
        io.to(roomId).emit('ban', { id: randomId, name: room.users[randomId].name, reason: "Сбой матрицы. ИИ запутался в проводах." });
    }

    if (!room.gameOver) {
        setTimeout(() => moderateRoom(roomId), Math.random() * 10000 + 15000);
    }
}

io.on('connection', (socket) => {
    socket.on('createRoom', (nickname) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            users: {},
            messages: [],
            gameOver: false,
            topic: "Обсуждаем, почему кошки лучше собак"
        };
        socket.join(roomId);
        rooms[roomId].users[socket.id] = { name: nickname, banned: false };
        socket.emit('roomJoined', { roomId, topic: rooms[roomId].topic, userId: socket.id });
        io.to(roomId).emit('updateUsers', Object.values(rooms[roomId].users));
        
        setTimeout(() => moderateRoom(roomId), 20000);
    });

    socket.on('joinRoom', ({ roomId, nickname }) => {
        if (!rooms[roomId]) return socket.emit('error', 'Комната не найдена!');
        if (rooms[roomId].gameOver) return socket.emit('error', 'Игра уже закончена!');

        socket.join(roomId);
        rooms[roomId].users[socket.id] = { name: nickname, banned: false };
        socket.emit('roomJoined', { roomId, topic: rooms[roomId].topic, userId: socket.id });
        io.to(roomId).emit('updateUsers', Object.values(rooms[roomId].users));
    });

    socket.on('sendMessage', (text) => {
        const roomId = Object.keys(rooms).find(id => rooms[id].users[socket.id]);
        if (!roomId || rooms[roomId].users[socket.id].banned || rooms[roomId].gameOver) return;
        
        rooms[roomId].messages.push({ id: socket.id, text });
        io.to(roomId).emit('newMessage', { id: socket.id, name: rooms[roomId].users[socket.id].name, text });
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            if (rooms[roomId].users[socket.id]) {
                delete rooms[roomId].users[socket.id];
                io.to(roomId).emit('updateUsers', Object.values(rooms[roomId].users));
                if (Object.keys(rooms[roomId].users).length === 0) delete rooms[roomId];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
