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

console.log("DAGI BINGO SERVER STARTING...");

gameRef.on('value', (snapshot) => {
  const gameData = snapshot.val();
  if (!gameData) return;

  // status 'waiting' ሲሆን እና ታይመሩ ካልጀመረ ያስጀምራል
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
      db.ref('game').update({ 
        status: 'active', 
        isTimerRunning: false, 
        timer: 0 
      });
      startDrawingNumbers();
    }
  }, 1000);
}

function startDrawingNumbers() {
  let drawn = [];
  const drawInterval = setInterval(async () => {
    const snap = await db.ref('game/status').get();
    if (snap.val() !== 'active') {
      clearInterval(drawInterval);
      return;
    }

    if (drawn.length >= 75) {
      clearInterval(drawInterval);
      db.ref('game').update({ status: 'finished' });
      return;
    }

    let n;
    do {
      n = Math.floor(Math.random() * 75) + 1;
    } while (drawn.includes(n));

    drawn.push(n);
    db.ref('game').update({
      currentNumber: n,
      drawn: drawn // ከ HTML ጋር እንዲጣጣም ስሙ ተስተካክሏል
    });
  }, 5000); 
}
