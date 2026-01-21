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

  // አሸናፊ ሲኖር ሂሳብ የማስላት ስራ
  if (gameData.winner && !gameData.isResetting) {
    db.ref('game/isResetting').set(true);
    
    // 1. ሁሉንም ተጫዋች ቆጥሮ አጠቃላይ መደብ (Total Pool) ማስላት
    const boardsSnap = await db.ref('reserved_boards').get();
    const boards = boardsSnap.val() || {};
    const totalPlayers = Object.keys(boards).length;
    const totalPool = totalPlayers * gameData.winner.bet;
    
    // 2. 20% ኮሚሽን ማስላት
    const commission = totalPool * 0.20;
    const netWin = totalPool - commission;

    // 3. ኮሚሽኑን ወደ ዳኛ (Admin ID: 8431270634) ዋሌት ገቢ ማድረግ
    db.ref('users/8431270634/bal').transaction(c => (c || 0) + commission);
    
    // 4. የተጣራውን (Net Win) ለአሸናፊው ገቢ ማድረግ
    db.ref('users/' + gameData.winner.id + '/bal').transaction(b => (b || 0) + netWin);

    // 5. ጨዋታውን ቶሎ ሪሴት ማድረግ (በ 4 ሰከንድ ውስጥ)
    setTimeout(() => {
      db.ref('reserved_boards').remove(); // የተያዙ ካርቴላዎችን ማጥፋት
      db.ref('game').set({
        drawn: [],
        timer: -1,
        status: 'idle',
        isTimerRunning: false,
        isResetting: false,
        winner: null,
        currentNumber: null
      });
    }, 4000);
  }

  // ታይመሩ እንዲጀምር
  if (gameData.status === 'waiting' && !gameData.isTimerRunning) {
    startBingoTimer();
  }
});

function startBingoTimer() {
  db.ref('game').update({ isTimerRunning: true, timer: 30 });
  let timeLeft = 30;
  const timerInterval = setInterval(() => {
    timeLeft--;
    db.ref('game').update({ timer: timeLeft });
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      db.ref('game').update({ status: 'active', isTimerRunning: false, timer: 0 });
      startDrawingNumbers();
    }
  }, 1000);
}

function startDrawingNumbers() {
  let drawn = [];
  const drawInterval = setInterval(async () => {
    const snap = await db.ref('game/status').get();
    const winSnap = await db.ref('game/winner').get();
    if (snap.val() !== 'active' || winSnap.val()) return clearInterval(drawInterval);
    
    let n;
    do { n = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(n));
    drawn.push(n);
    db.ref('game').update({ currentNumber: n, drawn: drawn });
  }, 3500); 
}
