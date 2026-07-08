const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const AI_API_URL = "https://text.pollinations.ai/";
const ROUND_TIME = 90000; // 1 минута 30 секунд

const fallbackTopics = [
    "Если бы вы были овощами, кто бы вы были?",
    "Докажите, что шаурма — это живой организм.",
    "Обсуждаем план побега из зоопарка.",
    "Почему пельмени лучше котлет? Обоснуйте.",
    "Если бы у вас был ручной дракон, как бы вы его выгуливали?"
];

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

    const history = room.messages.slice(-15).map(m => `${room.users[m.id]?.name || 'Unknown'}: ${m.text}`).join('\n');
    const playersList = players.map(id => room.users[id].name).join(', ');
    
    // Новый промпт: логика, мат, сарказм
    const prompt = `Ты — дерзкий, саркастичный ИИ-модератор чата. Твоя задача — анализировать сообщения пользователей и банить того, кто больше всего бесит: пишет не по теме, спамит рандомными буквами, слишком скучно, слишком душно или просто тупит. 
    Разрешено использовать мат, сарказм и интернет-сленг. Причина бана должна быть смешной, логичной и бьющей точно в цель.
    Доступные юзеры для бана: ${playersList}.
    История чата:\n${history}\n
    Выбери ОДНОГО юзера из списка выше, придумай едкую причину бана, а также придумай новую безумную тему для следующего раунда. 
    Ответь СТРОКОЙ в формате JSON без markdown: {"username": "имя_юзера", "reason": "причина", "next_topic": "новая_тема"}`;

    let banReason = "ИИ забыл причину, но банит просто так.";
    let targetId = null;
    let nextTopic = fallbackTopics[Math.floor(Math.random() * fallbackTopics.length)];

    try {
        const response = await fetch(`${AI_API_URL}${encodeURIComponent(prompt)}`);
        let data = await response.text();
        
        const match = data.match(/\{.*\}/s);
        if (match) {
            data = match[0];
            const banData = JSON.parse(data);
            
            banReason = banData.reason || banReason;
            nextTopic = banData.next_topic || nextTopic;
            
            // Ищем юзера (сравниваем без учета регистра, чтобы ИИ не ошибся)
            targetId = Object.keys(room.users).find(id => 
                room.users[id].name.toLowerCase() === (banData.username || '').toLowerCase().trim()
            );
            
            // Если ИИ ошибся ником, баним того, кто меньше всего писал
            if (!targetId) {
                targetId = players[Math.floor(Math.random() * players.length)];
            }
        } else {
            throw new Error("Неверный формат ИИ");
        }
    } catch (e) {
        targetId = players[Math.floor(Math.random() * players.length)];
        const fallbackReasons = [
            "Слишком тихо сидишь. Подозрительно.",
            "Твой вайб просто отвратителен сегодня.",
            "ИИ решил, что ты душнила. Бан.",
            "Пишешь так, будто тебя заставили. Увольняю."
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
        } else {
            room.topic = nextTopic;
            room.startTime = Date.now() + ROUND_TIME;
            room.messages = []; 
            
            io.to(roomId).emit('newRound', { topic: room.topic, startTime: room.startTime });
            io.to(roomId).emit('newMessage', { id: 'system', name: 'Система', text: `🚨 НОВЫЙ РАУНД! Тема: ${room.topic}` });
            io.to(roomId).emit('updateUsers', Object.values(room.users));
            
            setTimeout(() => moderateRoom(roomId), ROUND_TIME);
        }
    }
}

io.on('connection', (socket) => {
    console.log('Новый игрок подключился:', socket.id);

    socket.on('createRoom', (nickname) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        const startTopic = fallbackTopics[Math.floor(Math.random() * fallbackTopics.length)];
        
        rooms[roomId] = {
            users: {},
            messages: [],
            gameOver: false,
            topic: startTopic,
            startTime: Date.now() + ROUND_TIME
        };
        socket.join(roomId);
        rooms[roomId].users[socket.id] = { name: nickname, banned: false };
        socket.data.roomId = roomId;
        
        socket.emit('roomJoined', { roomId, topic: rooms[roomId].topic, userId: socket.id, startTime: rooms[roomId].startTime });
        io.to(roomId).emit('updateUsers', Object.values(rooms[roomId].users));
        io.to(roomId).emit('newMessage', { id: 'system', name: 'Система', text: `Комната создана. Код: ${roomId}. Ждем игроков!` });
        
        setTimeout(() => moderateRoom(roomId), ROUND_TIME);
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
            io.to(roomId).emit('newMessage', { id: 'system', name: 'Система', text: `${name} сбежал.` });
            
            if (Object.keys(rooms[roomId].users).length === 0) delete rooms[roomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
