const admin = require('firebase-admin');

// Render ላይ የሞላሃቸው Environment Variables
const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
};

// Firebase አጀማመር
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://dagi-bingo-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const gameRef = db.ref('game'); // አንተ ጋር ባለው መሰረት በትንሽ ፊደል

console.log("--- DAGI BINGO MASTER SERVER IS LIVE ---");

// በ 'game' ፎልደር ስር ያለን ማንኛውንም ለውጥ ይከታተላል
gameRef.on('value', (snapshot) => {
  const games = snapshot.val();
  
  if (!games) {
    console.log("Waiting for data in /game...");
    return;
  }

  // ሁሉንም የጨዋታ አይዲዎች (Game IDs) ይፈትሻል
  Object.keys(games).forEach(gameId => {
    const gameData = games[gameId];

    // ሁኔታው 'waiting' ከሆነ እና ታይመሩ ገና ካልጀመረ ብቻ ያስጀምረዋል
    if (gameData.status === 'waiting' && !gameData.isTimerRunning) {
      startBingoTimer(gameId);
    }
  });
});

function startBingoTimer(gameId) {
  console.log(`Bingo found! Starting timer for Game: ${gameId}`);
  
  // 'update' በመጠቀም ያለውን ዳታ ሳይነካ አዲስ መረጃ ብቻ ይጨምራል
  db.ref(`game/${gameId}`).update({ 
    isTimerRunning: true,
    timer: 30 
  });

  let timeLeft = 30;
  const timerInterval = setInterval(() => {
    timeLeft--;

    // በየሰከንዱ ታይመሩን Firebase ላይ ያድሳል
    db.ref(`game/${gameId}`).update({ timer: timeLeft });

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      
      // ታይመሩ ሲያልቅ ሁኔታውን ወደ 'active' ይቀይራል
      db.ref(`game/${gameId}`).update({ 
        status: 'active', 
        isTimerRunning: false,
        timer: 0 
      });

      console.log(`Game ${gameId} is now active. Drawing numbers...`);
      startDrawingNumbers(gameId);
    }
  }, 1000);
}

function startDrawingNumbers(gameId) {
  let drawnNumbers = [];
  
  const drawInterval = setInterval(() => {
    // 75 ቁጥሮች ሲወጡ ጨዋታው ያበቃል
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

    // አዲሱን ቁጥር እና የወጡትን ዝርዝር Firebase ላይ ይጭናል
    db.ref(`game/${gameId}`).update({
      currentNumber: nextNumber,
      drawnNumbers: drawnNumbers
    });

    console.log(`Game: ${gameId} | Drawn: ${nextNumber}`);
  }, 5000); // በየ 5 ሰከንዱ አዲስ ቁጥር
}
