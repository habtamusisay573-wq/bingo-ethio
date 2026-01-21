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
const gameRef = db.ref('game');
const ADMIN_ID = "8431270634"; // የዳኛው ቴሌግራም ID

gameRef.on('value', async (snapshot) => {
  const gameData = snapshot.val();
  if (!gameData) return;

  // አሸናፊ ሲኖር ወይም ጨዋታው ሲያልቅ ክፍያ ፈጽሞ በ 3 ሰከንድ ውስጥ ሪሴት ያደርጋል
  if (gameData.winner && !gameData.isResetting) {
    await db.ref('game').update({ isResetting: true });

    const winnerId = gameData.winner.id;
    const betPrice = gameData.currentBetPrice || 0;

    // ሁሉንም የተያዙ ካርቴላዎች መቁጠር
    const boardsSnap = await db.ref('reserved_boards').get();
    const boardsData = boardsSnap.val() || {};
    const totalPlayers = Object.keys(boardsData).length;
    
    const totalPool = totalPlayers * betPrice;
    const winnerAmount = totalPool * 0.8; // 80% ለአሸናፊ
    const adminAmount = totalPool * 0.2;  // 20% ለዳኛ

    try {
      // 1. ለአሸናፊው ብር መጨመር
      if (winnerAmount > 0) {
        await db.ref(`users/${winnerId}/bal`).transaction(curr => (curr || 0) + winnerAmount);
        // ታሪክ መመዝገብ
        await db.ref(`history/${winnerId}`).push({
            type: "BINGO WIN",
            amt: winnerAmount,
            status: "Success",
            date: new Date().toLocaleString()
        });
      }
      
      // 2. ለዳኛው ኮሚሽን መጨመር
      if (adminAmount > 0) {
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + adminAmount);
      }

      console.log(`Bingo Processed: TotalPool:${totalPool}, Winner:${winnerAmount}, Admin:${adminAmount}`);
    } catch (err) {
      console.error("Payment error:", err);
    }

    // ከክፍያ በኋላ ጨዋታውን ሪሴት ማድረግ
    setTimeout(() => {
      db.ref('reserved_boards').remove(); 
      db.ref('game').set({
        drawn: [],
        timer: -1,
        status: 'idle',
        isTimerRunning: false,
        isResetting: false,
        winner: null,
        currentNumber: null,
        currentBetPrice: 0
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
    if (snap.val() !== 'active' || winSnap.val()) {
      clearInterval(drawInterval);
      return;
    }
    if (drawn.length >= 75) {
      clearInterval(drawInterval);
      db.ref('game').update({ status: 'finished' });
      return;
    }
    let n;
    do { n = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(n));
    drawn.push(n);
    db.ref('game').update({ currentNumber: n, drawn: drawn });
  }, 4500); 
}
