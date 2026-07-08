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

    let banReason = "ИИ забыл причину, но банит просто так.";
    let targetId = null;

    try {
        const response = await fetch(`${AI_API_URL}${encodeURIComponent(prompt)}`);
        let data = await response.text();
        
        // Жестко вырезаем JSON из ответа
        const match = data.match(/\{.*\}/s);
        if (match) {
            data = match[0];
            const banData = JSON.parse(data);
            
            banReason = banData.reason || banReason;
            targetId = Object.keys(room.users).find(id => room.users[id].name === banData.username);
            
            // Если ИИ придумал несуществующего юзера, баним случайного, но причину оставляем
            if (!targetId) {
                targetId = players[Math.floor(Math.random() * players.length)];
            }
        } else {
            throw new Error("Неверный формат ИИ");
        }
    } catch (e) {
        // Если ИИ полностью сломался, баним случайного со своей причиной
        targetId = players[Math.floor(Math.random() * players.length)];
        const fallbackReasons = [
            "Сбой матрицы. ИИ запутался в проводах.",
            "Похоже на бота. Бан без суда.",
            "Слишком скучно пишешь. Бан.",
            "ИИ просто не понравилось твое лицо (ник)."
        ];
        banReason = fallbackReasons[Math.floor(Math.random() * fallbackReasons.length)];
    }

    if (targetId && !room.users[targetId].banned) {
        room.users[targetId].banned = true;
        const bannedName = room.users[targetId].name;
        io.to(roomId).emit('ban', { id: targetId, name: bannedName, reason: banReason });
        
        const alive = Object.keys(room.users).filter(id => !room.users[id].banned);
        if (alive.length === 1) {
            room.gameOver = true;
            io.to(roomId).emit('gameOver', room.users[alive[0]].name);
        }
    }

    if (!room.gameOver) {
        setTimeout(() => moderateRoom(roomId), Math.random() * 10000 + 20000);
    }
}

io.on('connection', (socket) => {
    console.log('Новый игрок подключился:', socket.id);

    socket.on('createRoom', (nickname) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            users: {},
            messages: [],
            gameOver: false,
            topic: "Обсуждаем, почему кошки лучше собак",
            startTime: Date.now() + 60000
        };
        socket.join(roomId);
        rooms[roomId].users[socket.id] = { name: nickname, banned: false };
        socket.data.roomId = roomId;
        
        socket.emit('roomJoined', { roomId, topic: rooms[roomId].topic, userId: socket.id, startTime: rooms[roomId].startTime });
        io.to(roomId).emit('updateUsers', Object.values(rooms[roomId].users));
        io.to(roomId).emit('newMessage', { id: 'system', name: 'Система', text: `Комната создана. Код: ${roomId}. Ждем игроков!` });
        
        setTimeout(() => moderateRoom(roomId), 60000);
    });

    socket.on('joinRoom', ({ roomId, nickname }) => {
        roomId = (roomId || '').trim();
        if (!rooms[roomId]) return socket.emit('appError', 'Комната не найдена! Проверьте код.');
        if (rooms[roomId].gameOver) return socket.emit('appError', 'Игра в этой комнате уже закончилась!');

        socket.join(roomId);
        rooms[roomId].users[socket.id] = { name: nickname, banned: false };
        socket.data.roomId = roomId;
        
        socket.emit('roomJoined', { roomId, topic: rooms[roomId].topic, userId: socket.id, startTime: rooms[roomId].startTime });
        io.to(roomId).emit('updateUsers', Object.values(rooms[roomId].users));
        io.to(roomId).emit('newMessage', { id: 'system', name: 'Система', text: `${nickname} зашел в комнату.` });
    });

    socket.on('sendMessage', (text) => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms[roomId] || !rooms[roomId].users[socket.id]) return;
        
        if (rooms[roomId].users[socket.id].banned || rooms[roomId].gameOver) return;
        
        rooms[roomId].messages.push({ id: socket.id, text });
        io.to(roomId).emit('newMessage', { id: socket.id, name: rooms[roomId].users[socket.id].name, text });
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId] && rooms[roomId].users[socket.id]) {
            const name = rooms[roomId].users[socket.id].name;
            delete rooms[roomId].users[socket.id];
            io.to(roomId).emit('updateUsers', Object.values(rooms[roomId].users));
            io.to(roomId).emit('newMessage', { id: 'system', name: 'Система', text: `${name} отключился.` });
            
            if (Object.keys(rooms[roomId].users).length === 0) delete rooms[roomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
