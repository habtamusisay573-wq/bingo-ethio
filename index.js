const admin = require('firebase-admin');
const http = require('http');

// ሰርቨር እንዳይዘጋ
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

// --- አዲስ የተጨመረ፡ ተጫዋች ከሌለ በ 1 ሰከንድ ውስጥ ሪሴት የማድረግ LOGIC ---
db.ref('online_players').on('value', async (snapshot) => {
    const playerCount = snapshot.numChildren();
    
    // ተጫዋች ከሌለ (0 ከሆነ) ወዲያውኑ ሁሉንም ነገር ያጸዳል
    if (playerCount === 0) {
        console.log("No players online. Resetting system in 1 second...");
        setTimeout(async () => {
            await db.ref('reserved_boards').remove();
            await db.ref('game').set({
                drawn: [], 
                status: 'idle', 
                winner: null, 
                isResetting: false, 
                timer: -1, 
                currentBetPrice: 0,
                isTimerRunning: false
            });
            console.log("System Auto-Reset Complete.");
        }, 1000); // 1 ሰከንድ ቆይታ
    }
});

// --- አድሚኑ ራሱ እንዲያጸዳ (Global Reset Command) ---
db.ref('admin_commands/global_reset').on('value', async (snap) => {
    if(!snap.val()) return;
    await db.ref('game').set({ drawn: [], status: 'idle', winner: null, timer: -1, currentBetPrice: 0 });
    await db.ref('reserved_boards').remove();
    await db.ref('requests').remove();
    await db.ref('admin_commands/global_reset').remove();
});

// --- የጨዋታው ዋና ተግባራት (ክፍያ እና ታሪክ መመዝገብ) ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;

    // አሸናፊ ሲኖር ክፍያ መፈጸም እና ታሪክ መመዝገብ
    if(game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        const winnerId = game.winner.id;
        const boardsSnap = await db.ref('reserved_boards').get();
        const betPrice = game.currentBetPrice || 0;
        const totalPool = boardsSnap.numChildren() * betPrice;
        
        const winnerPay = totalPool * 0.8;
        const adminPay = totalPool * 0.2;

        try {
            // የአሸናፊውን ባላንስ መጨመር
            await db.ref(`users/${winnerId}/bal`).transaction(c => (c || 0) + winnerPay);
            // የአሸናፊውን ታሪክ መመዝገብ
            await db.ref(`history/${winnerId}`).push({
                type: "ቢንጎ ድል 🏆", 
                amt: winnerPay, 
                info: `ከ ${boardsSnap.numChildren()} ተጫዋቾች የተገኘ ድል`, 
                date: new Date().toLocaleString()
            });
            // የአድሚን ኮሚሽን መጨመር
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminPay);
        } catch (e) { console.error("Payment error:", e); }

        setTimeout(async () => {
            await db.ref('reserved_boards').remove();
            await db.ref('game').set({ drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0 });
        }, 5000);
    }

    // የጨዋታ ቆጠራ (Timer)
    if(game.status === 'waiting' && !game.isTimerRunning) {
        runTimer();
    }
});

function runTimer() {
    db.ref('game/isTimerRunning').set(true);
    let sec = 30;
    const interval = setInterval(async () => {
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
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(interval);
            return;
        }
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        db.ref('game/drawn').set(drawn);
    }, 4000);
}
