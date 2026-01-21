const admin = require('firebase-admin');

// Render ላይ የሞላናቸውን ቁልፎች እዚህ ጋር ይጠራቸዋል
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

// ጨዋታ መኖሩን የሚከታተል (Watcher)
gamesRef.on('value', (snapshot) => {
  const games = snapshot.val();
  if (!games) {
    console.log("No games found in database.");
    return;
  }
  console.log("Games data updated! Checking for active games...");
  
  // እዚህ ጋር ታይመሩን የሚጀምረው ኮድህ ይቀጥላል
});
