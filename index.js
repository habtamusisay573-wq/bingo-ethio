const admin = require('firebase-admin');
const express = require('express'); 
const https = require('https'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. Firebase Admin ቅንብር ---
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

// --- 2. ሰርቨሩ እንዳይተኛ (Keep-Alive) ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/`, (res) => {
            console.log("Keep-alive: Active ✅");
        }).on('error', (e) => console.log("Ping error skipped."));
    }
}, 5 * 60 * 1000); 

// --- 3. የቴሌብር SMS Webhook ---
app.post('/sms-webhook', async (req, res) => {
    const message = req.body.text || req.body.message || "";
    const txIdMatch = message.match(/[A-Z0-9]{10,12}/i); 
    const txId = txIdMatch ? txIdMatch[0].toUpperCase() : null;
    const amountMatch = message.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i) || message.match(/ብር\s?(\d+(?:\.\d+)?)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
    const playerPhoneMatch = message.match(/(?:\+251|0)(9\d{8}|7\d{8})/);
    let playerPhone = playerPhoneMatch ? '0' + playerPhoneMatch[1] : null;

    if (txId && amount >= 10) {
        try {
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
                    }
                }
            }
        } catch (e) { console.error("Webhook Error:", e); }
    }
    res.status(200).send("OK");
});

// --- 4. የክፍያ ማረጋገጫ (Confirm Payment) ---
app.post('/confirm-payment', async (req, res) => {
    const { phone, txId } = req.body;
    try {
        const used = await db.ref(`used_transactions/${txId}`).get();
        if (used.exists()) return res.status(400).json({ msg: "ጥቅም ላይ ውሏል!" });
        const pending = await db.ref(`pending_payments/${txId}`).get();
        if (!pending.exists()) return res.status(404).json({ msg: "መልእክቱ አልደረሰም!" });

        const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋቹ የለም!" });

        const userId = Object.keys(userSnap.val())[0];
        const amt = pending.val().amount;
        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + amt);
        await db.ref(`used_transactions/${txId}`).set({ userId, amount: amt, date: new Date().toLocaleString() });
        res.status(200).json({ msg: "ተሳክቷል!" });
    } catch (e) { res.status(500).json({ msg: "Error" }); }
});

// --- 5. የዊዝድሮው ጥያቄ (Withdraw Request) ---
app.post('/request-withdraw', async (req, res) => {
    const { userId, amount, phone } = req.body;
    try {
        const userSnap = await db.ref(`users/${userId}`).get();
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋቹ የለም!" });
        const currentBal = userSnap.val().bal || 0;
        if (parseFloat(amount) > currentBal) return res.status(400).json({ msg: "በቂ ሂሳብ የለዎትም!" });

        const reqId = Date.now();
        await db.ref(`requests/${reqId}`).set({
            uid: userId, name: userSnap.val().first_name, type: 'WIT', amt: parseFloat(amount), info: phone, status: 'Pending'
        });
        res.status(200).json({ msg: "ጥያቄው ተልኳል!" });
    } catch (e) { res.status(500).send("Error"); }
});

// --- 6. የጨዋታው ሎጂክ (Game Control) ---
let drawInt = null;
let timeInt = null;

// አሸናፊ ሲኖር 80/20 ክፍያና ሪሴት
db.ref('game/winner').on('value', async (snap) => {
    const win = snap.val();
    if (win && !win.processed) {
        if (drawInt) clearInterval(drawInt);
        const bet = (await db.ref('game/currentBetPrice').get()).val() || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        const pool = playersCount * bet;

        try {
            await db.ref(`users/${win.id}/bal`).transaction(c => (c || 0) + (pool * 0.8));
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + (pool * 0.2));
            await db.ref('game/winner/processed').set(true);
        } catch (e) { console.error("Payout error:", e); }

        setTimeout(() => resetFullGame(), 3000); 
    }
});

// የታይመር መቆጣጠሪያ
db.ref('game/status').on('value', snap => {
    if (snap.val() === 'waiting' && !timeInt) {
        startTimer(30);
    }
});

function startTimer(sec) {
    if (timeInt) clearInterval(timeInt);
    db.ref('game/isTimerRunning').set(true);
    timeInt = setInterval(async () => {
        sec--;
        // ለተጫዋቾች እንዲታይ በየሰከንዱ ይጽፋል (Stack እንዳያደርግ በጥንቃቄ)
        await db.ref('game/timer').set(sec);
        
        if (sec <= 0) {
            clearInterval(timeInt);
            timeInt = null;
            await db.ref('game').update({ status: 'active', isTimerRunning: false, timer: 0 });
            startDrawingNumbers(); // ታይመሩ ሲያልቅ ቁጥር ማውጣት ይጀምራል
        }
    }, 1000);
}

function startDrawingNumbers() {
    let drawn = [];
    if (drawInt) clearInterval(drawInt);
    drawInt = setInterval(async () => {
        const gSnap = await db.ref('game').get();
        const g = gSnap.val();
        if (!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(drawInt);
            drawInt = null;
            return;
        }
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while (drawn.includes(n));
        drawn.push(n);
        await db.ref('game/drawn').set(drawn);
    }, 2500); 
}

async function resetFullGame() {
    if (drawInt) clearInterval(drawInt);
    if (timeInt) clearInterval(timeInt);
    drawInt = null;
    timeInt = null;
    await db.ref('reserved_boards').remove();
    await db.ref('game').set({
        drawn: [], status: 'idle', winner: null, timer: -1, currentBetPrice: 0, isTimerRunning: false
    });
}

// --- 7. ሰርቨሩን ማስነሻ ---
app.get('/', (req, res) => res.send("Dagi Bingo Stable Server is Running! 🟢"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
