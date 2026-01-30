const admin = require('firebase-admin');
const http = require('http');
const express = require('express'); 
const app = express(); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. የFirebase ቅንብር (ቅድሚያ መሆን ያለበት) ---
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

    // Transaction ID መፈለጊያ (10-12 ፊደልና ቁጥር)
    const txIdMatch = message.match(/[A-Z0-9]{10,12}/i); 
    const txId = txIdMatch ? txIdMatch[0].toUpperCase() : null;

    // የብር መጠን መፈለጊያ (ETB ወይም ብር የሚለውን ጨምሮ)
    const amountMatch = message.match(/(\d+(?:\.\d+)?)\s?(?:ETB|ብር)/i) || message.match(/ብር\s?(\d+(?:\.\d+)?)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

    // የላኪው ስልክ መፈለጊያ (09/07 ወይም +251)
    const playerPhoneMatch = message.match(/(?:\+251|0)(9\d{8}|7\d{8})/);
    let playerPhone = null;
    if (playerPhoneMatch) {
        playerPhone = '0' + playerPhoneMatch[1]; 
    }

    if (txId && amount >= MIN_DEPOSIT) {
        try {
            // የደረሰውን ግብይት በPending መመዝገብ
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
                        // የባላንስ ትራንዛክሽን
                        await db.ref(`users/${userId}/bal`).transaction(c => (c || 0) + amount);
                        // ግብይቱን ጥቅም ላይ ውሏል ብሎ መመዝገብ
                        await db.ref(`used_transactions/${txId}`).set({ 
                            userId, amount, date: new Date().toLocaleString() 
                        });
                        console.log(`በተሳካ ሁኔታ ${amount} ብር ለ ${playerPhone} ተጨምሯል`);
                    }
                }
            }
        } catch (e) { console.error("Webhook Error:", e); }
    } else if (amount > 0 && amount < MIN_DEPOSIT) {
        console.log(`ክፍያ ውድቅ ሆኗል፡ ${amount} ብር ከትንሹ ገደብ (${MIN_DEPOSIT}) በታች ነው።`);
    }
    res.status(200).send("OK");
});

// --- 3. የክፍያ ማረጋገጫ (Confirm Payment Endpoint) ---
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

// --- 4. የዊዝድሮው ጥያቄ ማስተናገጃ ---
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

// --- 5. የጨዋታው ሎጂክ (Game Logic) ---
let drawingInterval = null; 
let timerInterval = null;
let resetTimeout = null;

// ሰርቨሩ ሲነሳ ጨዋታ ካለ መቀጠል
async function checkServerRecovery() {
    const gameSnap = await db.ref('game').get();
    const gameData = gameSnap.val();
    if(gameData && gameData.status === 'active' && !gameData.winner) {
        startDrawingNumbers(gameData.drawn || []);
    }
}
checkServerRecovery();

// ተጫዋች በማይኖርበት ጊዜ ጌሙን ሪሴት ማድረግ
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
                console.log("Game reset due to inactivity.");
            }
        }, 3000); 
    } else {
        if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    }
});

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
        } catch (e) { console.error("Payment Error:", e); }

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

// ሰርቨር ማስነሻ
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bingo Server is running on port ${PORT}...`);
});
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

// --- 2. የቴሌብር Webhook & Confirm (እንደነበረው ይቀጥላል...) ---
// (ኮዱ እንዳይረዝም ዋናውን ሎጂክ ብቻ አሳይሃለሁ)

// --- 3. የጨዋታው ሎጂክ (Auto Reset & Drawing) ---
let drawingInterval = null; 
let timerInterval = null;
let resetTimeout = null;

// 🟢 ሀ. ሰው ሲጠፋ በ 3 ሰከንድ ሪሴት ማድረግ
db.ref('online_players').on('value', (snapshot) => {
    const playerCount = snapshot.numChildren();
    if (playerCount === 0) {
        if (resetTimeout) clearTimeout(resetTimeout);
        resetTimeout = setTimeout(async () => {
            const gameSnap = await db.ref('game').get();
            const gameData = gameSnap.val();
            if (gameData && gameData.status !== 'idle') {
                await resetFullGame("Inactivity Reset");
            }
        }, 3000); // ወደ 3 ሰከንድ ዝቅ ተደርጓል
    } else {
        if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    }
});

// 🟡 ለ. አሸናፊ ሲኖር ክፍያ ከፍሎ በ 3 ሰከንድ ሪሴት ማድረግ
db.ref('game/winner').on('value', async (snap) => {
    const winner = snap.val();
    if (winner && !winner.processed) {
        // 1. የቁጥሮች መውጣትን ወዲያው ማቆም
        if (drawingInterval) { clearInterval(drawingInterval); drawingInterval = null; }

        console.log("አሸናፊ ተገኝቷል፡ " + winner.name);

        // 2. የክፍያ ሎጂክ
        const betPrice = (await db.ref('game/currentBetPrice').get()).val() || 0;
        const boardsSnap = await db.ref('reserved_boards').get();
        const playersCount = boardsSnap.numChildren();
        
        const totalPool = playersCount * betPrice;
        const winnerPay = totalPool * 0.8;
        const adminPay = totalPool * 0.2;

        try {
            // የአሸናፊው ክፍያ
            await db.ref(`users/${winner.id}/bal`).transaction(c => (c || 0) + winnerPay);
            // የዳኛው (Admin) ኮሚሽን
            await db.ref(`users/${ADMIN_ID}/bal`).transaction(c => (c || 0) + adminPay);
            
            // ሂሳቡ ተከፍሏል የሚል ምልክት
            await db.ref('game/winner/processed').set(true);
            console.log(`ክፍያ ተፈጽሟል፡ አሸናፊ ${winnerPay}, ዳኛ ${adminPay}`);
        } catch (e) { console.error("Payment Error:", e); }

        // 3. በ 3 ሰከንድ ውስጥ ጌሙን ማጽዳት
        setTimeout(async () => {
            await resetFullGame("Post-Win Reset");
        }, 3000); 
    }
});

// 🔴 ሐ. አጠቃላይ ሪሴት የሚያደርግ ፈንክሽን
async function resetFullGame(reason) {
    console.log(`Reset Triggered: ${reason}`);
    await db.ref('reserved_boards').remove();
    await db.ref('game').set({
        drawn: [],
        status: 'idle',
        winner: null,
        timer: -1,
        currentBetPrice: 0,
        isTimerRunning: false,
        isResetting: false
    });
}

// 🔵 መ. የታይመር ሎጂክ
function runTimer() {
    if (timerInterval) clearInterval(timerInterval);
    db.ref('game/isTimerRunning').set(true);
    let sec = 30;
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

// ⚪️ ሠ. የቁጥሮች መውጫ ሎጂክ
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
        await db.ref('game/drawn').set(drawn);
    }, 2000);
}

// ጌሙ በድንገት ቢቋረጥ ሰርቨሩ ሲነሳ ቼክ እንዲያደርግ
db.ref('game/status').once('value', snap => {
    if(snap.val() === 'waiting') runTimer();
    if(snap.val() === 'active') startDrawingNumbers([]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bingo Server Live on ${PORT}`));
