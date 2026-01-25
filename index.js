const admin = require('firebase-admin');
const http = require('http');
const express = require('express'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- የገደብ መጠኖች (Limits) ---
const MIN_DEPOSIT = 10;    // ትንሹ ማስገቢያ 10 ብር
const MIN_WITHDRAW = 50;   // ትንሹ ማውጫ 50 ብር (አዲስ)
const MAX_WITHDRAW = 5000; // ከፍተኛው ማውጫ 5000 ብር

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
                    amount: amount,
                    sender_phone: playerPhone,
                    status: "received",
                    timestamp: Date.now()
                });

                if (playerPhone) {
                    const userSnap = await db.ref('users').orderByChild('phone').equalTo(playerPhone).once('value');
                    if (userSnap.exists()) {
                        const userId = Object.keys(userSnap.val())[0];
                        const txCheck = await db.ref(`used_transactions/${txId}`).get();
                        
                        if (!txCheck.exists()) {
                            await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + amount);
                            await db.ref(`used_transactions/${txId}`).set({ userId, amount, date: new Date().toLocaleString() });
                            console.log(`Auto-added: ${amount} to ${playerPhone}`);
                        }
                    }
                }
            } catch (e) { console.error("SMS Error:", e); }
        } else if (amount > 0 && amount < MIN_DEPOSIT) {
            console.log(`ክፍያ ውድቅ ሆኗል፡ ${amount} ብር ከትንሹ ገደብ (${MIN_DEPOSIT}) በታች ነው።`);
        }
    }
    res.status(200).json({ status: "success" });
});

// --- 2. ተጫዋቹ ከአፑ ላይ "Confirm" ሲል የሚመጣ ጥሪ ---
app.post('/confirm-payment', async (req, res) => {
    const { phone, txId } = req.body;

    try {
        const used = await db.ref(`used_transactions/${txId}`).get();
        if (used.exists()) return res.status(400).json({ msg: "ይህ ቁጥር አስቀድሞ ጥቅም ላይ ውሏል!" });

        const pending = await db.ref(`pending_payments/${txId}`).get();
        if (!pending.exists()) return res.status(404).json({ msg: "የቴሌብር መልእክቱ ገና አልደረሰም፤ እባክዎ ጥቂት ሰከንድ ይጠብቁ።" });

        const actualAmount = pending.val().amount;

        if (actualAmount < MIN_DEPOSIT) {
            return res.status(400).json({ msg: `ትንሹ ማስገቢያ ${MIN_DEPOSIT} ብር ነው። የላኩት ${actualAmount} ብር ስለሆነ አይቻልም።` });
        }

        const userSnap = await db.ref('users').orderByChild('phone').equalTo(phone).once('value');
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋቹ አልተገኘም!" });

        const userId = Object.keys(userSnap.val())[0];
        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + actualAmount);
        await db.ref(`used_transactions/${txId}`).set({ userId, amount: actualAmount, date: new Date().toLocaleString() });

        res.status(200).json({ msg: `በተሳካ ሁኔታ ${actualAmount} ብር ተጨምሯል!` });
    } catch (e) { res.status(500).json({ msg: "Server Error" }); }
});

// --- 3. የዊዝድሮው ገደብ እና የባላንስ ቼክ ---
app.post('/request-withdraw', async (req, res) => {
    const { userId, amount, phone } = req.body;
    const withdrawAmt = parseFloat(amount);

    try {
        const userSnap = await db.ref(`users/${userId}`).get();
        if (!userSnap.exists()) return res.status(404).json({ msg: "ተጫዋቹ አልተገኘም!" });

        const currentBal = userSnap.val().bal || 0;

        // ሂሳብ ቼክ (ከባላንስ በላይ)
        if (withdrawAmt > currentBal) {
            return res.status(400).json({ msg: `በቂ ሂሳብ የለዎትም! ያለዎት መጠን ${currentBal} ብር ነው።` });
        }

        // ሚኒመም ቼክ (50 ብር)
        if (withdrawAmt < MIN_WITHDRAW) {
            return res.status(400).json({ msg: `ትንሹ የማውጫ መጠን ${MIN_WITHDRAW} ብር ነው።` });
        }

        // ማክሲመም ቼክ
        if (withdrawAmt > MAX_WITHDRAW) {
            return res.status(400).json({ msg: `ከፍተኛው ማውጫ ${MAX_WITHDRAW} ብር ነው።` });
        }

        // ጥያቄውን ለዳኛው መመዝገብ
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

    } catch (e) { res.status(500).json({ msg: "Server Error" }); }
});

const server = app.listen(process.env.PORT || 3000, () => {
    console.log('Bingo Server Active with Balance Check...');
});

// --- ያንተ የቆየው የFirebase ኮድ ከዚህ በታች ይቀጥላል ---

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

let resetTimeout = null;

db.ref('online_players').on('value', (snapshot) => {
    const playerCount = snapshot.numChildren();
    
    if (playerCount === 0) {
        if (resetTimeout) clearTimeout(resetTimeout);
        
        resetTimeout = setTimeout(async () => {
            const gameSnap = await db.ref('game').get();
            const gameData = gameSnap.val();
            
            if (gameData && gameData.status !== 'idle') {
                await db.ref('reserved_boards').remove();
                await db.ref('game').update({
                    drawn: [], status: 'idle', winner: null, isResetting: false, timer: -1, currentBetPrice: 0, isTimerRunning: false
                });
                console.log("Resetting game...");
            }
        }, 3000); 
    } else {
        if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    }
});

let drawingInterval = null; 
let timerInterval = null;

async function checkServerRecovery() {
    const gameSnap = await db.ref('game').get();
    const gameData = gameSnap.val();
    if(gameData && gameData.status === 'active' && !gameData.winner) {
        startDrawingNumbers(gameData.drawn || []);
    }
}
checkServerRecovery();

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
        const winnerPay = totalPool * 0.8;
        const adminPay = totalPool * 0.2;

        try {
            await db.ref(`users/${winnerId}/bal`).transaction(curr => (curr || 0) + winnerPay);
            await db.ref(`history/${winnerId}`).push({
                type: "የቢንጎ ድል 🏆", amt: winnerPay, info: "80% የአሸናፊ ድርሻ", date: new Date().toLocaleString()
            });
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(curr => (curr || 0) + adminPay);
        } catch (e) { console.error("Payment Failed", e); }

        setTimeout(() => {
            db.ref('reserved_boards').remove();
            db.ref('game').set({
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
