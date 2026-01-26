const admin = require('firebase-admin');
const express = require('express'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : "",
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://dagi-bingo-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const ADMIN_ID = "8431270634";

// የገደብ መጠኖች
const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;
const MAX_WITHDRAW = 5000;

// --- 2. የቴሌብር SMS መቀበያ (Webhook) ---
app.post('/sms-webhook', async (req, res) => {
    const message = req.body.text || req.body.message || "";
    const tidMatch = message.match(/[A-Z0-9]{10,12}/);
    const amtMatch = message.match(/(?:ብር|ETB|amount)\s*([\d,.]+)/i);

    if (tidMatch && amtMatch) {
        const tid = tidMatch[0];
        const amt = parseFloat(amtMatch[1].replace(/,/g, ''));
        const pendingRef = db.ref('pending_deposits/' + tid);
        const s = await pendingRef.get();

        if (s.exists() && !s.val().used) {
            const uid = s.val().uid;
            await db.ref('users/' + uid + '/bal').transaction(c => (c || 0) + amt);
            await pendingRef.update({ used: true, confirmedAt: Date.now() });
            console.log(`Deposit Confirmed: ${amt} for ${uid}`);
        }
    }
    res.sendStatus(200);
});

let timerInterval = null;
let drawingInterval = null;

// --- ጌም Listener (ክፍያና ሪሴት) ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if (!game) return;

    if (game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        if (drawingInterval) clearInterval(drawingInterval);

        const winnerId = game.winner.id;
        const betPrice = game.currentBetPrice || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        const totalPool = playersCount * betPrice;

        await db.ref(`users/${winnerId}/bal`).transaction(c => (c || 0) + (totalPool * 0.8));
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + (totalPool * 0.2));

        setTimeout(async () => {
            await db.ref('reserved_boards').remove();
            await db.ref('game').set({
                drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0
            });
        }, 5000);
    }

    if(game.status === 'waiting' && !game.isTimerRunning) {
        runTimer();
    }
});

function runTimer() {
    if (timerInterval) clearInterval(timerInterval);
    db.ref('game').update({ isTimerRunning: true });
    let sec = 30;
    timerInterval = setInterval(() => {
        sec--;
        db.ref('game/timer').set(sec);
        if(sec <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            db.ref('game').update({ status: 'active', isTimerRunning: false });
            startDrawingNumbers([]);
        }
    }, 1000);
}

// ዳጊ፥ እዚህ ጋር ነው በየ 2 ሰከንድ ያደረግኩት!
function startDrawingNumbers(existingDrawn) {
    let drawn = existingDrawn;
    if (drawingInterval) clearInterval(drawingInterval);
    drawingInterval = setInterval(async () => {
        const g = (await db.ref('game').get()).val();
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(drawingInterval);
            drawingInterval = null;
            return;
        }
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        db.ref('game/drawn').set(drawn);
    }, 2000); 
}

app.listen(process.env.PORT || 3000, () => console.log("Server Running..."));
