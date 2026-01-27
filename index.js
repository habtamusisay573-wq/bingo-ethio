const admin = require('firebase-admin');
const http = require('http');
const express = require('express'); 
const https = require('https'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. የFirebase ቅንብር (አንተ በላክኸው መሰረት) ---
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

// --- 2. ሰርቨሩ እንዳይተኛ (Self-Ping) ---
setInterval(() => {
    const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}.onrender.com`;
    https.get(url, (res) => {
        console.log("ሰርቨሩ እንዳይተኛ ተቀስቅሷል ✅ Status:", res.statusCode);
    }).on('error', (e) => {
        console.error("Ping Error:", e.message);
    });
}, 5 * 60 * 1000); // በየ 5 ደቂቃው

// --- 3. የቴሌብር SMS መቀበያ Webhook (አንድም ሳይቀንስ) ---
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
    if (playerPhoneMatch) {
        playerPhone = '0' + playerPhoneMatch[1]; 
    }

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
    } else if (amount > 0 && amount < MIN_DEPOSIT) {
        console.log(`ክፍያ ውድቅ ሆኗል፡ ${amount} ብር ከትንሹ ገደብ በታች ነው።`);
    }
    res.status(200).send("OK");
});

// --- 4. የክፍያ ማረጋገጫ Endpoint ---
app.post('/confirm-payment', async (req, res) => {
    const { phone, txId } = req.body;
    try {
        const used = await db.ref(`used_transactions/${txId}`).get();
        if (used.exists()) return res.status(400).json({ msg: "ይህ ቁጥር አስቀድሞ ጥቅም ላይ ውሏል!" });

        const pending = await db.ref(`pending_payments/${txId}`).get();
        if (!pending.exists()) return res.status(404).json({ msg: "የቴሌብር መልእክቱ ገና አልደረሰም፤ እባክዎ ጥቂት ሰከንድ ይጠብቁ።" });

        const actualAmount = pending.val().amount;
        if (actualAmount < MIN_DEPOSIT) return res.status(400).json({ msg: `ትንሹ ማስገቢያ ${MIN_DEPOSIT} ብር ነው።` });

        const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋቹ አልተገኘም!" });

        const userId = Object.keys(userSnap.val())[0];
        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + actualAmount);
        await db.ref(`used_transactions/${txId}`).set({ userId, amount: actualAmount, date: new Date().toLocaleString() });

        res.status(200).json({ msg: `በተሳካ ሁኔታ ${actualAmount} ብር ተጨምሯል!` });
    } catch (e) { res.status(500).json({ msg: "Server Error" }); }
});

// --- 5. የዊዝድሮው ጥያቄ ማስተናገጃ ---
app.post('/request-withdraw', async (req, res) => {
    const { userId, amount, phone } = req.body;
    const withdrawAmt = parseFloat(amount);
    try {
        const userSnap = await db.ref(`users/${userId}`).get();
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋቹ አልተገኘም!" });

        const currentBal = userSnap.val().bal || 0;
        if (withdrawAmt > currentBal) return res.status(400).json({ msg: `በቂ ሂሳብ የለዎትም! ያለዎት መጠን ${currentBal} ብር ነው።` });
        if (withdrawAmt < MIN_WITHDRAW) return res.status(400).json({ msg: `ትንሹ ማውጫ ${MIN_WITHDRAW} ብር ነው` });
        if (withdrawAmt > MAX_WITHDRAW) return res.status(400).json({ msg: `ከፍተኛው ማውጫ ${MAX_WITHDRAW} ብር ነው።` });

        const reqId = Date.now();
        await db.ref(`requests/${reqId}`).set({
            uid: userId,
            name: userSnap.val().first_name,
            type: 'WIT',
            amt: withdrawAmt,
            info: phone,
            status: 'Pending'
        });
        res.status(200).json({ msg: "የማውጫ ጥያቄዎ ተልኳል፤ ዳኛው እስኪያረጋግጥ ይጠብቁ።" });
    } catch (e) { res.status(500).send("Server Error"); }
});

// --- 6. የጨዋታው ሎጂክ (Game Logic) ---
let drawingInterval = null; 
let timerInterval = null;
let resetTimeout = null;

async function checkServerRecovery() {
    const gameSnap = await db.ref('game').get();
    const gameData = gameSnap.val();
    if(gameData && gameData.status === 'active' && !gameData.winner) {
        startDrawingNumbers(gameData.drawn || []);
    } else if (gameData && gameData.status === 'waiting') {
        runTimer(gameData.timer || 30);
    }
}
checkServerRecovery();

// 🟢 አሸናፊ ሲኖር በ 3 ሰከንድ ሪሴት
db.ref('game/winner').on('value', async (snap) => {
    const win = snap.val();
    if(win && !win.processed) {
        if (drawingInterval) clearInterval(drawingInterval);

        const betPrice = (await db.ref('game/currentBetPrice').get()).val() || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        
        const totalPool = playersCount * betPrice;
        const winnerPay = totalPool * 0.8;
        const adminPay = totalPool * 0.2;

        try {
            await db.ref(`users/${win.id}/bal`).transaction(c => (c || 0) + winnerPay);
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminPay);
            await db.ref('game/winner/processed').set(true);
            console.log(`ክፍያ ተፈጽሟል፡ Winner: ${winnerPay}, Admin: ${adminPay}`);
        } catch (e) { console.error("Payout Error:", e); }

        setTimeout(() => { resetFullGame("Winner Found"); }, 3000);
    }
});

// 🟡 ሰው ከሌለ በ 3 ሰከንድ ሪሴት
db.ref('online_players').on('value', (snapshot) => {
    const playerCount = snapshot.numChildren();
    if (playerCount === 0) {
        if (resetTimeout) clearTimeout(resetTimeout);
        resetTimeout = setTimeout(async () => {
            const countCheck = (await db.ref('online_players').get()).numChildren();
            if (countCheck === 0) resetFullGame("No Players");
        }, 3000); 
    } else {
        if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    }
});

async function resetFullGame(reason) {
    console.log(`ሪሴት ተደርጓል፡ ${reason}`);
    if (drawingInterval) clearInterval(drawingInterval);
    if (timerInterval) clearInterval(timerInterval);
    await db.ref('reserved_boards').remove();
    await db.ref('game').set({
        drawn: [], status: 'idle', winner: null, timer: -1, currentBetPrice: 0, isTimerRunning: false, isResetting: false
    });
}

db.ref('game/status').on('value', snap => {
    if(snap.val() === 'waiting' && !timerInterval) {
        runTimer(30);
    }
});

function runTimer(sec) {
    if (timerInterval) clearInterval(timerInterval);
    db.ref('game/isTimerRunning').set(true);
    timerInterval = setInterval(async () => {
        sec--;
        await db.ref('game/timer').set(sec);
        if(sec <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            await db.ref('game').update({ status: 'active', isTimerRunning: false });
            startDrawingNumbers([]);
        }
    }, 1000);
}

function startDrawingNumbers(existing) {
    let drawn = existing;
    if (drawingInterval) clearInterval(drawingInterval);
    drawingInterval = setInterval(async () => {
        const g = (await db.ref('game').get()).val();
        if(!g || g.winner || g.status !== 'active' || drawn.length >= 75) {
            clearInterval(drawingInterval);
            return;
        }
        let n;
        do { n = Math.floor(Math.random() * 75) + 1; } while(drawn.includes(n));
        drawn.push(n);
        await db.ref('game/drawn').set(drawn);
    }, 2000);
}

app.get('/', (req, res) => res.send("Bingo Server is Running... 🟢"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
