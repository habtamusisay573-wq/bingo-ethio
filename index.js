const admin = require('firebase-admin');
const http = require('http');
const express = require('express'); 
const cors = require('cors'); 
const app = express(); 

// --- 1. የግንኙነት ፈቃድ (CORS) ---
app.use(cors()); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 2. የFirebase ቅንብር ---
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

const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;
const MAX_WITHDRAW = 5000;

let drawingInterval = null; 
let timerInterval = null;
let resetTimeout = null;

// --- 3. ሰርቨሩ እንዳይተኛ (Keep-Awake 3 ሰከንድ) ---
setInterval(() => {
  const url = `http://localhost:${process.env.PORT || 3000}`;
  http.get(url, (res) => {}).on('error', (e) => {});
}, 3000);

// --- 4. Online Players Tracking (ተጫዋች ሲገባ ይህ ይጠራል) ---
app.post('/user-online', async (req, res) => {
    const { userId, userName } = req.body;
    if (!userId) return res.sendStatus(400);
    const userRef = db.ref(`online_players/${userId}`);
    await userRef.set({ name: userName, status: "online", lastSeen: Date.now() });
    userRef.onDisconnect().remove(); // ተጫዋቹ ሲወጣ በራሱ እንዲጠፋ
    res.status(200).send("Online");
});

// --- 5. ፈጣን ሪሴት ሎጂክ (በ 2 ሰከንድ) ---
db.ref('online_players').on('value', (snapshot) => {
    const playerCount = snapshot.numChildren();
    if (playerCount === 0) {
        if (!resetTimeout) {
            resetTimeout = setTimeout(async () => {
                const gameSnap = await db.ref('game').get();
                const gameData = gameSnap.val();
                if (gameData && gameData.status !== 'idle') {
                    if (drawingInterval) clearInterval(drawingInterval);
                    await db.ref('reserved_boards').remove();
                    await db.ref('game').update({
                        drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0, isTimerRunning: false
                    });
                    console.log("Auto-reset: 2 seconds reached.");
                }
                resetTimeout = null;
            }, 2000); // ወደ 2 ሰከንድ ዝቅ ብሏል
        }
    } else {
        if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    }
});

// --- 6. ካርቴላ መግዣ ---
app.post('/buy-board', async (req, res) => {
    const { userId, boardId, betAmount } = req.body;
    try {
        const userRef = db.ref(`users/${userId}`);
        const userSnap = await userRef.get();
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋች አልተገኘም" });

        const currentBal = userSnap.val().bal || 0;
        if (currentBal < betAmount) return res.status(400).json({ msg: "በቂ ባላንስ የለም" });

        await userRef.child('bal').transaction(c => (c || 0) - betAmount);
        await db.ref(`reserved_boards/${boardId}`).set({ userId, betAmount });
        
        const gameRef = db.ref('game');
        const gSnap = await gameRef.get();
        if(gSnap.val().status === 'idle') {
            await gameRef.update({ status: 'waiting', timer: 30, currentBetPrice: betAmount });
        }
        res.status(200).json({ msg: "Success" });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// --- 7. ቢንጎ ሲባል ወዲያው እንዲቆም (Claim Bingo) ---
app.post('/claim-bingo', async (req, res) => {
    const { userId, userName, betAmount } = req.body;
    try {
        const gameSnap = await db.ref('game').get();
        if (gameSnap.val().winner) return res.status(400).json({ msg: "አሸናፊ ተገኝቷል" });

        // ቁጥር መጥራቱን ወዲያውኑ ያቆማል
        if (drawingInterval) { clearInterval(drawingInterval); drawingInterval = null; }

        await db.ref('game/winner').set({ id: userId, name: userName, bet: betAmount });
        res.status(200).json({ msg: "Bingo Confirmed!" });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// --- 8. የቴሌብር SMS Webhook ---
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
        } catch (e) { console.error(e); }
    }
    res.status(200).send("OK");
});

// --- 9. የክፍያ ማረጋገጫ ---
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
    } catch (e) { res.status(500).json({ msg: "Error" }); }
});

// --- 10. የዊዝድሮው ጥያቄ ---
app.post('/request-withdraw', async (req, res) => {
    const { userId, amount, phone } = req.body;
    const withdrawAmt = parseFloat(amount);
    try {
        const userSnap = await db.ref(`users/${userId}`).get();
        const currentBal = userSnap.val().bal || 0;
        if (withdrawAmt > currentBal || withdrawAmt < MIN_WITHDRAW) return res.status(400).json({ msg: "ስህተት" });
        const reqId = Date.now();
        await db.ref(`requests/${reqId}`).set({
            uid: userId, name: userSnap.val().first_name, type: 'WIT', amt: withdrawAmt, info: phone, status: 'Pending'
        });
        res.status(200).json({ msg: "ተልኳል" });
    } catch (e) { res.status(500).send("Error"); }
});

// --- 11. የጨዋታ አሰራር (Winner & 2s Reset) ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;
    if(game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        if (drawingInterval) { clearInterval(drawingInterval); drawingInterval = null; }
        
        const winnerId = game.winner.id;
        const betPrice = game.currentBetPrice || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const totalPool = boardsSnap.numChildren() * betPrice;
        
        await db.ref(`users/${winnerId}/bal`).transaction(curr => (curr || 0) + (totalPool * 0.8));
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + (totalPool * 0.2));
        
        setTimeout(async () => {
            await db.ref('reserved_boards').remove();
            await db.ref('game').set({ drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0 });
        }, 2000); 
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
app.listen(PORT, () => console.log(`Server live on ${PORT}`));
