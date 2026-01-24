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

// --- አዲስ የተጨመረ፡ ተጫዋች ሲወጣ 3 ሰከንድ ጠብቆ RESET የማድረግ Logic ---
let resetTimeout = null;

db.ref('online_players').on('value', (snapshot) => {
    const playerCount = snapshot.numChildren();
    
    // Admin (ዳኛው) ብቻውን ከሆነ ወይም ማንም ከሌለ ቆጠራ ይጀምራል
    if (playerCount === 0) {
        if (resetTimeout) clearTimeout(resetTimeout);
        
        resetTimeout = setTimeout(async () => {
            const gameSnap = await db.ref('game').get();
            const gameData = gameSnap.val();
            
            if (gameData && gameData.status !== 'idle') {
                await db.ref('reserved_boards').remove();
                await db.ref('game').update({
                    drawn: [],
                    status: 'idle',
                    winner: null,
                    isResetting: false,
                    timer: -1,
                    currentBetPrice: 0,
                    isTimerRunning: false
                });
                console.log("ሁሉም ተጫዋቾች ስለወጡ ሲስተሙ Reset ሆኗል።");
            }
        }, 3000); // 3 ሰከንድ
    } else {
        // ተጫዋች ከተመለሰ Reset እንዳይሆን ቆጠራውን ያቋርጣል
        if (resetTimeout) {
            clearTimeout(resetTimeout);
            resetTimeout = null;
        }
    }
});

// --- GLOBAL VARIABLES FOR INTERVALS ---
// መስተካከል ያለበት: Interval Variableን Global ማድረግ አለብን (To avoid multiple loops)
let drawingInterval = null; 
let timerInterval = null;

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

    // 1. አሸናፊ ሲኖር ክፍያ እና Log
    if(game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        
        // አሸናፊ ሲገኝ ድሮው መቆም አለበት
        if (drawingInterval) { clearInterval(drawingInterval); drawingInterval = null; }

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
                type: "የቢንጎ ድል 🏆", amt: winnerPay, info: "80% የአሸናፊ ድርሻ", date: new Date().toLocaleString()
            });

            await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + adminPay);
            
            await db.ref('admin_logs').push({
                winner: game.winner.name, total: totalPool, adminShare: adminPay, date: new Date().toLocaleString()
            });

            console.log(`Payment Complete: Winner received ${winnerPay}`);
        } catch (e) { console.error("Payment Failed", e); }

        setTimeout(() => {
            db.ref('reserved_boards').remove();
            db.ref('game').set({
                drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0
            });
        }, 5000);
    }

    // 2. Timer ማስጀመር
    if(game.status === 'waiting' && !game.isTimerRunning) {
        runTimer();
    }
});

function runTimer() {
    // መስተካከል ያለበት: ድሮውንም Timer እየሰራ ከሆነ ድጋሚ እንዳይጀምር መከላከል
    if (timerInterval) clearInterval(timerInterval);

    db.ref('game').update({ isTimerRunning: true });
    let sec = 30;
    
    // const interval = setInterval(() => { ... } 
    // ከላይ ያለውን comment አድርገን ወደ variable እንቀይረዋለን
    timerInterval = setInterval(() => {
        sec--;
        db.ref('game/timer').set(sec);
        if(sec <= 0) {
            // clearInterval(interval);
            clearInterval(timerInterval); // Use global variable
            timerInterval = null;
            
            db.ref('game').update({ status: 'active', isTimerRunning: false });
            startDrawingNumbers([]);
        }
    }, 1000);
}

function startDrawingNumbers(existingDrawn) {
    let drawn = existingDrawn;
    
    // መስተካከል ያለበት: ድሮውንም እየሰራ ከሆነ መጀመሪያ ማጥፋት (Clear Interval)
    if (drawingInterval) clearInterval(drawingInterval);

    // const interval = setInterval(async () => { 
    // ከላይ ያለውን Comment አድርገን ወደ global variable እንቀይረዋለን
    drawingInterval = setInterval(async () => {
        const g = (await db.ref('game').get()).val();
        
        // if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
        //     clearInterval(interval);
        //     return;
        // }
        
        // Corrected Loop Exit Logic
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(drawingInterval);
            drawingInterval = null;
            return;
        }

        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        db.ref('game/drawn').set(drawn);
    }, 4000);
}
