const admin = require('firebase-admin');

// Render ላይ የሞላናቸውን Environment Variables ይጠቀማል
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

// ሙሉ ዳታቤዙን ('/') እንዲያዳምጥ አደረግነው የትም ቦታ ዳታ ቢገባ እንዲያገኘው
const rootRef = db.ref('/');

console.log("--- DAGI BINGO SMART SERVER IS STARTING ---");

rootRef.on('value', (snapshot) => {
  const data = snapshot.val();
  if (!data) return;

  // በዳታቤዙ ውስጥ 'status' የሚል ቃል ያለበትን ቦታ በሙሉ ይፈልጋል
  searchForGames(data, '/');
});

function searchForGames(obj, path) {
  for (let key in obj) {
    if (typeof obj[key] === 'object') {
      searchForGames(obj[key], path + key + '/');
    } else if (key === 'status' && obj[key] === 'waiting') {
      const gamePath = path;
      const gameData = obj;
      
      // ታይመሩ ገና ካልጀመረ ያስጀምረዋል
      if (!gameData.isTimerRunning) {
        startBingoTimer(gamePath);
      }
    }
  }
}

function startBingoTimer(gamePath) {
  console.log(`Bingo found at ${gamePath}. Starting Timer...`);
  db.ref(gamePath).update({ isTimerRunning: true });

  let timeLeft = 30;
  const timerInterval = setInterval(() => {
    timeLeft--;
    db.ref(gamePath).update({ timer: timeLeft });

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      db.ref(gamePath).update({ 
        status: 'active', 
        isTimerRunning: false,
        timer: 0 
      });
      console.log(`Game at ${gamePath} started! Drawing numbers...`);
      startDrawingNumbers(gamePath);
    }
  }, 1000);
}

function startDrawingNumbers(gamePath) {
  let drawnNumbers = [];
  const drawInterval = setInterval(() => {
    if (drawnNumbers.length >= 75) {
      clearInterval(drawInterval);
      return;
    }

    let nextNumber;
    do {
      nextNumber = Math.floor(Math.random() * 75) + 1;
    } while (drawnNumbers.includes(nextNumber));

    drawnNumbers.push(nextNumber);
    db.ref(gamePath).update({
      currentNumber: nextNumber,
      drawnNumbers: drawnNumbers
    });
    console.log(`Path: ${gamePath} | Drawn: ${nextNumber}`);
  }, 5000); // በየ 5 ሰከንዱ ቁጥር ያወጣል
}
