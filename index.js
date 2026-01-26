const admin = require('firebase-admin');
const http = require('http');
const express = require('express'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. የFirebase ቅንብር ---
const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  // በ Render ላይ \n በትክክል እንዲነበብ የተደረገ ማስተካከያ
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

// --- አዲስ፡ ደህንነቱ የተጠበቀ የካርቴላ መግዣ (Secure Board Buy) ---
app.post('/buy-board', async (req, res) => {
    const { userId, boardId, betAmount } = req.body;
    try {
        const userRef = db.ref(`users/${userId}`);
        const userSnap = await userRef.get();
        if (!userSnap.exists()) return res.status(404).send("ተጫዋች አልተገኘም");

        const currentBal = userSnap.val().bal || 0;
        if (currentBal < betAmount) return res.status(400).send("በቂ ባላንስ የለም");

        // ብር መቀነስ እና ካርቴላ መያዝ በአንድ ጊዜ (Atomic Transaction)
        await userRef.child('bal').transaction(c => (c || 0) - betAmount);
        await db.ref(`reserved_boards/${boardId}`).set({ userId, betAmount });
        
        // ጌሙ ገና ካልጀመረ ወደ መጠባበቂያ መቀየር
        const gameRef = db.ref('game');
        const gSnap = await gameRef.get();
        if(gSnap.val().status === 'idle') {
            await gameRef.update({ status: 'waiting', timer: 30, currentBetPrice: betAmount });
        }

        res.status(200).json({ msg: "Success" });
    } catch (e) { res.status(500).send(e.message); }
});

// --- አዲስ፡ ደህንነቱ የተጠበቀ የአሸናፊ መመዝገቢያ (Secure Bingo Claim) ---
app.post('/claim-bingo', async (req, res) => {
    const { userId, userName, betAmount } = req.body;
    try {
        const gameSnap = await db.ref('game').get();
        const game = gameSnap.val();
        
        if (game.winner) return res.status(400).send("አሸናፊ ተገኝቷል");
        if (game.status !== 'active') return res.status(400).send("ጌሙ ገና አልተጀመረም");

        // አሸናፊውን መመዝገብ
        await db.ref('game/winner').set({ id: userId, name: userName, bet: betAmount });
        res.status(200).json({ msg: "Bingo Confirmed!" });
    } catch (e) { res.status(500).send(e.message); }
});

// --- 2. የጨዋታው ራስ-ሰር ሪሴት ሎጂክ ---
let resetTimeout = null;
db.ref('online_players').on('value', (snapshot) => {
    const playerCount = snapshot.numChildren();
    if (playerCount === 0) {
        if (!resetTimeout) {
            resetTimeout = setTimeout(async () => {
                const gameSnap = await db.ref('game').get();
                const gameData = gameSnap.val();
                if (gameData && gameData.status !== 'idle') {
                    await db.ref('reserved_boards').remove();
                    await db.ref('game').update({
                        drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0, isTimerRunning: false
                    });
                }
                resetTimeout = null;
            }, 2000);
        }
    } else { if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; } }
});

// --- 3. የቴሌብር SMS Webhook ---
const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;
const MAX_WITHDRAW = 5000;

app.post('/sms-webhook', async (req, res) => {
    const message = req.body.text || req.body.message || "";
    const txIdMatch = message.match(/[A-Z0-9]{10,12}/i);
    const txId = txIdMatch ? txIdMatch[0].toUpperCase() : null;
    const amountMatch = message.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i) || message.match(/ብር\s?(\d+(?:\.\d+)?)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
    const playerPhoneMatch = message.match(/(?:\+251|0)(9\d{8}|7\d{8})/);
    let playerPhone = playerPhoneMatch ? '0' + playerPhoneMatch[1] : null;

    if (txId && amount >= MIN_DEPOSIT) {
        try {
            await db.ref(`pending_payments/${txId}`).set({ amount, sender_phone: playerPhone, status: "received", timestamp: Date.now() });
            if (playerPhone) {
                const userSnap = await db.ref('users').orderByChild('phone').equalTo(playerPhone).once('value');
                if (userSnap.exists()) {
                    const userId = Object.keys(userSnap.val())[0];
                    const txCheck = await db.ref(`used_transactions/${txId}`).once('value');
                    if (!txCheck.exists()) {
                        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + amount);
                        await db.ref(`used_transactions/${txId}`).set({ userId, amount, date: new Date().toLocaleString() });
                    }
                }
            }
        } catch (e) { console.error(e); }
    }
    res.status(200).send("OK");
});

// --- 4. የክፍያ ማረጋገጫ (Deposit) ---
app.post('/confirm-payment', async (req, res) => {
    const { phone, txId } = req.body;
    try {
        const used = await db.ref(`used_transactions/${txId}`).get();
        if (used.exists()) return res.status(400).json({ msg: "ጥቅም ላይ ውሏል!" });
        const pending = await db.ref(`pending_payments/${txId}`).get();
        if (!pending.exists()) return res.status(404).json({ msg: "መልእክቱ አልደረሰም" });
        const actualAmount = pending.val().amount;
        const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
        const userId = Object.keys(userSnap.val())[0];
        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + actualAmount);
        await db.ref(`used_transactions/${txId}`).set({ userId, amount: actualAmount, date: new Date().toLocaleString() });
        res.status(200).json({ msg: "ተጨምሯል!" });
    } catch (e) { res.status(500).send("Error"); }
});

// --- 5. የጨዋታ አሰራር እና አሸናፊ ክፍያ ---
let drawingInterval = null;
let timerInterval = null;

db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;
    if(game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        if (drawingInterval) { clearInterval(drawingInterval); drawingInterval = null; }
        const winnerId = game.winner.id;
        const betPrice = game.currentBetPrice || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        const totalPool = playersCount * betPrice;
        // 80% ለአሸናፊው፣ 20% ለአድሚኑ
        await db.ref(`users/${winnerId}/bal`).transaction(curr => (curr || 0) + (totalPool * 0.8));
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + (totalPool * 0.2));
        setTimeout(() => {
            db.ref('reserved_boards').remove();
            db.ref('game').set({ drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0 });
        }, 5000);
    }
    if(game.status === 'waiting' && !game.isTimerRunning) runTimer();
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bingo Server is running on port ${PORT}...`));
