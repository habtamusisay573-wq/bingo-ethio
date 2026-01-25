const admin = require('firebase-admin');
const http = require('http');
const express = require('express'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 0. Firebase Initialization (መጀመሪያ መሆን ያለበት) ---
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
const ADMIN_ID = 8431270634; // ወደ Number ተቀይሯል

// --- የገደብ መጠኖች (Limits) ---
const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;
const MAX_WITHDRAW = 5000;

let timerInterval = null;
let drawingInterval = null;

// --- 1. የቴሌብር SMS መቀበያ (Webhook) ---
app.post('/sms-webhook', async (req, res) => {
    const message = req.body.text || "";
    const sender = req.body.from || "";

    if (sender.includes("telebirr") || message.includes("ብር") || message.includes("ETB")) {
        const txIdMatch = message.match(/[A-Z0-9]{10,12}/i); 
        const txId = txIdMatch ? txIdMatch[0] : null;
        const amountMatch = message.match(/(\d+(?:\.\d+)?)\s?ETB/i) || message.match(/ብር\s?(\d+(?:\.\d+)?)/);
        const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
        const playerPhoneMatch = message.match(/(09\d{8}|07\d{8})/);
        const playerPhone = playerPhoneMatch ? playerPhoneMatch[0] : null;

        if (txId && amount >= MIN_DEPOSIT) {
            try {
                await db.ref(`pending_payments/${txId}`).set({
                    amount, sender_phone: playerPhone, status: "received", timestamp: Date.now()
                });
                if (playerPhone) {
                    const userSnap = await db.ref('users').orderByChild('phone').equalTo(playerPhone).once('value');
                    if (userSnap.exists()) {
                        const userId = Object.keys(userSnap.val())[0];
                        const txCheck = await db.ref(`used_transactions/${txId}`).get();
                        if (!txCheck.exists()) {
                            await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + amount);
                            await db.ref(`used_transactions/${txId}`).set({ userId, amount, date: new Date().toLocaleString() });
                        }
                    }
                }
            } catch (e) { console.error("SMS Error", e); }
        }
    }
    res.status(200).json({ status: "success" });
});

// --- 2. Confirm Payment ---
app.post('/confirm-payment', async (req, res) => {
    const { phone, txId } = req.body;
    try {
        const used = await db.ref(`used_transactions/${txId}`).get();
        if (used.exists()) return res.status(400).json({ msg: "ጥቅም ላይ ውሏል!" });
        const pending = await db.ref(`pending_payments/${txId}`).get();
        if (!pending.exists()) return res.status(404).json({ msg: "መልእክቱ አልደረሰም!" });
        
        const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋች የለም!" });

        const userId = Object.keys(userSnap.val())[0];
        const amt = pending.val().amount;
        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + amt);
        await db.ref(`used_transactions/${txId}`).set({ userId, amount: amt, date: new Date().toLocaleString() });
        res.status(200).json({ msg: "ተሳክቷል!" });
    } catch (e) { res.status(500).json({ msg: "Error" }); }
});

// --- 3. Withdraw Request ---
app.post('/request-withdraw', async (req, res) => {
    const { userId, amount, phone } = req.body;
    const withdrawAmt = parseFloat(amount);
    try {
        const userSnap = await db.ref(`users/${userId}`).get();
        const currentBal = userSnap.val().bal || 0;
        if (withdrawAmt > currentBal || withdrawAmt < MIN_WITHDRAW || withdrawAmt > MAX_WITHDRAW) 
            return res.status(400).json({ msg: "ስህተት!" });

        const reqId = Date.now();
        await db.ref(`requests/${reqId}`).set({
            uid: userId, name: userSnap.val().first_name, type: 'WIT', amt: withdrawAmt, info: phone, status: 'Pending'
        });
        res.status(200).json({ msg: "ተልኳል!" });
    } catch (e) { res.status(500).json({ msg: "Error" }); }
});

// --- Game Logic ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;
    if(game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        const boardsSnap = await db.ref('reserved_boards').get();
        const totalPool = boardsSnap.numChildren() * (game.currentBetPrice || 0);
        await db.ref(`users/${game.winner.id}/bal`).transaction(c => (c || 0) + (totalPool * 0.8));
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + (totalPool * 0.2));
        setTimeout(() => {
            db.ref('reserved_boards').remove();
            db.ref('game').set({ drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0 });
        }, 5000);
    }
    if(game.status === 'waiting' && !game.isTimerRunning) runTimer();
});

function runTimer() {
    db.ref('game/isTimerRunning').set(true);
    let sec = 30;
    timerInterval = setInterval(() => {
        sec--; db.ref('game/timer').set(sec);
        if(sec <= 0) {
            clearInterval(timerInterval);
            db.ref('game').update({ status: 'active', isTimerRunning: false });
            startDrawingNumbers([]);
        }
    }, 1000);
}

function startDrawingNumbers(drawn) {
    drawingInterval = setInterval(async () => {
        const g = (await db.ref('game').get()).val();
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) return clearInterval(drawingInterval);
        let n; do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n); db.ref('game/drawn').set(drawn);
    }, 2000);
}

app.listen(process.env.PORT || 3000);
