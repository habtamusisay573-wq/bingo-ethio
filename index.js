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

// --- 1. ተጫዋች ሲወጣ 3 ሰከንድ ጠብቆ RESET የማድረግ Logic ---
let resetTimeout = null;
db.ref('online_players').on('value', (snapshot) => {
    const playerCount = snapshot.numChildren();
    if (playerCount === 0) {
        if (resetTimeout) clearTimeout(resetTimeout);
        resetTimeout = setTimeout(async () => {
            const gameSnap = await db.ref('game').get();
            const gameData = gameSnap.val();
            if (gameData && gameData.status !== 'idle') {
                await db.ref('reserved_boards').remove();
                await db.ref('game').update({
                    drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0, isTimerRunning: false
                });
                console.log("System Reset: No players online.");
            }
        }, 3000);
    } else { if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; } }
});

// --- 2. አንድ ሰው ቦርድ ሲገዛ ሰርቨሩ ራሱ ቆጠራ እንዲጀምር (Auto-Trigger) ---
db.ref('reserved_boards').on('value', async (snap) => {
    if (snap.exists()) {
        const gameSnap = await db.ref('game').get();
        const game = gameSnap.val() || {};
        if (game.status === 'idle' || !game.status) {
            await db.ref('game').update({ status: 'waiting', timer: 30, isTimerRunning: false });
        }
    }
});

// --- 3. MAIN GAME MONITOR ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;

    // አሸናፊ ሲኖር ክፍያ
    if(game.winner && !game.isResetting) {
        await processWinnerPayment(game);
    }

    // ቆጠራ መጀመር
    if(game.status === 'waiting' && !game.isTimerRunning) {
        runTimer();
    }
});

function runTimer() {
    db.ref('game').update({ isTimerRunning: true });
    let sec = 30;
    const interval = setInterval(async () => {
        sec--;
        await db.ref('game/timer').set(sec);
        if(sec <= 0) {
            clearInterval(interval);
            await db.ref('game').update({ status: 'active', isTimerRunning: false, timer: 0 });
            startDrawingNumbers([]);
        }
    }, 1000);
}

function startDrawingNumbers(existingDrawn) {
    let drawn = existingDrawn;
    const interval = setInterval(async () => {
        const gSnap = await db.ref('game').get();
        const g = gSnap.val();
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(interval);
            return;
        }
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        await db.ref('game/drawn').set(drawn);
    }, 4000);
}

async function processWinnerPayment(game) {
    await db.ref('game/isResetting').set(true);
    const winnerId = game.winner.id;
    const betPrice = game.currentBetPrice || 0;
    const boardsSnap = await db.ref('reserved_boards').get();
    const totalPool = boardsSnap.numChildren() * betPrice;
    
    try {
        await db.ref(`users/${winnerId}/bal`).transaction(c => (c || 0) + (totalPool * 0.8));
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + (totalPool * 0.2));
        await db.ref(`history/${winnerId}`).push({
            type: "የቢንጎ ድል 🏆", amt: (totalPool * 0.8), status: "ተከፍሏል", date: new Date().toLocaleString()
        });
    } catch (e) { console.error("Payment Error", e); }

    setTimeout(() => {
        db.ref('reserved_boards').remove();
        db.ref('game').set({ drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0, isTimerRunning: false });
    }, 5000);
}
