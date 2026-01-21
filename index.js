const admin = require('firebase-admin');

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
const gamesRef = db.ref('games');

console.log("--- DAGI BINGO SERVER IS STARTING ---");

gamesRef.on('value', (snapshot) => {
  const games = snapshot.val();
  if (!games) return;

  Object.keys(games).forEach(gameId => {
    const game = games[gameId];

    // ታይመሩ ገና ካልጀመረ (status waiting ሲሆን)
    if (game.status === 'waiting' && game.players && !game.isTimerRunning) {
      
      // ታይመሩ ደግሞ ደግሞ እንዳይጀምር መቆለፊያ (Flag)
      db.ref(`games/${gameId}`).update({ isTimerRunning: true });

      let timeLeft = 30; // የ30 ሰከንድ ታይመር
      console.log(`Timer started for game: ${gameId}`);

      const timerInterval = setInterval(() => {
        timeLeft--;

        // በየሰከንዱ Firebase ላይ ታይመሩን አፕዴት ያደርጋል
        db.ref(`games/${gameId}`).update({ timer: timeLeft });

        if (timeLeft <= 0) {
          clearInterval(timerInterval);
          // ታይመሩ ሲያልቅ ጨዋታውን ያስጀምራል
          db.ref(`games/${gameId}`).update({ 
            status: 'started', 
            isTimerRunning: false,
            timer: 0 
          });
          console.log(`Game ${gameId} has officially started!`);
        }
      }, 1000);
    }
  });
});
