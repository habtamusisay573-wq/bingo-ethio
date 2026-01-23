const admin = require('firebase-admin');
const http = require('http');

// ሰርቨር እንዳይዘጋ (Keeping it alive)
http.createServer((req, res) => {
  res.writeHead(200); res.end('Bingo Logic Engine Active 🚀');
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

let timerInterval = null;
let drawingInterval = null;

// --- 1. የጨዋታውን ሁኔታ ተቆጣጣሪ (Main Monitor) ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if (!game) return;

    // ሀ. አሸናፊ ሲኖር ክፍያ መፈጸም (አንዴ ብቻ እንዲሰራ isResetting እንጠቀማለን)
    if (game.winner && !game.isResetting) {
        await processWinner(game);
    }

    // ለ. ካርቴላ ተገዝቶ ጨዋታው 'idle' ከሆነ ቆጠራ ጀምር
    if (game.status === 'idle') {
        const boardsSnap = await db.ref('reserved_boards').get();
        if (boardsSnap.exists()) {
            startWaitingTimer();
        }
    }
});

// --- 2. ቆጠራ መጀመሪያ (30 Seconds Timer) ---
function startWaitingTimer() {
    if (timerInterval) return; 

    db.ref('game').update({ status: 'waiting', isTimerRunning: true, timer: 30 });
    let sec = 30;

    timerInterval = setInterval(async () => {
        sec--;
        await db.ref('game/timer').set(sec);

        if (sec <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            startDrawingNumbers();
        }
    }, 1000);
}

// --- 3. ኳስ ማውጣት (Drawing Logic) ---
async function startDrawingNumbers() {
    await db.ref('game').update({ status: 'active', isTimerRunning: false, drawn: [] });
    let drawn = [];

    if (drawingInterval) clearInterval(drawingInterval);

    drawingInterval = setInterval(async () => {
        const gameSnap = await db.ref('game').get();
        const g = gameSnap.val();

        if (!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(drawingInterval);
            drawingInterval = null;
            return;
        }

        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(n));
        drawn.push(n);
        await db.ref('game/drawn').set(drawn);
    }, 4000); 
}

// --- 4. የአሸናፊ ክፍያ (Payment Transaction) ---
async function processWinner(game) {
    await db.ref('game/isResetting').set(true);
    const winnerId = game.winner.id;
    const betPrice = game.currentBetPrice || 0;
    
    const boardsSnap = await db.ref('reserved_boards').get();
    const playersCount = boardsSnap.numChildren();
    
    const totalPool = playersCount * betPrice;
    const winnerPay = totalPool * 0.8;
    const adminPay = totalPool * 0.2;

    try {
        // ለአሸናፊው
        await db.ref(`users/${winnerId}/bal`).transaction(c => (c || 0) + winnerPay);
        // ለዳኛው
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminPay);
        
        await db.ref('history/' + winnerId).push({
            type: "ቢንጎ ድል 🏆", amt: winnerPay, status: "ተከፍሏል", date: new Date().toLocaleString()
        });

        console.log(`ክፍያ ተፈጽሟል ለ፡ ${game.winner.name}`);
    } catch (e) { console.error("ክፍያ ተቋርጧል", e); }

    // ከ 5 ሰከንድ በኋላ ጨዋታውን Reset አድርግ
    setTimeout(async () => {
        await db.ref('reserved_boards').remove();
        await db.ref('game').set({
            drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0
        });
    }, 5000);
}

// --- 5. ተጫዋች ከሌለ Reset የማድረግ Logic ---
db.ref('online_players').on('value', (snapshot) => {
    if (snapshot.numChildren() === 0) {
        setTimeout(async () => {
            const s = await db.ref('online_players').get();
            if(!s.exists()) {
                clearInterval(timerInterval); clearInterval(drawingInterval);
                timerInterval = null; drawingInterval = null;
                await db.ref('game').update({ status: 'idle', timer: -1, isTimerRunning: false });
                await db.ref('reserved_boards').remove();
            }
        }, 5000);
    }
});
