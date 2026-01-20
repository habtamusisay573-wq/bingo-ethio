const admin = require('firebase-admin');

// Render ላይ የሞላናቸውን Environment Variables እዚህ ጋር ያነባቸዋል
const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'), // የኒው ላይን ስህተትን ለማስተካከል
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.PROJECT_ID}-default-rtdb.firebaseio.com`
});

const db = admin.database();
const gamesRef = db.ref('games');

console.log("--- DAGI BINGO SERVER IS STARTING ---");

// በየሰከንዱ ዳታቤዙን ቼክ ያደርጋል
gamesRef.on('value', (snapshot) => {
  const games = snapshot.val();
  if (!games) return;

  Object.keys(games).forEach(gameId => {
    const game = games[gameId];
    
    // ተጫዋች ካለና ጨዋታው ገና ካልተጀመረ (Auto-start logic)
    if (game.status === 'waiting' && game.players) {
        console.log(`Game ${gameId} is starting in 30 seconds...`);
        // እዚህ ጋር የ30 ሰከንድ ታይመርና የቁጥር መሳያ ሎጂክ ይቀጥላል
    }
  });
});
