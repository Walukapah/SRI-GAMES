const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS setup for Koyeb
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Health check endpoint for Koyeb
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const rooms = new Map();

// Carrom setup
const COIN_RADIUS = 12;
const STRIKER_RADIUS = 16;
const BOARD_WIDTH = 520;
const BOARD_HEIGHT = 520;
const FRICTION = 0.985;
const WALL_BOUNCE = 0.8;
const POCKETS = [
    { x: 0, y: 0 },
    { x: BOARD_WIDTH, y: 0 },
    { x: 0, y: BOARD_HEIGHT },
    { x: BOARD_WIDTH, y: BOARD_HEIGHT }
];

function createInitialState() {
    const coins = [];
    
    // Striker
    coins.push({
        id: 'striker',
        type: 'striker',
        x: BOARD_WIDTH / 2,
        y: BOARD_HEIGHT - 40,
        vx: 0,
        vy: 0,
        radius: STRIKER_RADIUS,
        pocketed: false
    });
    
    // Queen (center)
    coins.push({
        id: 'queen',
        type: 'queen',
        x: BOARD_WIDTH / 2,
        y: BOARD_HEIGHT / 2,
        vx: 0,
        vy: 0,
        radius: COIN_RADIUS,
        pocketed: false
    });
    
    // White coins
    const whitePositions = [
        { x: 0, y: -35 }, { x: 30, y: -17 }, { x: 30, y: 17 },
        { x: 0, y: 35 }, { x: -30, y: 17 }, { x: -30, y: -17 },
        { x: 0, y: -70 }, { x: 60, y: -35 }, { x: 60, y: 35 }
    ];
    
    whitePositions.forEach((pos, i) => {
        coins.push({
            id: `white${i}`,
            type: 'white',
            x: BOARD_WIDTH / 2 + pos.x,
            y: BOARD_HEIGHT / 2 + pos.y,
            vx: 0,
            vy: 0,
            radius: COIN_RADIUS,
            pocketed: false
        });
    });
    
    // Black coins
    const blackPositions = [
        { x: 0, y: -52 }, { x: 45, y: -26 }, { x: 45, y: 26 },
        { x: 0, y: 52 }, { x: -45, y: 26 }, { x: -45, y: -26 },
        { x: 52, y: 0 }, { x: -52, y: 0 }, { x: 26, y: -45 }
    ];
    
    blackPositions.forEach((pos, i) => {
        coins.push({
            id: `black${i}`,
            type: 'black',
            x: BOARD_WIDTH / 2 + pos.x,
            y: BOARD_HEIGHT / 2 + pos.y,
            vx: 0,
            vy: 0,
            radius: COIN_RADIUS,
            pocketed: false
        });
    });
    
    return {
        coins,
        currentPlayer: 1,
        scores: [0, 0],
        queenOwner: null,
        gameOver: false,
        winner: null
    };
}

function updatePhysics(state) {
    let moving = false;
    
    state.coins.forEach(coin => {
        if (coin.pocketed) return;
        
        coin.x += coin.vx;
        coin.y += coin.vy;
        
        coin.vx *= FRICTION;
        coin.vy *= FRICTION;
        
        if (Math.abs(coin.vx) < 0.01) coin.vx = 0;
        if (Math.abs(coin.vy) < 0.01) coin.vy = 0;
        
        if (coin.vx !== 0 || coin.vy !== 0) moving = true;
        
        // Wall collisions
        if (coin.x - coin.radius < 0) {
            coin.x = coin.radius;
            coin.vx = -coin.vx * WALL_BOUNCE;
        }
        if (coin.x + coin.radius > BOARD_WIDTH) {
            coin.x = BOARD_WIDTH - coin.radius;
            coin.vx = -coin.vx * WALL_BOUNCE;
        }
        if (coin.y - coin.radius < 0) {
            coin.y = coin.radius;
            coin.vy = -coin.vy * WALL_BOUNCE;
        }
        if (coin.y + coin.radius > BOARD_HEIGHT) {
            coin.y = BOARD_HEIGHT - coin.radius;
            coin.vy = -coin.vy * WALL_BOUNCE;
        }
        
        // Check pockets
        POCKETS.forEach(pocket => {
            const dist = Math.hypot(coin.x - pocket.x, coin.y - pocket.y);
            if (dist < 25 && coin.type !== 'striker') {
                coin.pocketed = true;
                coin.vx = 0;
                coin.vy = 0;
                handlePocketedCoin(state, coin);
            }
        });
    });
    
    // Coin collisions
    for (let i = 0; i < state.coins.length; i++) {
        for (let j = i + 1; j < state.coins.length; j++) {
            const c1 = state.coins[i];
            const c2 = state.coins[j];
            
            if (c1.pocketed || c2.pocketed) continue;
            
            const dx = c2.x - c1.x;
            const dy = c2.y - c1.y;
            const dist = Math.hypot(dx, dy);
            const minDist = c1.radius + c2.radius;
            
            if (dist < minDist) {
                const overlap = minDist - dist;
                const nx = dx / dist;
                const ny = dy / dist;
                
                c1.x -= nx * overlap * 0.5;
                c1.y -= ny * overlap * 0.5;
                c2.x += nx * overlap * 0.5;
                c2.y += ny * overlap * 0.5;
                
                const dvx = c2.vx - c1.vx;
                const dvy = c2.vy - c1.vy;
                const dv = dvx * nx + dvy * ny;
                
                if (dv > 0) continue;
                
                const impulse = 2 * dv / 2;
                c1.vx += impulse * nx;
                c1.vy += impulse * ny;
                c2.vx -= impulse * nx;
                c2.vy -= impulse * ny;
            }
        }
    }
    
    return moving;
}

function handlePocketedCoin(state, coin) {
    const playerIndex = state.currentPlayer - 1;
    
    if (coin.type === 'queen') {
        state.queenOwner = state.currentPlayer;
    } else if (coin.type === 'white') {
        if (state.currentPlayer === 1) {
            state.scores[0]++;
            state.turnAgain = true;
        } else {
            state.scores[0] = Math.max(0, state.scores[0] - 1);
        }
    } else if (coin.type === 'black') {
        if (state.currentPlayer === 2) {
            state.scores[1]++;
            state.turnAgain = true;
        } else {
            state.scores[1] = Math.max(0, state.scores[1] - 1);
        }
    }
    
    if (state.scores[0] >= 8) {
        state.gameOver = true;
        state.winner = 1;
    } else if (state.scores[1] >= 8) {
        state.gameOver = true;
        state.winner = 2;
    }
}

function resetStriker(state, playerNum) {
    const striker = state.coins.find(c => c.type === 'striker');
    if (striker) {
        striker.x = BOARD_WIDTH / 2;
        striker.y = playerNum === 1 ? BOARD_HEIGHT - 40 : 40;
        striker.vx = 0;
        striker.vy = 0;
        striker.pocketed = false;
    }
}

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('joinRoom', ({ name, roomId: requestedRoom }) => {
        let roomId = requestedRoom || generateRoomId();
        
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                id: roomId,
                players: [],
                state: createInitialState(),
                physicsInterval: null
            });
        }
        
        const room = rooms.get(roomId);
        
        if (room.players.length >= 2) {
            socket.emit('error', 'Room is full');
            return;
        }
        
        const playerNumber = room.players.length + 1;
        room.players.push({
            id: socket.id,
            name: name || `Player ${playerNumber}`,
            number: playerNumber
        });
        
        socket.join(roomId);
        socket.roomId = roomId;
        socket.playerNumber = playerNumber;
        
        socket.emit('roomJoined', {
            roomId,
            playerNumber,
            players: room.players.map(p => ({ name: p.name, number: p.number }))
        });
        
        socket.to(roomId).emit('playerJoined', {
            name: name || `Player ${playerNumber}`,
            playerNumber
        });
        
        if (room.players.length === 2) {
            io.to(roomId).emit('gameState', room.state);
            io.to(roomId).emit('turnChange', {
                currentPlayer: 1,
                playerName: room.players[0].name
            });
            
            room.physicsInterval = setInterval(() => {
                const moving = updatePhysics(room.state);
                io.to(roomId).emit('gameState', room.state);
                
                if (!moving && room.state.turnAgain) {
                    room.state.turnAgain = false;
                } else if (!moving) {
                    room.state.currentPlayer = room.state.currentPlayer === 1 ? 2 : 1;
                    resetStriker(room.state, room.state.currentPlayer);
                    const currentPlayer = room.players.find(p => p.number === room.state.currentPlayer);
                    io.to(roomId).emit('turnChange', {
                        currentPlayer: room.state.currentPlayer,
                        playerName: currentPlayer.name
                    });
                }
                
                if (room.state.gameOver) {
                    clearInterval(room.physicsInterval);
                    const winner = room.players.find(p => p.number === room.state.winner);
                    io.to(roomId).emit('gameOver', {
                        winner: room.state.winner,
                        winnerName: winner.name
                    });
                }
            }, 1000 / 60);
        }
    });
    
    socket.on('strike', ({ roomId, force, angle, position }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const striker = room.state.coins.find(c => c.type === 'striker');
        if (striker) {
            striker.vx = Math.cos(angle) * force;
            striker.vy = Math.sin(angle) * force;
        }
    });
    
    socket.on('resetGame', (roomId) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        clearInterval(room.physicsInterval);
        room.state = createInitialState();
        room.physicsInterval = setInterval(() => {
            const moving = updatePhysics(room.state);
            io.to(roomId).emit('gameState', room.state);
            
            if (!moving && room.state.turnAgain) {
                room.state.turnAgain = false;
            } else if (!moving) {
                room.state.currentPlayer = room.state.currentPlayer === 1 ? 2 : 1;
                resetStriker(room.state, room.state.currentPlayer);
                const currentPlayer = room.players.find(p => p.number === room.state.currentPlayer);
                io.to(roomId).emit('turnChange', {
                    currentPlayer: room.state.currentPlayer,
                    playerName: currentPlayer.name
                });
            }
        }, 1000 / 60);
        
        io.to(roomId).emit('gameState', room.state);
        io.to(roomId).emit('gameReset');
        io.to(roomId).emit('turnChange', {
            currentPlayer: 1,
            playerName: room.players[0].name
        });
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        if (socket.roomId) {
            const room = rooms.get(socket.roomId);
            if (room) {
                room.players = room.players.filter(p => p.id !== socket.id);
                
                if (room.players.length === 0) {
                    clearInterval(room.physicsInterval);
                    rooms.delete(socket.roomId);
                } else {
                    io.to(socket.roomId).emit('playerLeft', {
                        message: 'Opponent left the game'
                    });
                }
            }
        }
    });
});

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
