const admin = require('firebase-admin');
const http = require('http');

// ሰርቨር እንዳይዘጋ (For Hosting)
http.createServer((req, res) => {
  res.writeHead(200); res.end('Bingo Server Active');
}).listen(process.env.PORT || 3000);

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
const ADMIN_ID = "8431270634";

// --- SERVER RECOVERY ---
async function checkServerRecovery() {
    const gameSnap = await db.ref('game').get();
    const gameData = gameSnap.val();
    if(gameData && gameData.status === 'active' && !gameData.winner) {
        console.log("Resuming interrupted game...");
        startDrawingNumbers(gameData.drawn || []);
    }
}
checkServerRecovery();

// --- MAIN GAME MONITOR ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;

    // 1. አሸናፊ ሲኖር ክፍያ እና History መመዝገብ
    if(game.winner && !game.isResetting) {
        // ወዲያውኑ ሪሴቲንግ መሆኑን ማሳወቅ (ደግሞ እንዳይከፍል)
        await db.ref('game/isResetting').set(true);
        
        const winnerId = game.winner.id;
        const winnerName = game.winner.name;
        const betPrice = game.currentBetPrice || 0;
        
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        
        const totalPool = playersCount * betPrice;
        const winnerPay = totalPool * 0.8;
        const adminPay = totalPool * 0.2;

        try {
            // ሀ. ክፍያ ለአሸናፊ እና የታሪክ ምዝገባ
            await db.ref(`users/${winnerId}/bal`).transaction(curr => (curr || 0) + winnerPay);
            await db.ref(`history/${winnerId}`).push({
                type: "የቢንጎ ድል 🏆", 
                amt: winnerPay, 
                status: "Success",
                date: new Date().toLocaleString()
            });

            // ለ. ክፍያ ለዳኛ (Admin Commission) እና የታሪክ ምዝገባ
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + adminPay);
            await db.ref(`history/${ADMIN_ID}`).push({
                type: "የዳኛ ኮሚሽን (20%) 💰", 
                amt: adminPay, 
                info: `ከአሸናፊ ${winnerName}`,
                date: new Date().toLocaleString()
            });
            
            // ሐ. ማዕከላዊ Log (ለአንተ ቁጥጥር)
            await db.ref('admin_logs').push({
                winner: winnerName, 
                total_players: playersCount,
                bet_amount: betPrice,
                total_pool: totalPool, 
                admin_share: adminPay, 
                date: new Date().toLocaleString()
            });

            console.log(`Payment Complete: ${winnerName} won ${winnerPay}`);
        } catch (e) { 
            console.error("Payment Failed", e); 
        }

        // ጨዋታውን ሪሴት ማድረግ (ከ 5 ሰከንድ በኋላ)
        setTimeout(() => {
            db.ref('reserved_boards').remove();
            db.ref('game').set({
                drawn: [], 
                status: 'idle', 
                winner: null, 
                isResetting: false, 
                timer: -1, 
                currentBetPrice: 0,
                isTimerRunning: false
            });
        }, 5000);
    }

    // 2. Timer ማስጀመር
    if(game.status === 'waiting' && !game.isTimerRunning) {
        runTimer();
    }
});

function runTimer() {
    db.ref('game').update({ isTimerRunning: true });
    let sec = 30;
    const interval = setInterval(() => {
        sec--;
        db.ref('game/timer').set(sec);
        if(sec <= 0) {
            clearInterval(interval);
            db.ref('game').update({ status: 'active', isTimerRunning: false });
            startDrawingNumbers([]);
        }
    }, 1000);
}

function startDrawingNumbers(existingDrawn) {
    let drawn = existingDrawn;
    const interval = setInterval(async () => {
        const gSnap = await db.ref('game').get();
        const g = gSnap.val();
        
        // ጨዋታው ካለቀ ወይም አሸናፊ ካለ ማቆም
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(interval);
            return;
        }

        let n;
        do { 
            n = Math.floor(Math.random() * 75) + 1; 
        } while(drawn.includes(n));
        
        drawn.push(n);
        db.ref('game/drawn').set(drawn);
    }, 4000);
}
