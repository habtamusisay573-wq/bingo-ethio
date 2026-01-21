const admin = require('firebase-admin');
const http = require('http');

// 1. Render ሰርቨሩ በ Port ምክንያት እንዳይዘጋ (Timeout ስህተትን ይፈታል)
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bingo Server is Running\n');
}).listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// 2. Firebase አጀማመር (Environment Variables ይጠቀማል)
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
// አንተ ጋር ባለው መሰረት በትንሽ ፊደል 'game' እንዲያነብ ተደርጓል
const gameRef = db.ref('game'); 

console.log("--- DAGI BINGO MASTER SERVER IS STARTING ---");

// 3. የዳታቤዝ ክትትል
gameRef.on('value', (snapshot) => {
  const games = snapshot.val();
  if (!games) {
    console.log("Waiting for data in /game folder...");
    return;
  }

  Object.keys(games).forEach(gameId => {
    const gameData = games[gameId];
    // status: 'waiting' ከሆነ እና ታይመሩ ካልሮጠ ያስጀምረዋል
    if (gameData.status === 'waiting' && !gameData.isTimerRunning) {
      startBingoTimer(gameId);
    }
  });
});

function startBingoTimer(gameId) {
  console.log(`Bingo found! Starting timer for Game ID: ${gameId}`);
  
  // ዳታው እንዳይጠፋ .update() እንጠቀማለን
  db.ref(`game/${gameId}`).update({ 
    isTimerRunning: true,
    timer: 30 
  });

  let timeLeft = 30;
  const timerInterval = setInterval(() => {
    timeLeft--;
    db.ref(`game/${gameId}`).update({ timer: timeLeft });

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      
      // ታይመሩ ሲያልቅ ሁኔታውን ወደ 'active' ይቀይራል
      db.ref(`game/${gameId}`).update({ 
        status: 'active', 
        isTimerRunning: false,
        timer: 0 
      });

      console.log(`Timer finished for ${gameId}. Drawing numbers...`);
      startDrawingNumbers(gameId);
    }
  }, 1000);
}

function startDrawingNumbers(gameId) {
  let drawnNumbers = [];
  const drawInterval = setInterval(() => {
    if (drawnNumbers.length >= 75) {
      clearInterval(drawInterval);
      db.ref(`game/${gameId}`).update({ status: 'finished' });
      return;
    }

    let nextNumber;
    do {
      nextNumber = Math.floor(Math.random() * 75) + 1;
    } while (drawnNumbers.includes(nextNumber));

    drawnNumbers.push(nextNumber);

    db.ref(`game/${gameId}`).update({
      currentNumber: nextNumber,
      drawnNumbers: drawnNumbers
    });

    console.log(`Game: ${gameId} | Drawn Number: ${nextNumber}`);
  }, 5000); // በየ 5 ሰከንዱ ቁጥር ያወጣል
}
