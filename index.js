const admin = require('firebase-admin');

// Render Environment Variables
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
const gameRef = db.ref('Game'); // ካፒታል Game መሆኑን አረጋግጠናል

console.log("--- DAGI BINGO SERVER UPDATED & STARTING ---");

// በ 'Game' ፎልደር ውስጥ ለውጥ ሲኖር ያዳምጣል
gameRef.on('value', (snapshot) => {
  const games = snapshot.val();
  if (!games) {
    console.log("No games found in /Game path.");
    return;
  }

  Object.keys(games).forEach(gameId => {
    const game = games[gameId];

    // ታይመሩ እንዲጀምር የሚያደርግ ሁኔታ
    // status: 'waiting' ከሆነ ወይም ዝም ብሎ መረጃ ከተገኘ
    if ((game.status === 'waiting' || !game.status) && !game.isTimerRunning) {
      runGameLogic(gameId);
    }
  });
});

function runGameLogic(gameId) {
  console.log(`Game found! ID: ${gameId}. Starting countdown...`);
  
  // ታይመሩ ደግሞ ደግሞ እንዳይጀምር መቆለፊያ
  db.ref(`Game/${gameId}`).update({ isTimerRunning: true, status: 'waiting' });

  let timeLeft = 30;
  const timerInterval = setInterval(() => {
    timeLeft--;

    // Firebase ላይ ታይመሩን በየሰከንዱ መጻፍ
    db.ref(`Game/${gameId}`).update({ timer: timeLeft });

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      
      // ጨዋταውን ማስጀመር
      db.ref(`Game/${gameId}`).update({ 
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
      db.ref(`Game/${gameId}`).update({ status: 'finished' });
      return;
    }

    let nextNumber;
    do {
      nextNumber = Math.floor(Math.random() * 75) + 1;
    } while (drawnNumbers.includes(nextNumber));

    drawnNumbers.push(nextNumber);

    // አዲሱን ቁጥር Firebase ላይ መጫን
    db.ref(`Game/${gameId}`).update({
      currentNumber: nextNumber,
      drawnNumbers: drawnNumbers
    });

    console.log(`Game: ${gameId} | Drawn Number: ${nextNumber}`);
  }, 5000); // በየ 5 ሰከንዱ ቁጥር ያወጣል
}
