const admin = require('firebase-admin');
const http = require('http');

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

// --- ተጫዋች ሲወጣ CLEANUP ---
let resetTimeout = null;
db.ref('online_players').on('value', (snapshot) => {
    if (snapshot.numChildren() === 0) {
        resetTimeout = setTimeout(async () => {
            const gameSnap = await db.ref('game').get();
            if (gameSnap.val() && gameSnap.val().status !== 'idle') {
                await db.ref('reserved_boards').remove();
                await db.ref('game').update({
                    drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0, isTimerRunning: false
                });
                console.log("System Idle Reset.");
            }
        }, 5000);
    } else if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
});

// --- GLOBAL RESET (JS በኩል የሚሰራ) ---
db.ref('admin_commands/global_reset').on('value', async (snap) => {
    if(!snap.val()) return;
    console.log("Global System Reset Triggered by Admin.");
    
    // ሁሉንም ካርቴላዎች፣ ጥያቄዎች እና የጨዋታ ሁኔታዎችን ያጠፋል
    await db.ref('game').set({ drawn: [], status: 'idle', winner: null, timer: -1, currentBetPrice: 0 });
    await db.ref('reserved_boards').remove();
    await db.ref('requests').remove();
    // ማሳሰቢያ፡ የተጫዋቾች ባላንስ እና ታሪክ ለደህንነት ሲባል አልጠፋም (አስፈላጊ ከሆነ .remove() መጨመር ይቻላል)
    
    await db.ref('admin_commands/global_reset').remove();
});

// --- MAIN GAME MONITOR ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;

    if(game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        const winnerId = game.winner.id;
        const betPrice = game.currentBetPrice || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        const totalPool = playersCount * betPrice;
        const winnerPay = totalPool * 0.8;
        const adminPay = totalPool * 0.2;

        try {
            await db.ref(`users/${winnerId}/bal`).transaction(curr => (curr || 0) + winnerPay);
            await db.ref(`history/${winnerId}`).push({
                type: "ቢንጎ ድል 🏆", amt: winnerPay, info: "80% የአሸናፊ ድርሻ", date: new Date().toLocaleString()
            });
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + adminPay);
        } catch (e) { console.error("Payment Error", e); }

        setTimeout(async () => {
            await db.ref('reserved_boards').remove();
            await db.ref('game').set({ drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0 });
        }, 5000);
    }

    if(game.status === 'waiting' && !game.isTimerRunning) { runTimer(); }
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
            startDrawingNumbers();
        }
    }, 1000);
}

function startDrawingNumbers() {
    let drawn = [];
    const interval = setInterval(async () => {
        const g = (await db.ref('game').get()).val();
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) { clearInterval(interval); return; }
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        db.ref('game/drawn').set(drawn);
    }, 4000);
}
