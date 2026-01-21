const admin = require('firebase-admin');
const http = require('http');

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bingo Server is Running\n');
}).listen(port);

const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://dagi-bingo-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();

db.ref('game').on('value', async (snapshot) => {
  const gameData = snapshot.val();
  if (!gameData) return;

  // አሸናፊ ሲኖር ክፍያ የመፈጸም ስራ
  if (gameData.winner && !gameData.isResetting) {
    db.ref('game/isResetting').set(true);
    
    const boardsSnap = await db.ref('reserved_boards').get();
    const boards = boardsSnap.val() || {};
    const totalPlayers = Object.keys(boards).length;
    const totalPool = totalPlayers * gameData.winner.bet;
    
    let winAmount = 0;
    if (totalPool <= 50) {
      winAmount = 50;
    } else {
      winAmount = totalPool * 0.80; // 20% ቅናሽ
      const commission = totalPool * 0.20;
      db.ref('admin/commission').transaction(c => (c || 0) + commission);
    }

    db.ref('users/' + gameData.winner.id + '/bal').transaction(b => (b || 0) + winAmount);

    setTimeout(() => {
      db.ref('reserved_boards').remove();
      db.ref('game').set({
        drawn: [], timer: -1, status: 'idle', isTimerRunning: false, isResetting: false, winner: null
      });
    }, 4000);
  }

  if (gameData.status === 'waiting' && !gameData.isTimerRunning) {
    startBingoTimer();
  }
});

function startBingoTimer() {
  db.ref('game').update({ isTimerRunning: true, timer: 30 });
  let timeLeft = 30;
  const interval = setInterval(() => {
    timeLeft--;
    db.ref('game/timer').set(timeLeft);
    if (timeLeft <= 0) {
      clearInterval(interval);
      db.ref('game').update({ status: 'active', isTimerRunning: false });
      startDrawing();
    }
  }, 1000);
}

function startDrawing() {
  let drawn = [];
  const drawInterval = setInterval(async () => {
    const game = (await db.ref('game').get()).val();
    if (game.status !== 'active' || game.winner) return clearInterval(drawInterval);
    
    if (drawn.length >= 75) {
      db.ref('game/status').set('finished');
      return clearInterval(drawInterval);
    }
    
    let n;
    do { n = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(n));
    drawn.push(n);
    db.ref('game').update({ currentNumber: n, drawn: drawn });
  }, 2000);
}
