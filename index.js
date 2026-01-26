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

// የጨዋታ ተለዋዋጮች
let drawingInterval = null; 
let timerInterval = null;
let resetTimeout = null;

// --- 3. ሰርቨሩ እንዳይተኛ (Keep-Awake በየ 3 ሰከንዱ) ---
setInterval(() => {
  const url = `http://localhost:${process.env.PORT || 3000}`;
  http.get(url, (res) => {}).on('error', (e) => {});
}, 3000); 

// --- 4. Online Players & Auto-Reset Logic (FIXED) ---
app.post('/user-online', async (req, res) => {
    const { userId, userName } = req.body;
    if (!userId) return res.sendStatus(400);
    const userRef = db.ref(`online_players/${userId}`);
    await userRef.set({ name: userName, lastSeen: Date.now() });
    userRef.onDisconnect().remove(); 
    res.status(200).send("Online");
});

// ጨዋታውን ሙሉ በሙሉ የሚያጸዳ ተግባር
async function forceResetGame() {
    if (drawingInterval) clearInterval(drawingInterval);
    if (timerInterval) clearInterval(timerInterval);
    drawingInterval = null;
    timerInterval = null;
    
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
    console.log("Game reset successfully.");
}

// ሰው ከሌለ በ 2 ሰከንድ ሪሴት እንዲያደርግ
db.ref('online_players').on('value', (snapshot) => {
    if (!snapshot.exists() || snapshot.numChildren() === 0) {
        if (!resetTimeout) {
            resetTimeout = setTimeout(async () => {
                const gSnap = await db.ref('game').get();
                if (gSnap.val() && gSnap.val().status !== 'idle') {
                    await forceResetGame();
                }
                resetTimeout = null;
            }, 2000); // 2 ሰከንድ ሪሴት
        }
    } else {
        if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    }
});

// --- 5. የካርቴላ መግዣ (Buy Board) ---
app.post('/buy-board', async (req, res) => {
    const { userId, boardId, betAmount } = req.body;
    try {
        const userRef = db.ref(`users/${userId}`);
        const userSnap = await userRef.get();
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋች የለም" });

        await userRef.child('bal').transaction(c => (c || 0) - betAmount);
        await db.ref(`reserved_boards/${boardId}`).set({ userId, betAmount });
        
        const gameRef = db.ref('game');
        const gSnap = await gameRef.get();
        if(gSnap.val().status === 'idle') {
            await gameRef.update({ status: 'waiting', timer: 30, currentBetPrice: betAmount });
            runTimer();
        }
        res.status(200).json({ msg: "Success" });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// --- 6. ቢንጎ ሲባል ወዲያው እንዲቆም (Claim Bingo) ---
app.post('/claim-bingo', async (req, res) => {
    const { userId, userName, betAmount } = req.body;
    try {
        // 1. ወዲያውኑ ሰርቨሩ ላይ ያለውን መጥሪያ ያቆማል
        if (drawingInterval) { clearInterval(drawingInterval); drawingInterval = null; }
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

        const gameSnap = await db.ref('game').get();
        if (gameSnap.val().winner) return res.status(400).json({ msg: "አሸናፊ ተገኝቷል" });

        // 2. አሸናፊውን ይመዘግባል
        await db.ref('game/winner').set({ id: userId, name: userName, bet: betAmount });
        await db.ref('game/status').set('finished');

        // 3. ክፍያ (80% ለአሸናፊ፣ 20% ለአድሚን)
        const boardsSnap = await db.ref('reserved_boards').get();
        const totalPool = boardsSnap.numChildren() * betAmount;
        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + (totalPool * 0.8));
        await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + (totalPool * 0.2));

        // 4. በ 2 ሰከንድ ጌሙን ሪሴት ያደርጋል
        setTimeout(() => forceResetGame(), 2000);

        res.status(200).json({ msg: "Bingo Confirmed!" });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// --- 7. ቁጥር መጥራት (Drawing Numbers Logic) ---
function startDrawingNumbers() {
    let drawn = [];
    if (drawingInterval) clearInterval(drawingInterval);
    drawingInterval = setInterval(async () => {
        const gameSnap = await db.ref('game').get();
        const g = gameSnap.val();
        
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(drawingInterval);
            drawingInterval = null;
            return;
        }
        
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        await db.ref('game/drawn').set(drawn);
    }, 2000); // በየ 2 ሰከንዱ ቁጥር ይጠራል
}

// --- 8. ታይመር ---
function runTimer() {
    if (timerInterval) clearInterval(timerInterval);
    let sec = 30;
    timerInterval = setInterval(async () => {
        sec--;
        await db.ref('game/timer').set(sec);
        if(sec <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            await db.ref('game').update({ status: 'active' });
            startDrawingNumbers();
        }
    }, 1000);
}

// --- 9. የክፍያ እና ዊዝድሮው ሎጂክ ---
app.post('/sms-webhook', async (req, res) => {
    const message = req.body.text || "";
    const txIdMatch = message.match(/[A-Z0-9]{10,12}/i);
    const amountMatch = message.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i);
    if (txIdMatch && amountMatch) {
        const txId = txIdMatch[0].toUpperCase();
        const amount = parseFloat(amountMatch[1]);
        await db.ref(`pending_payments/${txId}`).set({ amount, status: "received", timestamp: Date.now() });
    }
    res.status(200).send("OK");
});

app.post('/confirm-payment', async (req, res) => {
    const { userId, txId } = req.body;
    try {
        const used = await db.ref(`used_transactions/${txId}`).get();
        if (used.exists()) return res.status(400).json({ msg: "ጥቅም ላይ ውሏል!" });
        const pending = await db.ref(`pending_payments/${txId}`).get();
        if (!pending.exists()) return res.status(404).json({ msg: "መልእክቱ አልደረሰም" });
        
        const amount = pending.val().amount;
        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + amount);
        await db.ref(`used_transactions/${txId}`).set({ userId, amount, date: new Date().toISOString() });
        res.status(200).json({ msg: "ተጨምሯል" });
    } catch (e) { res.status(500).send("Error"); }
});

app.post('/request-withdraw', async (req, res) => {
    const { userId, amount, phone } = req.body;
    try {
        const userSnap = await db.ref(`users/${userId}`).get();
        const currentBal = userSnap.val().bal || 0;
        if (amount > currentBal || amount < MIN_WITHDRAW) return res.status(400).send("ስህተት");
        const reqId = Date.now();
        await db.ref(`requests/${reqId}`).set({
            uid: userId, name: userSnap.val().first_name, type: 'WIT', amt: amount, info: phone, status: 'Pending'
        });
        res.status(200).send("ተልኳል");
    } catch (e) { res.status(500).send("Error"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server fully live on port ${PORT}`));
