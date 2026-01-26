const admin = require('firebase-admin');
const express = require('express'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. የFirebase ቅንብር (Environment Variables መጠቀም ለደህንነት ይመረጣል) ---
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
const ADMIN_ID = "8431270634"; // የዳኛው Telegram ID

// የገደብ መጠኖች
const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;
const MAX_WITHDRAW = 5000;

let drawingInterval = null; 
let timerInterval = null;
let resetTimeout = null;

// --- 2. የቴሌብር SMS መቀበያ (Webhook) ---
// የቴሌብር SMS ወደዚህ Endpoint ሲመጣ ባላንስ በራሱ ይጨምራል
app.post('/sms-webhook', async (req, res) => {
    const message = req.body.text || req.body.message || "";
    console.log("አዲስ ኤስኤምኤስ ደርሷል:", message);

    const txIdMatch = message.match(/[A-Z0-9]{10,12}/i); 
    const txId = txIdMatch ? txIdMatch[0].toUpperCase() : null;
    const amountMatch = message.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i) || message.match(/ብር\s?(\d+(?:\.\d+)?)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
    const playerPhoneMatch = message.match(/(?:\+251|0)(9\d{8}|7\d{8})/);
    let playerPhone = playerPhoneMatch ? '0' + playerPhoneMatch[1] : null;

    if (txId && amount >= MIN_DEPOSIT) {
        try {
            // ገና ያልተመዘገቡ ክፍያዎችን ለጊዜው እዚህ እናስቀምጣለን
            await db.ref(`pending_payments/${txId}`).set({
                amount: amount, sender_phone: playerPhone, status: "received", timestamp: Date.now()
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
                        console.log(`ባላንስ ተጨምሯል ለ: ${playerPhone}, መጠን: ${amount}`);
                    }
                }
            }
        } catch (e) { console.error("Webhook Error:", e); }
    }
    res.status(200).send("OK");
});

// --- 3. የክፍያ ማረጋገጫ (ከ App ለሚመጣ ጥያቄ) ---
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
    } catch (e) { res.status(500).json({ msg: "የሰርቨር ስህተት" }); }
});

// --- 4. AUTO-RESET (ተጫዋች ከሌለ በ2 ሰከንድ ውስጥ ሪሴት የሚያደርግ) ---
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
                    console.log("ማንም ተጫዋች ስለሌለ ጌሙ ሪሴት ሆኗል።");
                }
                resetTimeout = null;
            }, 2000);
        }
    } else {
        if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    }
});

// --- 5. የጨዋታው ዋና ሎጂክ ---
db.ref('game').on('value', async (snap) => {
    const game = snap.val();
    if(!game) return;

    // አሸናፊ ሲኖር
    if(game.winner && !game.isResetting) {
        await db.ref('game/isResetting').set(true);
        if (drawingInterval) { clearInterval(drawingInterval); drawingInterval = null; }

        const winnerId = game.winner.id;
        const betPrice = game.currentBetPrice || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        const totalPool = playersCount * betPrice;

        // የክፍያ ስርጭት (80% ለአሸናፊው፣ 20% ለዳኛው)
        await db.ref(`users/${winnerId}/bal`).transaction(curr => (curr || 0) + (totalPool * 0.8));
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + (totalPool * 0.2));

        // ከ5 ሰከንድ በኋላ ሪሴት
        setTimeout(() => {
            db.ref('reserved_boards').remove();
            db.ref('game').set({ drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0 });
        }, 5000);
    }

    // መጠባበቂያ ጊዜ (Waiting)
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
            startDrawingNumbers();
        }
    }, 1000);
}

function startDrawingNumbers() {
    let drawn = [];
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
    }, 3000); // በየ 3 ሰከንዱ ቁጥር ያወጣል
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bingo Server is running on port ${PORT}...`));
