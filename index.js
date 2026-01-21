const admin = require('firebase-admin');

// Render Environment Variables (እነዚህን በ Render ላይ መሙላትህን እርግጠኛ ሁን)
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

console.log("--- DAGI BINGO SERVER IS STARTING (Target: /game) ---");

gameRef.on('value', (snapshot) => {
  const games = snapshot.val();
  if (!games) {
    console.log("No games found in /game path yet.");
    return;
  }

  Object.keys(games).forEach(gameId => {
    const gameData = games[gameId];

    // ጨዋታው 'waiting' ከሆነ እና ታይመሩ ገና ካልጀመረ ያስጀምረዋል
    if (gameData.status === 'waiting' && !gameData.isTimerRunning) {
      startBingoTimer(gameId);
    }
  });
});

function startBingoTimer(gameId) {
  console.log(`Starting countdown for Game ID: ${gameId}`);
  
  // ታይመሩ መጀመሩን መቆለፊያ (isTimerRunning)
  db.ref(`game/${gameId}`).update({ isTimerRunning: true });

  let timeLeft = 30; // 30 ሰከንድ ታይመር
  const timerInterval = setInterval(() => {
    timeLeft--;

    // Firebase ላይ ታይመሩን መጻፍ
    db.ref(`game/${gameId}`).update({ timer: timeLeft });

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      
      // ታይመሩ ሲያልቅ ወደ 'active' ይቀየራል
      db.ref(`game/${gameId}`).update({ 
        status: 'active', 
        isTimerRunning: false,
        timer: 0 
      });

      console.log(`Timer finished for ${gameId}. Starting to draw numbers...`);
      startDrawingNumbers(gameId);
    }
  }, 1000);
}

function startDrawingNumbers(gameId) {
  let drawnNumbers = [];
  
  const drawInterval = setInterval(() => {
    // 75 ቁጥር ሲወጣ ጨዋታው ይቆማል
    if (drawnNumbers.length >= 75) {
      clearInterval(drawInterval);
      db.ref(`game/${gameId}`).update({ status: 'finished' });
      return;
    }

    // አዲስ ቁጥር መምረጥ (ያልወጣ መሆኑን እያረጋገጠ)
    let nextNumber;
    do {
      nextNumber = Math.floor(Math.random() * 75) + 1;
    } while (drawnNumbers.includes(nextNumber));

    drawnNumbers.push(nextNumber);

    // Firebase ላይ ቁጥሮቹን መጫን
    db.ref(`game/${gameId}`).update({
      currentNumber: nextNumber,
      drawnNumbers: drawnNumbers
    });

    console.log(`Game: ${gameId} | New Number: ${nextNumber}`);
  }, 5000); // በየ 5 ሰከንዱ ቁጥር ያወጣል
}
