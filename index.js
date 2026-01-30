const admin = require('firebase-admin');
const express = require('express'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. የFirebase ቅንብር ---
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
    const sender = req.body.from || "";

    console.log("አዲስ ኤስኤምኤስ ደርሷል:", message);

    const txIdMatch = message.match(/[A-Z0-9]{10,12}/i); 
    const txId = txIdMatch ? txIdMatch[0].toUpperCase() : null;

    const amountMatch = message.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i) || message.match(/ብር\s?(\d+(?:\.\d+)?)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

    const playerPhoneMatch = message.match(/(?:\+251|0)(9\d{8}|7\d{8})/);
    let playerPhone = null;
    if (playerPhoneMatch) { playerPhone = '0' + playerPhoneMatch[1]; }

    if (txId && amount >= MIN_DEPOSIT) {
        try {
            await db.ref(`pending_payments/${txId}`).set({
                amount: amount,
                sender_phone: playerPhone,
                status: "received",
                timestamp: Date.now()
            });

            if (playerPhone) {
                const userSnap = await db.ref('users').orderByChild('phone').equalTo(playerPhone).once('value');
                if (userSnap.exists()) {
                    const userId = Object.keys(userSnap.val())[0];
                    const txCheck = await db.ref(`used_transactions/${txId}`).once('value');
                    if (!txCheck.exists()) {
                        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + amount);
                        await db.ref(`used_transactions/${txId}`).set({ 
                            userId, amount, date: new Date().toLocaleString() 
                        });
                        console.log(`በተሳካ ሁኔታ ${amount} ብር ለ ${playerPhone} ተጨምሯል`);
                    }
                }
            }
        } catch (e) { console.error("Webhook Error:", e); }
    }
    res.status(200).send("OK");
});

// --- 3. የክፍያ ማረጋገጫ (Confirm Payment) ---
app.post('/confirm-payment', async (req, res) => {
    const { phone, txId } = req.body;
    try {
        const used = await db.ref(`used_transactions/${txId}`).get();
        if (used.exists()) return res.status(400).json({ msg: "ይህ ቁጥር አስቀድሞ ጥቅም ላይ ውሏል!" });

        const pending = await db.ref(`pending_payments/${txId}`).get();
        if (!pending.exists()) return res.status(404).json({ msg: "የቴሌብር መልእክቱ ገና አልደረሰም፤ እባክዎ ጥቂት ሰከንድ ይጠብቁ።" });

        const actualAmount = pending.val().amount;
        const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋቹ አልተገኘም!" });

        const userId = Object.keys(userSnap.val())[0];
        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + actualAmount);
        await db.ref(`used_transactions/${txId}`).set({ userId, amount: actualAmount, date: new Date().toLocaleString() });

        res.status(200).json({ msg: `በተሳካ ሁኔታ ${actualAmount} ብር ተጨምሯል!` });
    } catch (e) { res.status(500).json({ msg: "Server Error" }); }
});

// --- 4. የዊዝድሮው ጥያቄ ---
app.post('/request-withdraw', async (req, res) => {
    const { userId, amount, phone } = req.body;
    const withdrawAmt = parseFloat(amount);
    try {
        const userSnap = await db.ref(`users/${userId}`).get();
        const currentBal = userSnap.val().bal || 0;
        if (withdrawAmt > currentBal || withdrawAmt < MIN_WITHDRAW) return res.status(400).json({ msg: "ስህተት፡ መጠኑን ወይም ባላንስዎን ያረጋግጡ" });

        const reqId = Date.now();
        await db.ref(`requests/${reqId}`).set({
            uid: userId, name: userSnap.val().first_name, type: 'WIT', amt: withdrawAmt, info: phone, status: 'Pending'
        });
        res.status(200).json({ msg: "የማውጫ ጥያቄ ተልኳል" });
    } catch (e) { res.status(500).send("Server Error"); }
});

// --- 5. የጃክፖት ስሌት (Real-time) ---
db.ref('reserved_boards').on('value', async (snapshot) => {
    const boards = snapshot.val();
    if (!boards) { await db.ref('game/jackpot').set(0); return; }
    let totalPool = 0;
    Object.values(boards).forEach(board => {
        totalPool += (parseFloat(board.bet || board.betAmount) || 0);
    });
    await db.ref('game/jackpot').set(totalPool * 0.8);
});

// --- 6. የጨዋታው ሎጂክ (Winner & Reset) ---
let drawingInterval = null; 
let timerInterval = null;

db.ref('game/winner').on('value', async (snap) => {
    const winner = snap.val();
    if (winner && !winner.processed) {
        if (drawingInterval) { clearInterval(drawingInterval); drawingInterval = null; }
        try {
            const jackpotSnap = await db.ref('game/jackpot').get();
            const winnerPay = jackpotSnap.val() || 0;
            const adminPay = winnerPay > 0 ? (winnerPay / 0.8) * 0.2 : 0;

            if (winnerPay > 0) {
                await db.ref(`users/${winner.id}/bal`).transaction(c => (c || 0) + winnerPay);
                await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminPay);
                await db.ref(`history/${winner.id}`).push({
                    type: "የቢንጎ ድል 🏆", amt: winnerPay, date: new Date().toLocaleString()
                });
            }
            await db.ref('game/winner/processed').set(true);
        } catch (e) { console.error("Payment Error:", e); }
        setTimeout(() => resetFullGame("Win Reset"), 3000); 
    }
});

async function resetFullGame(reason) {
    await db.ref('reserved_boards').remove();
    await db.ref('game').update({
        drawn: [], status: 'idle', winner: null, timer: -1, currentBetPrice: 0, isTimerRunning: false, jackpot: 0
    });
}

function startDrawingNumbers(existingDrawn) {
    let drawn = existingDrawn;
    if (drawingInterval) clearInterval(drawingInterval);
    drawingInterval = setInterval(async () => {
        const g = (await db.ref('game').get()).val();
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(drawingInterval); drawingInterval = null; return;
        }
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        await db.ref('game/drawn').set(drawn);
    }, 2000);
}

// ሰርቨር ማስነሻ
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bingo Server Live on ${PORT}`));
